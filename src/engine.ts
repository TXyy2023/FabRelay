import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { AdapterContext, BrowserProvider, BusinessResult, Operation, SiteAdapter } from './contracts.js';
import { CliError, State, digest, now, redact, type Task, type Approval, type CallbackSpec } from './state.js';
import { deliverCallback, queueCallback, validateCallback } from './callback.js';

export interface RunOptions {draft?: string; approvalId?:string; callback?:CallbackSpec; timeoutMs?:number;}
export class Engine {
  constructor(readonly state:State, readonly browser:BrowserProvider, readonly site:SiteAdapter) {}
  async run(operation:Operation,input:Record<string,unknown>,options:RunOptions={}):Promise<Task> {
    if(options.callback) validateCallback(options.callback);
    return this.state.lock(async()=> {
      await this.state.requireConsent();
      const oldTasks=await this.state.tasks();
      if(oldTasks.some(t=>t.lease&&t.lease.expiresAt>Date.now())) throw new CliError('HANDOFF_ACTIVE','Agent owns this profile; release the handoff lease before running commands.');
      let source=options.draft?await this.state.task(options.draft):undefined;
      if(operation==='payment.execute'&&options.approvalId){
        const approval=await this.state.read<Approval>('approvals',options.approvalId);
        if(!approval||approval.consumedAt||approval.expiresAt<Date.now()) throw new CliError('PAYMENT_APPROVAL_INVALID','Payment approval is absent, expired or consumed.');
        if(String(input.orderId)!==String(approval.binding.orderId)) throw new CliError('PAYMENT_APPROVAL_INVALID','The requested order does not match the confirmed payment.');
        source=await this.state.task(approval.taskId);
      }
      if(source?.effect) throw new CliError('EFFECT_ALREADY_STARTED','This draft already started a submit/payment; query its result before creating another.');
      if(operation==='payment.execute'&&!options.approvalId) throw new CliError('CONFIRMATION_REQUIRED','Prepare the payment, obtain human confirmation, then provide its approval ID.');
      const task:Task={id:randomUUID(),operation,status:'running',input:redact(input),data:source?{...source.data}:{},createdAt:now(),updatedAt:now(),revision:0,draft:source?.id,approvalId:options.approvalId,callback:options.callback,targetId:source?.targetId};
      await this.state.save(task);
      return this.perform(task,input,options.timeoutMs||30000,source?.data,false);
    });
  }
  private async perform(task:Task,input:Record<string,unknown>,timeoutMs:number,previous:Record<string,unknown>|undefined,reconcile:boolean):Promise<Task> {
    const config=await this.state.requireConsent(); const artifactDir=join(this.state.directory,'artifacts',task.id); await mkdir(artifactDir,{recursive:true,mode:0o700});
    let connection:Awaited<ReturnType<BrowserProvider['connect']>>|undefined;
    try {
      connection=await this.browser.connect({...config.browser,timeoutMs},join(this.state.directory,'browser'),task.targetId);
      task.targetId=connection.targetId; task.endpoint=connection.endpoint; await this.state.save(task);
      let allowEffect=!reconcile;
      const context:AdapterContext={effectStarted:!!task.effect,taskId:task.id,timeoutMs,artifactDir,input,previous,beforeEffect:async(kind,binding)=>{
        if(!allowEffect||task.effect) throw new CliError('REPLAY_REFUSED','An irreversible action may already have happened; only reconciliation is allowed.');
        const previousEffects=(await this.state.tasks()).filter(t=>t.id!==task.id&&t.effect?.kind===kind);
        const duplicate=previousEffects.find(t=>kind==='pay'
          ? t.effect!.binding.account===binding.account && t.effect!.binding.orderId===binding.orderId
          : (t.data.upload as Record<string,unknown>|undefined)?.taskId!==undefined && (t.data.upload as Record<string,unknown>).taskId===(task.data.upload as Record<string,unknown>|undefined)?.taskId);
        if(duplicate) throw new CliError('EFFECT_ALREADY_STARTED',`An action for this order/upload already started in task ${duplicate.id}; reconcile that task before any further action.`,{originalTaskId:duplicate.id});
        if(kind==='pay') await this.consumeApproval(task,binding);
        task.effect={kind,binding:redact(binding),at:now()}; await this.state.save(task);
        if(task.draft) {const draft=await this.state.task(task.draft);draft.effect=task.effect;await this.state.save(draft);}
      }};
      let result=reconcile?await this.site.reconcile(task.operation,connection.page,context):await this.site.run(task.operation,connection.page,context);
      if(reconcile && result.resume && !task.effect && ['pcb.set','pcb.submit','payment.execute'].includes(task.operation)){
        allowEffect=true;
        result=await this.site.run(task.operation,connection.page,{...context,previous:{...previous,...result.data}});
      }
      this.apply(task,result);
      await connection.save();
      if(['handoff','unknown','failed'].includes(task.status)) task.data.diagnostic=await connection.diagnostic(artifactDir).catch(()=>({available:false}));
    } catch(error) {
      task.status=task.effect?'unknown':'handoff'; task.error={code:error instanceof CliError?error.code:'BROWSER_OR_SITE_ERROR',message:redact(error instanceof Error?error.message:String(error))};
      task.next=task.effect?['Query task status; do not repeat submit or payment.']:['Inspect the same CDP target, acquire its handoff lease, resolve the issue, then release control.'];
      if(connection) task.data.diagnostic=await connection.diagnostic(artifactDir).catch(()=>({available:false}));
    } finally { await connection?.disconnect().catch(()=>{}); }
    task.revision++; task.updatedAt=now(); queueCallback(task); await this.state.save(task); await deliverCallback(this.state,task,true); return task;
  }
  private apply(task:Task,result:BusinessResult):void {task.status=result.status;task.data={...task.data,...redact(result.data)};task.error=result.error;task.next=result.next;}
  async reconcile(id:string,timeoutMs=30000):Promise<Task> {
    return this.state.lock(async()=>{
      const task=await this.state.task(id);
      if(task.status==='succeeded') {await deliverCallback(this.state,task,true); return task;}
      const leases=(await this.state.tasks()).filter(t=>t.lease&&t.lease.expiresAt>Date.now());
      if(leases.length) return {...task,next:['Waiting for Agent to release handoff control.']};
      return this.perform(task,task.input,timeoutMs,task.data,true);
    });
  }
  async confirm(id:string,humanConfirmed:boolean,expectedOrder:string,expectedAmount:string):Promise<Approval> {
    return this.state.lock(async()=>{
      const task=await this.state.task(id);
      if(task.operation!=='payment.prepare'||!['succeeded','needs_confirmation'].includes(task.status)) throw new CliError('PAYMENT_NOT_PREPARED','Prepare a specific payment first.');
      const binding=task.data.binding as Record<string,unknown> | undefined;
      if(!binding || !binding.account || binding.method!=='balance' || binding.currency!=='CNY' || !binding.orderId || !/^\d+(\.\d{1,2})?$/.test(String(binding.amount))) throw new CliError('INVALID_PAYMENT_BINDING','Website did not provide a complete account/order/amount/balance binding.');
      if(!humanConfirmed || String(binding.orderId)!==expectedOrder || money(binding.amount)!==money(expectedAmount)) throw new CliError('CONFIRMATION_REQUIRED','Human must confirm this exact order and amount.',{binding});
      const approval:Approval={id:randomUUID(),taskId:id,bindingHash:digest(binding),binding,expiresAt:Date.now()+10*60*1000,confirmedAt:now()};await this.state.write('approvals',approval,approval.id);return approval;
    });
  }
  private async consumeApproval(task:Task,binding:Record<string,unknown>):Promise<void> {
    const approval=task.approvalId?await this.state.read<Approval>('approvals',task.approvalId):undefined;
    if(!approval||approval.consumedAt||approval.expiresAt<Date.now()||approval.bindingHash!==digest(binding)) throw new CliError('PAYMENT_APPROVAL_INVALID','Confirmation is absent, expired, consumed, or no longer matches the current account/order/amount.');
    approval.consumedAt=now();await this.state.write('approvals',approval,approval.id);
  }
  async handoff(id:string,owner:string,seconds=600):Promise<Task> {
    return this.state.lock(async()=>{const task=await this.state.task(id);if((await this.state.tasks()).some(t=>t.lease&&t.lease.expiresAt>Date.now())) throw new CliError('HANDOFF_ACTIVE','This task already has an active lease.');task.lease={id:randomUUID(),owner,expiresAt:Date.now()+seconds*1000};await this.state.save(task);return task;});
  }
  async release(id:string,leaseId:string):Promise<Task> {
    return this.state.lock(async()=>{const task=await this.state.task(id);if(task.lease?.id!==leaseId) throw new CliError('LEASE_MISMATCH','Supply the lease ID returned by handoff acquire.');delete task.lease;await this.state.save(task);return task;});
  }
}
function money(value:unknown):number {const text=String(value);if(!/^\d+(\.\d{1,2})?$/.test(text)) throw new CliError('INVALID_AMOUNT','Amount must be a nonnegative decimal with at most two decimal places.');const [whole,fraction='']=text.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));}
