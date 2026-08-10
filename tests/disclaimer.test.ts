import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER_NOTICE,
  DISCLAIMER_NOTICE_SHA256,
  acceptDisclaimer,
  disclaimerStatus,
  resetDisclaimer
} from '../src/disclaimer/index.js';
import { setAgentMode, setGlobalPreference } from '../src/mode/index.js';

describe('first-run unofficial-tool warning', () => {
  it('requires acceptance by default and persists a versioned text fingerprint', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-disclaimer-'));
    const configFile = path.join(temp, 'config.json');
    expect(await disclaimerStatus(configFile)).toMatchObject({ required: true, accepted: false, version: 1 });

    await setAgentMode('auto', configFile);
    await setGlobalPreference('material=FR-4', configFile);
    const accepted = await acceptDisclaimer(configFile);
    expect(accepted).toMatchObject({ required: false, accepted: true, noticeSha256: DISCLAIMER_NOTICE_SHA256 });
    expect(accepted.acceptedAt).toMatch(/^20\d{2}-/);

    const persisted = JSON.parse(await readFile(configFile, 'utf8'));
    expect(persisted.mode).toBe('auto');
    expect(persisted.globalPreferences).toEqual({ material: 'FR-4' });
    expect(persisted.disclaimer.noticeSha256).toBe(DISCLAIMER_NOTICE_SHA256);
    if (process.platform !== 'win32') {
      expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    }

    expect(await resetDisclaimer(configFile)).toMatchObject({ required: true, accepted: false });
  });

  it('invalidates an acknowledgement when the notice fingerprint is stale', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-disclaimer-'));
    const configFile = path.join(temp, 'config.json');
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 1,
      mode: 'manual',
      globalPreferences: {},
      disclaimer: { version: 1, noticeSha256: '0'.repeat(64), acceptedAt: new Date().toISOString() }
    }));
    expect(await disclaimerStatus(configFile)).toMatchObject({ required: true, accepted: false });
  });

  it('contains the requested Chinese responsibility warning', () => {
    expect(DISCLAIMER_NOTICE).toContain('当前 CLI 为非官方插件');
    expect(DISCLAIMER_NOTICE).toContain('自行承担');
    expect(DISCLAIMER_NOTICE).toContain('禁止自动付款');
    expect(DISCLAIMER_NOTICE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });
});
