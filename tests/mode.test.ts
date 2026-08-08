import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAgentSkillMarkdown,
  buildModePrompt,
  createAgentModeContext,
  cycleAgentMode,
  inferHistorySuggestions,
  nextAgentMode,
  readModeConfiguration,
  setAgentMode,
  setGlobalPreference,
  unsetGlobalPreference
} from '../src/mode/index.js';
import type { PcbSpec } from '../src/domain/types.js';

describe('AI Agent selection modes', () => {
  it('defaults to manual and persists mode changes in a private config', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-mode-'));
    const configFile = path.join(temp, 'config.json');
    expect((await readModeConfiguration(configFile)).mode).toBe('manual');
    expect((await setAgentMode('auto', configFile)).mode).toBe('auto');
    expect((await cycleAgentMode(configFile)).mode).toBe('manual');
    expect(JSON.parse(await readFile(configFile, 'utf8')).mode).toBe('manual');
    expect(nextAgentMode('manual')).toBe('auto');
  });

  it('stores only production preferences and supports visible process-option labels', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-mode-'));
    const configFile = path.join(temp, 'config.json');
    await setGlobalPreference('板厚=1.2', configFile);
    const configured = await setGlobalPreference('processOptions.产品类型=工业类', configFile);
    expect(configured.globalPreferences).toEqual({
      boardThicknessMm: 1.2,
      'processOptions.产品类型': '工业类'
    });
    await expect(setGlobalPreference('addressId=secret', configFile)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await unsetGlobalPreference('板厚', configFile)).globalPreferences).toEqual({
      'processOptions.产品类型': '工业类'
    });
  });

  it('derives frequency-first, recency-tiebroken suggestions from completed specs', () => {
    const base = {
      confirmationMode: 'manual' as const,
      smt: false as const,
      stencil: false as const,
      processOptions: {}
    };
    const specs: PcbSpec[] = [
      { ...base, material: 'FR-4', solderMaskColor: '绿色', boardThicknessMm: 1.6 },
      { ...base, material: 'FR-4', solderMaskColor: '蓝色', boardThicknessMm: 1.2 },
      { ...base, material: 'FR-4', solderMaskColor: '绿色', boardThicknessMm: 1.2 }
    ];
    const suggestions = inferHistorySuggestions(specs);
    expect(suggestions.find((item) => item.key === 'material')).toMatchObject({ value: 'FR-4', occurrences: 3, sampleSize: 3 });
    expect(suggestions.find((item) => item.key === 'solderMaskColor')).toMatchObject({ value: '绿色', occurrences: 2 });
    expect(suggestions.find((item) => item.key === 'boardThicknessMm')).toMatchObject({ value: 1.2, occurrences: 2 });
  });

  it('produces distinct enforceable prompts and a valid SKILL.md shape', () => {
    const manual = buildModePrompt('manual');
    const auto = buildModePrompt('auto', { material: 'FR-4' }, []);
    expect(manual).toContain('Do not use global preferences');
    expect(manual).toContain('Ask the user');
    expect(auto).toContain('Never replace them');
    expect(auto).toContain('Record each autonomous choice');
    expect(auto).toContain('FR-4');

    const context = createAgentModeContext({ schemaVersion: 1, mode: 'auto', globalPreferences: { material: 'FR-4' } });
    expect(context.precedence[0]).toBe('user-evidence');
    expect(context.skillCommand).toContain('SKILL.md');

    const skill = buildAgentSkillMarkdown();
    expect(skill).toMatch(/^---\nname: jlc-pcb-ordering\ndescription: .+\n---/);
    expect(skill).toContain('jlc-cli mode context --json');
    expect(skill).toContain('Never pay');
  });
});
