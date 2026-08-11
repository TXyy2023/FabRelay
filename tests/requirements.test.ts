import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRequirementsReady, resolveRequirements } from '../src/requirements/resolve.js';

describe('requirements resolver', () => {
  it('merges structured and Markdown requirements with evidence', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-req-'));
    const yaml = path.join(temp, 'pcb.yaml');
    const markdown = path.join(temp, 'delivery.md');
    await writeFile(yaml, `version: 1
pcb:
  material: FR-4
  layerCount: 2
  quantity: 5
  boardThicknessMm: 1.6
  copperWeightOz: 1
  solderMaskColor: 绿色
  silkscreenColor: 白色
  surfaceFinish: 有铅喷锡
  viaTreatment: 过孔盖油
  impedanceControl: 无要求
  addressId: addr-test
  contactId: contact-test
  shippingMethodId: sf-test
`);
    await writeFile(markdown, `# 交付要求

| 参数 | 值 |
| --- | --- |
| 交期 | 样板48小时 |
`);
    const result = await resolveRequirements([yaml, markdown]);
    expect(result.spec.layerCount).toBe(2);
    expect(result.spec.delivery).toBe('样板48小时');
    expect(result.conflicts).toHaveLength(0);
    expect(result.evidence.some((item) => item.sourcePath === markdown && item.line === 5)).toBe(true);
    expect(() => assertRequirementsReady(result)).not.toThrow();
  });

  it('blocks conflicting values and permits an explicit override', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-req-'));
    const one = path.join(temp, 'one.md');
    const two = path.join(temp, 'two.md');
    await writeFile(one, '阻焊颜色：绿色\n');
    await writeFile(two, '阻焊颜色：红色\n');

    const conflict = await resolveRequirements([one, two]);
    expect(conflict.conflicts).toHaveLength(1);
    expect(() => assertRequirementsReady(conflict)).toThrowError(/conflicts/i);

    const resolved = await resolveRequirements([one, two], ['solderMaskColor=蓝色']);
    expect(resolved.conflicts).toHaveLength(0);
    expect(resolved.spec.solderMaskColor).toBe('蓝色');
  });

  it('requires schema version 1 and rejects unknown structured keys', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-req-'));
    const missingVersion = path.join(temp, 'missing-version.yaml');
    const unknown = path.join(temp, 'unknown.json');
    await writeFile(missingVersion, 'pcb:\n  material: FR-4\n');
    await writeFile(unknown, JSON.stringify({ version: 1, pcb: { material: 'FR-4', surprise: true } }));
    await expect(resolveRequirements([missingVersion])).rejects.toMatchObject({ code: 'SCHEMA_ERROR' });
    await expect(resolveRequirements([unknown])).rejects.toMatchObject({ code: 'SCHEMA_ERROR' });
  });

  it('allows simple mode to fill only missing values and never override user evidence', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-req-'));
    const user = path.join(temp, 'user.md');
    await writeFile(user, '阻焊颜色：绿色\n');

    await expect(resolveRequirements([user], [], ['solderMaskColor=红色']))
      .rejects.toMatchObject({ code: 'REQUIREMENT_CONFLICT' });

    const resolved = await resolveRequirements([user], [], ['boardThicknessMm=1.2']);
    expect(resolved.spec.solderMaskColor).toBe('绿色');
    expect(resolved.spec.boardThicknessMm).toBe(1.2);
    expect(resolved.evidence).toContainEqual(expect.objectContaining({
      key: 'boardThicknessMm',
      sourcePath: '<agent-auto-selection>',
      confidence: 'heuristic'
    }));
    expect(() => assertRequirementsReady(resolved, 'hard')).toThrow(/forbidden in hard mode/i);
    // simple mode accepts agent auto-selections; any remaining failure must not be the forbidden-auto one
    expect(() => assertRequirementsReady(resolved, 'simple')).not.toThrow(/forbidden/i);
  });
});
