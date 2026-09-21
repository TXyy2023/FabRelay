import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { browserProvider, executableCandidates, sanitizeUrl, stopOwnedBrowser, validateEndpoint } from '../src/browser.js';

const readControl = vi.hoisted(() => ({ intercept: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: async (...args: Parameters<typeof original.readFile>) => {
    const data = await original.readFile(...args);
    await readControl.intercept?.(String(args[0]));
    return data;
  } };
});

const directories: string[] = [];
const chrome = process.env.JLC_TEST_BROWSER === 'chromium' ? chromium.executablePath() : process.env.JLC_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function directory() { const value = await mkdtemp(join(tmpdir(), 'jlc-browser-test-')); directories.push(value); return value; }
afterEach(async () => { readControl.intercept = undefined; for (const dir of directories.splice(0)) { await stopOwnedBrowser(dir); await rm(dir, { recursive: true, force: true }); } });

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('CDP endpoint boundaries', () => {
  it.each(['http://example.com:9222', 'ws://0.0.0.0:9222', 'http://192.168.1.1:9222', 'http://user:secret@127.0.0.1:9222', 'http://127.0.0.1:9222?token=secret', 'file:///tmp/browser', 'http://127.0.0.2:9222', 'ws://[::]:9222'])('rejects %s', value => { expect(() => validateEndpoint(value)).toThrow(); });
  it('accepts and pins literal loopback', () => { expect(validateEndpoint('http://localhost:9222/')).toBe('http://127.0.0.1:9222'); expect(validateEndpoint('ws://[::1]:9222/devtools/browser')).toBe('ws://[::1]:9222/devtools/browser'); });
  it('drops all URL credentials and query fragments from diagnostics', () => { expect(sanitizeUrl('https://alice:secret@jlc.com/orders?token=secret#access_token=x')).toBe('https://jlc.com/orders'); expect(sanitizeUrl('data:text/plain,SECRET')).toBe('data:[redacted]'); });
  it('supports explicit paths and Windows candidates without shell execution', () => { const candidates = executableCandidates('obscura', 'win32', { PATH: 'D:/bin;E:/tools', JLC_OBSCURA_EXECUTABLE: 'C:/safe/obscura.exe' }, 'C:/Users/test'); expect(candidates[0]).toBe('C:/safe/obscura.exe'); expect(candidates).toContain('D:/bin/obscura.exe'); });
  it('reports missing Obscura without silently selecting Chrome', async () => { const result = await browserProvider.doctor({ engine: 'obscura', executable: '/nonexistent/jlc-test-obscura' }); expect(result).toMatchObject({ available: false, engine: 'obscura', code: 'BROWSER_NOT_INSTALLED' }); });

  it.skipIf(process.platform === 'win32')('a delayed stale-lock observer cannot remove the replacement owner', async () => {
    const dir = await directory(); const lock = join(dir, 'browser-connect.lock'); const ownerFile = join(lock, 'owner.json');
    const oldNonce = 'a'.repeat(48);
    await mkdir(lock); await writeFile(ownerFile, JSON.stringify({ pid: 2147483647, nonce: oldNonce }));
    const oldRead = deferred(); const resumeOld = deferred(); const discoveryStarted = deferred(); const finishDiscovery = deferred();
    let intercepted = false;
    readControl.intercept = async path => { if (path === ownerFile && !intercepted) { intercepted = true; oldRead.resolve(); await resumeOld.promise; } };
    const server = createServer(async (_request, response) => { discoveryStarted.resolve(); await finishDiscovery.promise; response.end('{}'); });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const config = { engine: 'chrome' as const, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeoutMs: 5000 };
    const delayed = browserProvider.connect(config, dir).catch(error => error);
    let replacement: Promise<unknown> | undefined;
    try {
      await oldRead.promise;
      replacement = browserProvider.connect(config, dir).catch(error => error);
      await discoveryStarted.promise;
      const currentOwner = JSON.parse(await readFile(ownerFile, 'utf8'));
      expect(currentOwner.nonce).not.toBe(oldNonce);
      resumeOld.resolve();
      expect(await delayed).toMatchObject({ code: 'BROWSER_BUSY' });
      expect(JSON.parse(await readFile(ownerFile, 'utf8'))).toEqual(currentOwner);
      await expect(browserProvider.connect(config, dir)).rejects.toMatchObject({ code: 'BROWSER_BUSY' });
      expect(existsSync(join(`${lock}.recovery`, oldNonce))).toBe(true);
    } finally {
      resumeOld.resolve(); finishDiscovery.resolve(); await delayed; await replacement;
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }, 10_000);
});

describe.skipIf(!existsSync(chrome))('real CDP browser lifecycle', () => {
  it('preserves the target across CLI-process exit and rejects concurrent CDP clients', async () => {
    const dir = await directory();
    if (process.platform !== 'win32') {
      await mkdir(join(dir, 'browser-connect.lock'));
      await writeFile(join(dir, 'browser-connect.lock', 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: 'b'.repeat(48) }));
    }
    const script = `import {browserProvider} from './src/browser.ts'; const c=await browserProvider.connect({engine:'chrome',executable:process.argv[2]},process.argv[1]); await c.page.setContent('<main><h1>retained scene</h1></main>'); console.log(JSON.stringify({endpoint:c.endpoint,targetId:c.targetId})); await c.disconnect();`;
    const result = await new Promise<string>((resolveOutput, reject) => { const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, dir, chrome], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; }); child.once('error', reject); child.on('exit', code => code === 0 ? resolveOutput(output) : reject(new Error(error))); });
    const { targetId, endpoint } = JSON.parse(result);
    const c = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir, targetId);
    try {
      expect(c.endpoint).toBe(endpoint); expect(c.targetId).toBe(targetId); expect(await c.page.locator('h1').innerText()).toBe('retained scene');
      await expect(chromium.connectOverCDP(endpoint, { timeout: 2000 })).rejects.toThrow();
      const diagnostics = await c.diagnostic(join(dir, 'diagnostics'));
      expect(diagnostics.snapshot).toBeTypeOf('string');
    } finally { await c.disconnect(); }
    expect(await stopOwnedBrowser(dir)).toBe(true);
  }, 30_000);

  it('keeps cookies and localStorage private and restores them after owned browser restart', async () => {
    const dir = await directory();
    const server = createServer((_request, response) => response.end('<!doctype html><h1>storage fixture</h1>'));
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const first = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir);
      await first.page.goto(url); await first.page.evaluate(() => { localStorage.setItem('test-session', 'PRIVATE_LOCAL_VALUE'); document.cookie = 'test-cookie=PRIVATE_COOKIE_VALUE; Path=/'; });
      await first.save(); await first.disconnect(); await stopOwnedBrowser(dir);
      if (process.platform !== 'win32') { expect((await stat(join(dir, 'browser-storage.json'))).mode & 0o777).toBe(0o600); expect((await stat(dir)).mode & 0o777).toBe(0o700); }
      const second = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir);
      try {
        await second.page.goto(url);
        expect(await second.page.evaluate(() => localStorage.getItem('test-session'))).toBe('PRIVATE_LOCAL_VALUE'); expect(await second.page.evaluate(() => document.cookie)).toContain('PRIVATE_COOKIE_VALUE');
        await second.page.evaluate(() => localStorage.clear()); await second.page.reload();
        expect(await second.page.evaluate(() => localStorage.getItem('test-session'))).toBeNull();
        await second.page.goto(`${url}/?token=PRIVATE_URL_TOKEN`);
        await second.page.setContent('<input type="password" value="PRIVATE_PASSWORD"><pre>PRIVATE_COOKIE_VALUE</pre>');
        const diagnostic = await second.diagnostic(join(dir, 'diagnostics'));
        const content = await readFile(String(diagnostic.snapshot), 'utf8');
        expect(content).not.toContain('PRIVATE_');
      } finally { await second.disconnect(); }
    } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
  }, 30_000);

  it('does not replace a missing task target with a fresh page', async () => {
    const dir = await directory(); const first = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir); const target = first.targetId; await first.page.close(); await first.disconnect();
    await expect(browserProvider.connect({ engine: 'chrome', executable: chrome }, dir, target)).rejects.toMatchObject({ code: 'BROWSER_TARGET_GONE' });
  }, 20_000);

  it('disconnects from an explicit external endpoint without closing its browser', async () => {
    const dir = await directory(); const externalDir = await directory();
    const owner = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir); const endpoint = owner.endpoint; const target = owner.targetId; await owner.disconnect();
    const visitor = await browserProvider.connect({ engine: 'chrome', endpoint }, externalDir, target); await visitor.disconnect();
    expect(await stopOwnedBrowser(externalDir)).toBe(false);
    const ownerAgain = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir, target); expect(ownerAgain.targetId).toBe(target); await ownerAgain.disconnect();
  }, 20_000);

  it('rejects website WebSockets and CSRF shutdown while native CDP remains usable', async () => {
    const dir = await directory();
    const first = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir);
    const endpoint = first.endpoint; const target = first.targetId;
    await first.disconnect();
    const { token } = JSON.parse(await readFile(join(dir, 'browser-runtime.json'), 'utf8'));
    for (const origin of ['https://untrusted.example', 'http://127.0.0.1:4567', 'null', '']) {
      const responseCode = await new Promise<number>((resolveCode, reject) => {
        const socket = new WebSocket(`${endpoint.replace('http:', 'ws:')}/devtools/browser`, { headers: { Origin: origin }, handshakeTimeout: 2000 });
        socket.on('open', () => { socket.close(); reject(new Error('Website WebSocket was accepted.')); });
        socket.on('error', () => {});
        socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolveCode(response.statusCode!); });
      });
      expect(responseCode).toBe(403);
      expect((await fetch(`${endpoint}/jlc/status`, { headers: { Origin: origin } })).status).toBe(403);
      expect((await fetch(`${endpoint}/jlc/stop`, { method: 'POST', headers: { Origin: origin, 'x-jlc-instance': token } })).status).toBe(403);
    }
    const reboundStatus = await new Promise<number>((resolveStatus, reject) => {
      const probe = request(`${endpoint}/jlc/status`, { headers: { Host: 'rebound.example:1234' } }, response => { response.resume(); resolveStatus(response.statusCode!); });
      probe.once('error', reject); probe.end();
    });
    expect(reboundStatus).toBe(403);
    expect((await fetch(`${endpoint}/jlc/status`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${endpoint}/jlc/stop`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${endpoint}/jlc/stop`, { method: 'POST', headers: { 'x-jlc-instance': 'wrong-token' } })).status).toBe(403);
    expect((await fetch(`${endpoint}/jlc/stop`, { headers: { 'x-jlc-instance': token } })).status).toBe(405);
    const native = await browserProvider.connect({ engine: 'chrome', executable: chrome }, dir, target);
    expect(await native.page.evaluate(() => 6 * 7)).toBe(42);
    await native.disconnect();
    expect(await stopOwnedBrowser(dir)).toBe(true);
  }, 20_000);
});

