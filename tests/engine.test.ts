import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { BrowserProvider, SiteAdapter, AdapterContext, Operation, BusinessResult } from '../src/contracts.js';
import { Engine } from '../src/engine.js';
import { State, CliError, digest, redact } from '../src/state.js';
import { deliverCallback, validateCallback } from '../src/callback.js';

let root:string,state:State,engine:Engine;
let calls:number,effects:number,invoke:(op:Operation,ctx:AdapterContext)=>Promise<BusinessResult>;
const binding={account:'test-account',orderId:'test-order',amount:'12.34',currency:'CNY',method:'balance'};
const provider:BrowserProvider={doctor:async()=>({available:true}),connect:async()=>({page:{} as any,endpoint:'http://127.0.0.1:9222',targetId:'test-target',save:async()=>{},disconnect:async()=>{},diagnostic:async()=>({snapshotUnavailable:'test'})})};
const adapter:SiteAdapter={run:async(op,_page,ctx)=>{calls++;return invoke(op,ctx);},reconcile:async(op,_page,ctx)=>invoke(op,ctx)};
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'jlc-engine-'));state=new State(root);await state.write('config',{version:1,browser:{engine:'chrome'},consent:{version:1,at:new Date().toISOString(),confirmedBy:'test-human'}});engine=new Engine(state,provider,adapter);calls=0;effects=0;invoke=async(op,ctx)=>{if(op==='payment.prepare')return {status:'needs_confirmation',data:{binding}};if(op==='payment.execute'){await ctx.beforeEffect('pay',binding);effects++;return {status:'succeeded',data:{paid:true}};}return {status:'succeeded',data:{authenticated:true}};};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});

