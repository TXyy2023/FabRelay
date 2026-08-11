import { mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import { TEST_BASE_URL } from '../domain/types.js';
import { fullLoad } from './nav.js';
import { resolveBrowserRuntime, type BrowserEngine } from './runtime.js';

export interface BrowserSessionOptions {
  headed?: boolean;
  slowMo?: number;
  timeoutMs?: number;
  browser?: BrowserEngine;
}

type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

interface LockContents {
  pid: number;
  createdAt: string;
}

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireBrowserLock(): Promise<() => Promise<void>> {
  await ensureAppPaths();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(appPaths.browserLock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockContents));
      await handle.close();
      return async () => {
        const current = await readFile(appPaths.browserLock, 'utf8').then(JSON.parse).catch(() => undefined) as LockContents | undefined;
        if (current?.pid === process.pid) await unlink(appPaths.browserLock).catch(() => undefined);
      };
    } catch (error) {
      const current = await readFile(appPaths.browserLock, 'utf8').then(JSON.parse).catch(() => undefined) as LockContents | undefined;
      if (attempt === 0 && current && !(await processExists(current.pid))) {
        await unlink(appPaths.browserLock).catch(() => undefined);
        continue;
      }
      throw new JlcError('BROWSER_BUSY', 'The dedicated JLC browser profile is already in use.', {
        retryable: true,
        details: current ? { pid: current.pid, createdAt: current.createdAt } : undefined,
        cause: error
      });
    }
  }
  throw new JlcError('BROWSER_BUSY', 'The dedicated JLC browser profile is already in use.', { retryable: true });
}

export function assertTestEnvironmentUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'test.jlc.com') {
    throw new JlcError('UNSUPPORTED_CAPABILITY', `Only ${TEST_BASE_URL} is allowed. Refusing ${parsed.origin}.`);
  }
}

export class BrowserSession {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly timeoutMs: number;
  readonly engine: Exclude<BrowserEngine, 'auto'>;
  readonly networkEvents: Array<{ method: string; url: string; status?: number; failure?: string }> = [];
  private readonly releaseLock: () => Promise<void>;
  private closed = false;

  private constructor(context: BrowserContext, page: Page, timeoutMs: number, releaseLock: () => Promise<void>, engine: Exclude<BrowserEngine, 'auto'>) {
    this.context = context;
    this.page = page;
    this.timeoutMs = timeoutMs;
    this.releaseLock = releaseLock;
    this.engine = engine;
    void context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    }).catch(() => undefined);
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith(TEST_BASE_URL)) this.networkEvents.push({ method: request.method(), url: redactUrl(url) });
    });
    page.on('response', (response) => {
      const url = response.url();
      if (!url.startsWith(TEST_BASE_URL)) return;
      const existing = [...this.networkEvents].reverse().find((event) => event.url === redactUrl(url) && event.status === undefined);
      if (existing) existing.status = response.status();
    });
    page.on('requestfailed', (request) => {
      const url = request.url();
      if (!url.startsWith(TEST_BASE_URL)) return;
      this.networkEvents.push({ method: request.method(), url: redactUrl(url), failure: request.failure()?.errorText });
    });
  }

  static async launch(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const releaseLock = await acquireBrowserLock();
    const timeoutMs = options.timeoutMs ?? 60_000;
    try {
      const runtime = await resolveBrowserRuntime(options.browser);
      const context = await chromium.launchPersistentContext(
        appPaths.browserProfile,
        persistentContextOptions(runtime, options)
      );
      const page = context.pages()[0] ?? await context.newPage();
      return new BrowserSession(context, page, timeoutMs, releaseLock, runtime.engine);
    } catch (error) {
      await releaseLock();
      throw new JlcError('BROWSER_UNAVAILABLE', 'The selected browser could not be started. Run `jlc-cli browser doctor`.', {
        retryable: true,
        cause: error
      });
    }
  }

  async goto(pathOrUrl: string): Promise<void> {
    const url = new URL(pathOrUrl, TEST_BASE_URL).toString();
    assertTestEnvironmentUrl(url);
    await fullLoad(this.page, url);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context.close();
    } finally {
      await this.releaseLock();
    }
  }
}

function redactUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '<redacted>');
  return `${url.origin}${url.pathname}${url.search}`;
}

export async function withBrowserSession<T>(options: BrowserSessionOptions, run: (session: BrowserSession) => Promise<T>): Promise<T> {
  const session = await BrowserSession.launch(options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

export async function clearBrowserSession(options: Pick<BrowserSessionOptions, 'browser'> = {}): Promise<void> {
  const release = await acquireBrowserLock();
  try {
    const runtime = await resolveBrowserRuntime(options.browser);
    const context = await chromium.launchPersistentContext(
      appPaths.browserProfile,
      persistentContextOptions(runtime, { headed: false })
    );
    await context.clearCookies();
    for (const page of context.pages()) await page.goto('about:blank').catch(() => undefined);
    await context.close();
    // The JLC SSO session can survive cookie clearing via persisted storage in the
    // dedicated profile. Remove the whole profile so logout is definitive.
    await rm(appPaths.browserProfile, { recursive: true, force: true });
    await mkdir(appPaths.browserProfile, { recursive: true, mode: 0o700 });
    await writeFile(path.join(appPaths.browserProfile, '.logged-out'), new Date().toISOString(), { mode: 0o600 });
  } finally {
    await release();
  }
}

export function persistentContextOptions(
  runtime: Awaited<ReturnType<typeof resolveBrowserRuntime>>,
  options: BrowserSessionOptions
): PersistentContextOptions {
  return {
    executablePath: runtime.executablePath,
    headless: !(options.headed ?? false),
    slowMo: options.slowMo,
    acceptDownloads: true,
    // Keeps automated password login (an authorized test-account flow) from
    // being fingerprinted as a bot by the passport captcha purely on the
    // default automation blink feature.
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    // A normal system-Chrome login encrypts cookies with the OS credential store
    // (macOS Keychain, Windows DPAPI). Playwright's mock-keychain/basic-password-store
    // defaults would make that same profile appear logged out.
    ignoreDefaultArgs: runtime.engine === 'chrome'
      ? ['--use-mock-keychain', '--password-store=basic']
      : undefined
  };
}