const obscura = process.env.JLC_OBSCURA_EXECUTABLE ?? join(homedir(), 'Library', 'Caches', 'jlc-cli', 'obscura', 'obscura');
describe.skipIf(!existsSync(obscura))('real Obscura CDP compatibility', () => {
  it('retains the exact DOM and target across reconnection and persists login storage on restart', async () => {
    const dir = await directory();
    const previous = process.env.OBSCURA_ALLOW_PRIVATE_NETWORK;
    process.env.OBSCURA_ALLOW_PRIVATE_NETWORK = '1';
    const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Obscura fixture</title></head><body><h1>original</h1></body></html>'); });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = { engine: 'obscura' as const, executable: obscura, timeoutMs: 10_000 };
    let active: Awaited<ReturnType<typeof browserProvider.connect>> | undefined;
    try {
      active = await browserProvider.connect(config, dir);
      await active.page.goto(url, { waitUntil: 'domcontentloaded' });
      await active.page.evaluate(() => { document.querySelector('h1')!.textContent = 'retained scene'; localStorage.setItem('session-test', 'persisted-value'); document.cookie = 'session-test=persisted-cookie; Path=/'; });
      const target = active.targetId;
      expect(target).not.toBe('browser');
      await active.save(); await active.disconnect();
      active = await browserProvider.connect(config, dir, target);
      expect(active.targetId).toBe(target);
      expect(await active.page.locator('h1').innerText()).toBe('retained scene');
      expect(await active.page.evaluate(() => localStorage.getItem('session-test'))).toBe('persisted-value');
      await active.disconnect(); await stopOwnedBrowser(dir);
      active = await browserProvider.connect(config, dir);
      await active.page.goto(url, { waitUntil: 'domcontentloaded' });
      expect(await active.page.evaluate(() => localStorage.getItem('session-test'))).toBe('persisted-value');
      expect(await active.page.evaluate(() => document.cookie)).toContain('persisted-cookie');
      await active.page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await active.page.goto(url, { waitUntil: 'domcontentloaded' });
      expect(await active.page.evaluate(() => localStorage.getItem('session-test'))).toBeNull();
    } finally {
      await active?.disconnect().catch(() => {});
      if (previous === undefined) delete process.env.OBSCURA_ALLOW_PRIVATE_NETWORK; else process.env.OBSCURA_ALLOW_PRIVATE_NETWORK = previous;
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }, 40_000);
});