describe('persisted workflow boundary',()=>{
 it('does not connect before profile authorization',async()=>{await state.write('config',{version:1,browser:{engine:'chrome'}});await expect(engine.run('auth.status',{})).rejects.toMatchObject({code:'CONSENT_REQUIRED'});expect(calls).toBe(0);});
 it('removes password and SMS credentials from durable task records',async()=>{const task=await engine.run('auth.login',{method:'password',username:'example',password:'not-for-disk',smsCode:'123456'});const disk=await readFile(state.path('tasks',task.id),'utf8');expect(disk).not.toContain('not-for-disk');expect(disk).not.toContain('123456');expect(JSON.parse(disk).input.username).toBe('example');});
 it('carries file metadata across separate parameter commands',async()=>{invoke=async(op,ctx)=>op==='pcb.upload'?{status:'succeeded',data:{upload:{sha256:'example-hash'}}}:{status:'succeeded',data:{seen:ctx.previous?.upload}};const upload=await engine.run('pcb.upload',{});const set=await engine.run('pcb.set',{params:{quantity:5}},{draft:upload.id});expect(set.targetId).toBe(upload.targetId);expect(set.data.seen).toEqual({sha256:'example-hash'});expect(set.data.upload).toEqual({sha256:'example-hash'});});
 it('requires exact human confirmation, expires and consumes the payment receipt',async()=>{const prepared=await engine.run('payment.prepare',{orderId:binding.orderId});await expect(engine.confirm(prepared.id,false,binding.orderId,'12.34')).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});await expect(engine.confirm(prepared.id,true,binding.orderId,'0.01')).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});const approval=await engine.confirm(prepared.id,true,binding.orderId,'12.34');const paid=await engine.run('payment.execute',{orderId:binding.orderId},{approvalId:approval.id});expect(paid.status).toBe('succeeded');expect(effects).toBe(1);await expect(engine.run('payment.execute',{orderId:binding.orderId},{approvalId:approval.id})).rejects.toMatchObject({code:'PAYMENT_APPROVAL_INVALID'});expect(effects).toBe(1);});
 it('blocks a changed account or amount after confirmation',async()=>{const prepared=await engine.run('payment.prepare',{});const approval=await engine.confirm(prepared.id,true,binding.orderId,'12.34');invoke=async(_op,ctx)=>{await ctx.beforeEffect('pay',{...binding,amount:'13.00'});effects++;return {status:'succeeded',data:{}};};const result=await engine.run('payment.execute',{orderId:binding.orderId},{approvalId:approval.id});expect(result.error?.code).toBe('PAYMENT_APPROVAL_INVALID');expect(effects).toBe(0);});
 it('journals before submitting and refuses replay after an ambiguous result',async()=>{invoke=async(_op,ctx)=>{await ctx.beforeEffect('submit',{file:'hash'});effects++;throw new Error('connection lost after server accepted order');};const draft=await engine.run('pcb.options',{});expect(draft.status).toBe('unknown');expect((await state.task(draft.id)).effect?.kind).toBe('submit');await expect(engine.run('pcb.submit',{},{draft:draft.id})).rejects.toMatchObject({code:'EFFECT_ALREADY_STARTED'});const reconciled=await engine.reconcile(draft.id);expect(reconciled.status).toBe('unknown');expect(effects).toBe(1);});
 it('prevents simultaneous profile writes and supports release after failures',async()=>{await state.lock(async()=>{await expect(state.lock(async()=>1)).rejects.toMatchObject({code:'PROFILE_LOCKED'});});await expect(state.lock(async()=>2)).resolves.toBe(2);});
 it('yields all profile control to a handoff lease until it is released',async()=>{invoke=async()=>({status:'handoff',data:{}});const task=await engine.run('auth.login',{});const owned=await engine.handoff(task.id,'test-agent');await expect(engine.run('auth.status',{})).rejects.toMatchObject({code:'HANDOFF_ACTIVE'});const watched=await engine.reconcile(task.id);expect(watched.next?.[0]).toContain('release');await expect(engine.release(task.id,'wrong')).rejects.toMatchObject({code:'LEASE_MISMATCH'});await engine.release(task.id,owned.lease!.id);invoke=async()=>({status:'succeeded',data:{authenticated:true}});expect((await engine.reconcile(task.id)).status).toBe('succeeded');});
 it('does not grant two handoff leases for different tasks in one profile',async()=>{
   invoke=async()=>({status:'handoff',data:{}});const a=await engine.run('auth.login',{});const b=await engine.run('auth.status',{});
   await engine.handoff(a.id,'agent-a');await expect(engine.handoff(b.id,'agent-b')).rejects.toMatchObject({code:'HANDOFF_ACTIVE'});
 });
 it('automatically continues an unstarted step only after the adapter verifies recovery',async()=>{
   let first=true;const site:SiteAdapter={run:async(_op,_page,ctx)=>{if(first){first=false;return {status:'handoff',data:{}};}await ctx.beforeEffect('submit',{account:'test',fileSha256:'hash'});effects++;return {status:'succeeded',data:{orderId:'test-order'}};},reconcile:async(_op,_page,ctx)=>{expect(ctx.effectStarted).toBe(false);return {status:'handoff',resume:true,data:{}};}};
   const recoveryEngine=new Engine(state,provider,site);const task=await recoveryEngine.run('pcb.submit',{});
   expect(task.status).toBe('handoff');const completed=await recoveryEngine.reconcile(task.id);expect(completed.status).toBe('succeeded');expect(effects).toBe(1);
   await recoveryEngine.reconcile(task.id);expect(effects).toBe(1);
 });
 it('rejects path traversal in account profiles and local IDs',async()=>{expect(()=>new State(root,'../other')).toThrow();await expect(state.task('../config')).rejects.toMatchObject({code:'INVALID_ID'});});
 it('serializes concurrent recovery of a dead process lock',async()=>{
   for(let round=0;round<12;round++){
     await writeFile(join(state.directory,'operation.lock'),JSON.stringify({pid:2147483646,nonce:`dead-owner-${round}`}));
     let active=0,maximum=0;
     await Promise.allSettled(Array.from({length:6},()=>state.lock(async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,4));active--;})));
     expect(maximum).toBe(1);
   }
 });
 it('recovers after both the operation and its recovery owner crashed',async()=>{
   const journal=join(state.directory,'lock-recovery');await mkdir(journal,{recursive:true});
   await writeFile(join(state.directory,'operation.lock'),JSON.stringify({pid:2147483646,nonce:'crashed-operation'}));
   await writeFile(join(journal,digest('crashed-operation')+'.json'),JSON.stringify({pid:2147483646,nonce:'crashed-recovery'}));
   await expect(state.lock(async()=>42)).resolves.toBe(42);
 });
 it('blocks a second payment receipt after an uncertain first payment',async()=>{
   const first=await engine.run('payment.prepare',{});const second=await engine.run('payment.prepare',{});
   const a=await engine.confirm(first.id,true,binding.orderId,'12.34');const b=await engine.confirm(second.id,true,binding.orderId,'12.34');
   invoke=async(_op,ctx)=>{await ctx.beforeEffect('pay',binding);effects++;throw new Error('response lost');};
   expect((await engine.run('payment.execute',{orderId:binding.orderId},{approvalId:a.id})).status).toBe('unknown');
   const duplicate=await engine.run('payment.execute',{orderId:binding.orderId},{approvalId:b.id});
   expect(duplicate.error?.code).toBe('EFFECT_ALREADY_STARTED');expect(effects).toBe(1);
 });
 it('blocks sibling drafts from submitting the same uploaded file twice',async()=>{
   invoke=async(op,ctx)=>{if(op==='pcb.submit'){await ctx.beforeEffect('submit',{account:'example',fileSha256:'hash'});effects++;throw new Error('response lost');}return {status:'succeeded',data:{upload:{taskId:'one-upload',sha256:'hash'}}};};
   const upload=await engine.run('pcb.upload',{});const left=await engine.run('pcb.options',{},{draft:upload.id});const right=await engine.run('pcb.options',{},{draft:upload.id});
   expect((await engine.run('pcb.submit',{},{draft:left.id})).status).toBe('unknown');
   expect((await engine.run('pcb.submit',{},{draft:right.id})).error?.code).toBe('EFFECT_ALREADY_STARTED');expect(effects).toBe(1);
 });
 it('hashes bindings deterministically and never hides a changed field',()=>{expect(digest({b:2,a:1})).toBe(digest({a:1,b:2}));expect(digest({a:1})).not.toBe(digest({a:2}));});
});

