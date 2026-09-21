// Records a live, local viewer of real Codex CLI events. Raw recordings stay private.
// Usage: node scripts/record-demo.mjs /absolute/path/to/spec.json
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
await mkdir(spec.output, { recursive: true, mode: 0o700 });
const state = { title: spec.title, prompt: '', phase: '准备输入指令', elapsed: 0, events: [] };
function redact(value) {
  let s = String(value).replace(/\/Users\/[^/\s]+/g, '~');
  for (const secret of spec.redact || []) s = s.split(secret).join('[已脱敏]');
  return s.replace(/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]')
    .replace(/(https?:\/\/[^\s"?]+)\?[^\s"]+/g, '$1?[参数已省略]');
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#edf1ff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;height:100vh;padding:42px 56px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #33405b;padding-bottom:24px}.brand{font-size:26px;font-weight:700}.tag{color:#8cdbc2;font-size:19px}h1{font-size:38px;margin:26px 0 18px}.prompt{background:#18233a;border:1px solid #394967;border-radius:14px;padding:20px 24px;font-size:23px;line-height:1.55;min-height:114px;white-space:pre-wrap}textarea{width:100%;background:transparent;color:inherit;font:inherit;border:0;resize:none;outline:none;height:105px}.row{display:flex;justify-content:space-between;margin:22px 0 12px;color:#aabbda;font-size:18px}#events{height:480px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:12px}.event{border-left:3px solid #74d3b4;background:#111b2e;padding:12px 18px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:19px;line-height:1.45}.command{color:#a9cbff;font-family:ui-monospace,monospace;font-size:17px;border-color:#628af6}.label{font-size:14px;color:#8b9bb6;margin-bottom:5px}footer{position:fixed;bottom:24px;color:#71829e;font-size:16px}#badge{color:#92e3c7}
</style><header><div class="brand">jlc-cli <span style="color:#647794">/</span> AI 实操演示</div><div class="tag">Codex · gpt-5.6-luna · CLI + Skill</div></header><h1></h1><div class="prompt"><textarea placeholder="输入自然语言指令"></textarea><div id="submitted" hidden></div></div><div class="row"><span id="phase"></span><span id="badge">实时录制 · 实际 Codex 事件流</span><span id="elapsed"></span></div><div id="events"></div><footer>嘉立创中国站 · 非官方社区项目 · 执行输出经脱敏和长度裁剪</footer><script>
async function update(){const s=await(await fetch('/state')).json();document.querySelector('h1').textContent=s.title;document.querySelector('#phase').textContent=s.phase;document.querySelector('#elapsed').textContent='已用 '+s.elapsed+' 秒';if(s.prompt){document.querySelector('textarea').hidden=true;const p=document.querySelector('#submitted');p.hidden=false;p.textContent=s.prompt}const box=document.querySelector('#events');box.replaceChildren();for(const e of s.events.slice(-5)){const d=document.createElement('div');d.className='event '+(e.kind==='命令'?'command':'');const l=document.createElement('div');l.className='label';l.textContent=e.kind;d.append(l,document.createTextNode(e.text));box.append(d)}}setInterval(update,250);update();
</script></html>`;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', req.url === '/state' ? 'application/json' : 'text/html; charset=utf-8');
  res.end(req.url === '/state' ? JSON.stringify(state) : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: spec.output, size: { width: 1600, height: 1000 } } });
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}`);
await page.locator('textarea').fill(spec.prompt);
await page.waitForTimeout(3500);
state.prompt = spec.prompt;
state.phase = 'AI 正在执行';
const started = Date.now();
const timer = setInterval(() => state.elapsed = Math.floor((Date.now() - started) / 1000), 1000);
const args = ['exec', '--ignore-user-config', '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="medium"', '-c', 'approval_policy="never"', '-s', 'danger-full-access', '--ephemeral', '--json', '-C', spec.cwd, '-o', path.join(spec.output, 'answer.md'), '-'];
await writeFile(path.join(spec.output, 'invocation.json'), JSON.stringify({ model: 'gpt-5.6-luna', args, prompt: spec.prompt, instructions: spec.instructions, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
const proc = spawn(spec.codexBin || 'codex', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...spec.env } });
proc.stdin.end(spec.prompt + '\n\n录制环境与执行约束：\n' + spec.instructions);
let pending = '', writes = Promise.resolve();
proc.stdout.on('data', chunk => {
  writes = writes.then(() => appendFile(path.join(spec.output, 'events.jsonl'), chunk, { mode: 0o600 }));
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try {
      const event = JSON.parse(line), item = event.item;
      if (!item) continue;
      if (item.type === 'agent_message' && event.type === 'item.completed') {
        state.events.push({ kind: 'Codex', text: redact(item.text).slice(-1500) });
        console.log(JSON.stringify({ type: 'message', text: redact(item.text).slice(-1600) }));
      }
      if (item.type === 'command_execution' && event.type === 'item.started') {
        state.events.push({ kind: '命令', text: redact(item.command).slice(0, 520) });
        console.log(JSON.stringify({ type: 'command', command: redact(item.command).slice(0, 520) }));
      }
      if (item.type === 'command_execution' && event.type === 'item.completed') {
        const output = redact(item.aggregated_output || '').trim();
        if (output) state.events.push({ kind: '实际输出 · exit ' + item.exit_code, text: output.length > 1000 ? output.slice(0, 450) + '\n…（长输出已裁剪）…\n' + output.slice(-400) : output });
      }
      if (item.type === 'error') console.log(JSON.stringify({ type: 'error', message: item.message }));
    } catch {}
  }
});
proc.stderr.on('data', chunk => { writes = writes.then(() => appendFile(path.join(spec.output, 'stderr.log'), chunk, { mode: 0o600 })); });
const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
clearInterval(timer); await writes;
const executionSeconds = (Date.now() - started) / 1000;
state.phase = code === 0 ? '本次 AI 执行结束 · 结果以实际输出为准' : '本次执行中断';
await page.waitForTimeout(7000);
await page.screenshot({ path: path.join(spec.output, 'agent-final.png') });
const video = page.video();
await context.close();
await video.saveAs(path.join(spec.output, 'live.webm'));
await browser.close(); server.close();
await writeFile(path.join(spec.output, 'recording.json'), JSON.stringify({ code, executionSeconds, introSeconds: 3.5, outroSeconds: 7, rawVideo: 'live.webm', capturedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ complete: true, code, executionSeconds, output: spec.output }));
process.exitCode = code || 0;
