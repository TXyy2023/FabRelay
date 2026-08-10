import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import { TEST_BASE_URL } from '../domain/types.js';
import { findSystemChrome } from './runtime.js';
import { acquireBrowserLock } from './session.js';

export function chromeQuitHint(): string {
  if (process.platform === 'darwin') return '在该窗口按 ⌘Q 完全退出专用 Chrome';
  if (process.platform === 'win32') return '关闭专用 Chrome 的全部窗口（例如 Alt+F4）完全退出';
  return '关闭专用 Chrome 的全部窗口（例如 Ctrl+Q）完全退出';
}

export async function runManualChromeLogin(timeoutMs = 10 * 60_000): Promise<{ browser: 'chrome'; profileDirectory: string; completed: true }> {
  await ensureAppPaths();
  const executablePath = await findSystemChrome();
  if (!executablePath) {
    throw new JlcError('BROWSER_UNAVAILABLE', 'Manual verification login requires system Google Chrome.');
  }
  const release = await acquireBrowserLock();
  const child = spawn(executablePath, [
    `--user-data-dir=${appPaths.browserProfile}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    // On Windows Chrome can stay resident in the tray after the last window closes;
    // the CLI only proceeds once this dedicated process has fully exited.
    '--disable-background-mode',
    TEST_BASE_URL
  ], { stdio: 'ignore' });
  let interrupted = false;
  let timedOut = false;
  const stop = () => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  process.once('SIGINT', stop);
  // SIGTERM is never delivered on Windows; registering it there is pointless.
  if (process.platform !== 'win32') process.once('SIGTERM', stop);
  process.stderr.write(
    `已打开 jlc-cli 专用 Google Chrome。请手动登录并完成滑块验证；成功后${chromeQuitHint()}，CLI 将用 Playwright 回读验证登录状态。\n`
  );
  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      once(child, 'error').then(([error]) => { throw error; })
    ]);
    if (interrupted) throw new JlcError('AUTH_INTERACTION_REQUIRED', 'Manual Chrome login was interrupted.');
    if (timedOut) throw new JlcError('AUTH_INTERACTION_REQUIRED', `Manual Chrome login timed out after ${timeoutMs} ms.`);
    if (code !== 0) {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      throw new JlcError('BROWSER_UNAVAILABLE', `Manual Chrome ended with ${reason}.`);
    }
    return { browser: 'chrome', profileDirectory: appPaths.browserProfile, completed: true };
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', stop);
    if (process.platform !== 'win32') process.off('SIGTERM', stop);
    await release();
  }
}