describe('callbacks are business events, not credentials',()=>{
 it('rejects insecure remote callbacks and credential-bearing URLs',()=>{expect(()=>validateCallback({url:'http://example.com/status'})).toThrow();expect(()=>validateCallback({url:'https://user:pass@example.com'})).toThrow();expect(()=>validateCallback({url:'http://127.0.0.1:1234/status'})).not.toThrow();});
 it('persists and retries the same failed event without redoing business actions',async()=>{let received:any[]=[];let headers:any[]=[];let healthy=false;const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{received.push(JSON.parse(body));headers.push(req.headers);res.writeHead(healthy?200:503);res.end();});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as any;process.env.JLC_TEST_CALLBACK_SECRET='test-only-secret';try{const task=await engine.run('auth.login',{password:'never-send-this'},{callback:{url:`http://127.0.0.1:${address.port}/callback`,secretEnv:'JLC_TEST_CALLBACK_SECRET'}});expect(task.status).toBe('succeeded');expect(task.delivery?.delivered).toBe(false);healthy=true;await deliverCallback(state,task,true);expect(task.delivery?.delivered).toBe(true);expect(received[0]).toEqual(received[1]);expect(JSON.stringify(received)).not.toContain('never-send-this');expect(headers[0]['x-jlc-signature']).toMatch(/^sha256=/);expect(calls).toBe(1);}finally{delete process.env.JLC_TEST_CALLBACK_SECRET;await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));}});
});
