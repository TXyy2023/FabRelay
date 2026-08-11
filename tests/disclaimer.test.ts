import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_RELAY_NOTICE,
  DISCLAIMER_NOTICE,
  DISCLAIMER_NOTICE_SHA256,
  DISCLAIMER_SHOW_TEXT,
  DISCLAIMER_VERSION,
  acceptDisclaimer,
  disclaimerStatus,
  resetDisclaimer
} from '../src/disclaimer/index.js';
import { setAgentMode, setGlobalPreference } from '../src/mode/index.js';

describe('first-run third-party-tool warning', () => {
  it('requires acceptance by default and persists a versioned text fingerprint', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-disclaimer-'));
    const configFile = path.join(temp, 'config.json');
    expect(await disclaimerStatus(configFile)).toMatchObject({ required: true, accepted: false, version: DISCLAIMER_VERSION });

    await setAgentMode('simple', configFile);
    await setGlobalPreference('material=FR-4', configFile);
    const accepted = await acceptDisclaimer(configFile);
    expect(accepted).toMatchObject({ required: false, accepted: true, noticeSha256: DISCLAIMER_NOTICE_SHA256 });
    expect(accepted.acceptedAt).toMatch(/^20\d{2}-/);

    const persisted = JSON.parse(await readFile(configFile, 'utf8'));
    expect(persisted.mode).toBe('simple');
    expect(persisted.globalPreferences).toEqual({ material: 'FR-4' });
    expect(persisted.disclaimer.version).toBe(DISCLAIMER_VERSION);
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
      mode: 'hard',
      globalPreferences: {},
      disclaimer: { version: DISCLAIMER_VERSION, noticeSha256: '0'.repeat(64), acceptedAt: new Date().toISOString() }
    }));
    expect(await disclaimerStatus(configFile)).toMatchObject({ required: true, accepted: false });
  });

  it('invalidates version-1 receipts after the warning text change', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-disclaimer-'));
    const configFile = path.join(temp, 'config.json');
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 1,
      mode: 'hard',
      globalPreferences: {},
      disclaimer: { version: 1, noticeSha256: DISCLAIMER_NOTICE_SHA256, acceptedAt: new Date().toISOString() }
    }));
    expect(await disclaimerStatus(configFile)).toMatchObject({ required: true, accepted: false });
  });

  it('contains the requested Chinese third-party responsibility warning', () => {
    expect(DISCLAIMER_VERSION).toBeGreaterThanOrEqual(2);
    expect(DISCLAIMER_NOTICE).toContain('第三方');
    expect(DISCLAIMER_NOTICE).toContain('所有通过本 CLI 执行的操作');
    expect(DISCLAIMER_NOTICE).toContain('自行承担');
    expect(DISCLAIMER_NOTICE).toContain('禁止自动付款');
    expect(DISCLAIMER_NOTICE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('embeds agent relay instructions in the show text', () => {
    expect(AGENT_RELAY_NOTICE).toContain('转述');
    expect(AGENT_RELAY_NOTICE).toContain('disclaimer show');
    expect(AGENT_RELAY_NOTICE).toContain('第三方');
    expect(DISCLAIMER_SHOW_TEXT).toContain(DISCLAIMER_NOTICE);
    expect(DISCLAIMER_SHOW_TEXT).toContain(AGENT_RELAY_NOTICE);
  });
});
