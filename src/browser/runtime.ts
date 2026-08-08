import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { JlcError } from '../domain/errors.js';

export type BrowserEngine = 'auto' | 'chrome' | 'chromium';

const SYSTEM_CHROME_CANDIDATES = [
  process.env.JLC_CLI_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev'
].filter((value): value is string => Boolean(value));

export interface ResolvedBrowserRuntime {
  engine: Exclude<BrowserEngine, 'auto'>;
  executablePath: string;
}

export interface BrowserRuntimeAvailability {
  systemChrome?: string;
  playwrightChromium?: string;
}

export async function findSystemChrome(): Promise<string | undefined> {
  for (const candidate of SYSTEM_CHROME_CANDIDATES) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

export async function resolveBrowserRuntime(engine: BrowserEngine = 'auto'): Promise<ResolvedBrowserRuntime> {
  const playwrightChromium = chromium.executablePath();
  return selectBrowserRuntime(engine, {
    systemChrome: await findSystemChrome(),
    playwrightChromium: await access(playwrightChromium).then(() => playwrightChromium).catch(() => undefined)
  });
}

export function selectBrowserRuntime(engine: BrowserEngine, availability: BrowserRuntimeAvailability): ResolvedBrowserRuntime {
  if ((engine === 'auto' || engine === 'chrome') && availability.systemChrome) {
    return { engine: 'chrome', executablePath: availability.systemChrome };
  }
  if (engine === 'chrome') {
    throw new JlcError('BROWSER_UNAVAILABLE', 'System Google Chrome is required for this browser mode.', { retryable: false });
  }
  if (availability.playwrightChromium) {
    return { engine: 'chromium', executablePath: availability.playwrightChromium };
  }
  throw new JlcError('BROWSER_UNAVAILABLE', 'Playwright Chromium is not installed. Run `jlc-cli browser install`.', { retryable: false });
}

export function parseBrowserEngine(value: string | undefined): BrowserEngine {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'chrome' || value === 'chromium') return value;
  throw new JlcError('INVALID_ARGUMENT', '--browser must be auto, chrome, or chromium.');
}
