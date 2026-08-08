import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import {
  findSystemChrome,
  parseBrowserEngine,
  resolveBrowserRuntime,
  type BrowserEngine
} from './runtime.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export async function installChromium(): Promise<{ installed: true; executablePath: string }> {
  const cliPath = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  await execFileAsync(process.execPath, [cliPath, 'install', 'chromium'], { maxBuffer: 10 * 1024 * 1024 });
  const executablePath = chromium.executablePath();
  await access(executablePath);
  return { installed: true, executablePath };
}

interface BrowserCheck {
  available: boolean;
  executablePath?: string;
  launchVerified: boolean;
  error?: string;
}

export async function browserDoctor(engine: BrowserEngine = 'auto'): Promise<{
  ok: boolean;
  node: string;
  platform: string;
  arch: string;
  requestedEngine: BrowserEngine;
  selectedEngine: Exclude<BrowserEngine, 'auto'>;
  selectedExecutable: string;
  systemChrome: BrowserCheck;
  playwrightChromium: BrowserCheck;
  chromiumExecutable: string;
  profileDirectory: string;
  launchVerified: boolean;
}> {
  await ensureAppPaths();
  const requestedEngine = parseBrowserEngine(engine);
  const chromiumExecutable = chromium.executablePath();
  const systemChromePath = await findSystemChrome();
  const chromiumInstalled = await access(chromiumExecutable).then(() => true).catch(() => false);
  const [systemChrome, playwrightChromium] = await Promise.all([
    checkBrowser(systemChromePath),
    checkBrowser(chromiumInstalled ? chromiumExecutable : undefined)
  ]);
  const selected = await resolveBrowserRuntime(requestedEngine);
  const selectedCheck = selected.engine === 'chrome' ? systemChrome : playwrightChromium;
  if (!selectedCheck.launchVerified) {
    throw new JlcError('BROWSER_UNAVAILABLE', `The selected ${selected.engine} executable could not launch.`, {
      retryable: true,
      details: { requestedEngine, selectedEngine: selected.engine, systemChrome, playwrightChromium }
    });
  }
  return {
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    requestedEngine,
    selectedEngine: selected.engine,
    selectedExecutable: selected.executablePath,
    systemChrome,
    playwrightChromium,
    chromiumExecutable,
    profileDirectory: appPaths.browserProfile,
    launchVerified: true
  };
}

async function checkBrowser(executablePath: string | undefined): Promise<BrowserCheck> {
  if (!executablePath) return { available: false, launchVerified: false };
  try {
    const browser = await chromium.launch({ executablePath, headless: true });
    await browser.close();
    return { available: true, executablePath, launchVerified: true };
  } catch (error) {
    return {
      available: true,
      executablePath,
      launchVerified: false,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error)
    };
  }
}
