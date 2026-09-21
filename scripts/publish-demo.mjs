// Produces a reviewed, redacted poster and an accelerated cut of a live recording.
// Usage: node scripts/publish-demo.mjs /absolute/path/to/publish-spec.json
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const recording = JSON.parse(await readFile(path.join(spec.raw, 'recording.json'), 'utf8'));
const sources = await Promise.all((spec.recordings || [spec.raw]).map(async dir => ({ dir, ...JSON.parse(await readFile(path.join(dir, 'recording.json'), 'utf8')) })));
await mkdir(spec.output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const escape = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const screenshot = (await readFile(spec.screenshot || path.join(spec.raw, 'page-private.png'))).toString('base64');
const masks = (spec.masks || []).map(([x,y,w,h]) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:#dae0eb;display:flex;align-items:center;justify-content:center;color:#53627d;font:13px sans-serif">已脱敏</div>`).join('');
await page.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#edf1ff;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}.head{padding:26px 48px}h1{font-size:35px;margin:0 0 10px}.meta{font-size:19px;color:#a8bfdc}.shot{position:absolute;left:48px;top:144px;width:1600px;height:1000px;transform:scale(.80);transform-origin:top left;border:1px solid #3a4865;overflow:hidden}.aside{position:absolute;left:1420px;top:180px;writing-mode:vertical-rl;font-size:23px;letter-spacing:8px;color:#82dac0}footer{position:absolute;left:48px;bottom:24px;font-size:17px;color:#93a6c6}</style><div class="head"><h1>${escape(spec.title)}</h1><div class="meta">Codex · gpt-5.6-luna · jlc-cli + Skill　｜　${escape(spec.subtitle)}</div></div><div class="shot"><img width="1600" height="1000" src="data:image/png;base64,${screenshot}">${masks}</div><div class="aside">真实网页 · CDP 截图</div><footer>${escape(spec.footer || '点击观看实际执行过程 · 等待片段 4× 加速 · 个人信息已脱敏')}</footer>`);
await page.screenshot({ path: path.join(spec.output, spec.slug + '.png') });
await page.setViewportSize({ width: 460, height: 60 });
await page.setContent('<style>body{margin:0;background:#133f38;color:#b7ffe4;font:22px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:60px}</style>AI 执行 / 等待片段 · 4× 加速');
const badge = path.join(spec.raw, 'speed-badge.png');
await page.screenshot({ path: badge });
await browser.close();
const parts = [], labels = [];
if (sources.length > 1) parts.push(`[${sources.length+1}:v]split=${sources.length}${sources.map((_,n)=>`[badge${n}]`).join('')}`);
sources.forEach((source,n) => {
  const intro = source.introSeconds, end = intro + source.executionSeconds;
  const badgeInput = sources.length > 1 ? `badge${n}` : `${sources.length+1}:v`;
  parts.push(`[${n}:v]split=3[i${n}][r${n}][o${n}]`, `[i${n}]trim=start=0:end=${intro},setpts=PTS-STARTPTS,fps=25[a${n}]`, `[r${n}]trim=start=${intro}:end=${end},setpts=(PTS-STARTPTS)/4,fps=25[b${n}raw]`, `[b${n}raw][${badgeInput}]overlay=x=570:y=335:shortest=1[b${n}]`, `[o${n}]trim=start=${end},setpts=PTS-STARTPTS,fps=25[c${n}]`);
  labels.push(`[a${n}][b${n}][c${n}]`);
});
parts.push(`[${sources.length}:v]trim=duration=12,setpts=PTS-STARTPTS,fps=25,format=yuv420p[d]`, `${labels.join('')}[d]concat=n=${sources.length*3+1}:v=1:a=0[v]`);
const filter = parts.join(';');
const args = ['-y','-hide_banner','-loglevel','error',...sources.flatMap(s=>['-i',path.join(s.dir,'live.webm')]),'-loop','1','-i',path.join(spec.output,spec.slug+'.png'),'-loop','1','-i',badge,'-filter_complex',filter,'-map','[v]','-an','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',path.join(spec.output,spec.slug+'.mp4')];
const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
const code = await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve)});
if(code) throw new Error('ffmpeg failed: '+code);
await writeFile(path.join(spec.output,spec.slug+'.json'),JSON.stringify({ title:spec.title, model:'gpt-5.6-luna', cliVersion:'1.0.0-dev.1', executionSeconds:sources.reduce((sum,s)=>sum+s.executionSeconds,0), sessions:sources.length, playbackSpeed:4, recordedAt:recording.capturedAt, subtitle:spec.subtitle, provenance:'Live local browser recording of actual Codex CLI events, followed by a redacted CDP screenshot.', limitations:spec.limitations || [] },null,2));
console.log('Published '+spec.slug);
