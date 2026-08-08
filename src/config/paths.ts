import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import envPaths from 'env-paths';

const resolved = envPaths('jlc-cli', { suffix: '' });

export const appPaths = {
  configDir: resolved.config,
  dataDir: resolved.data,
  cacheDir: resolved.cache,
  logDir: resolved.log,
  configFile: process.env.JLC_CLI_CONFIG_FILE
    ? path.resolve(process.env.JLC_CLI_CONFIG_FILE)
    : path.join(resolved.config, 'config.json'),
  databaseFile: path.join(resolved.data, 'state.db'),
  browserProfile: path.join(resolved.data, 'browser-profile'),
  browserLock: path.join(resolved.data, 'browser.lock'),
  artifactsDir: path.join(resolved.data, 'artifacts'),
  downloadsDir: path.join(resolved.data, 'downloads'),
  approvalsDir: path.join(resolved.data, 'approvals')
};

export async function ensureAppPaths(): Promise<void> {
  for (const dir of [
    appPaths.configDir,
    appPaths.dataDir,
    appPaths.cacheDir,
    appPaths.logDir,
    appPaths.browserProfile,
    appPaths.artifactsDir,
    appPaths.downloadsDir,
    appPaths.approvalsDir
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
  }
}
