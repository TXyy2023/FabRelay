import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { inspectGerberZip } from '../src/gerber/inspect.js';

const gerberHeader = `G04 generated fixture*
%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.200*%
D10*
`;

const copper = `${gerberHeader}X000000Y000000D02*
X100000Y000000D01*
X100000Y050000D01*
X000000Y050000D01*
X000000Y000000D01*
M02*
`;

const outline = `%TF.FileFunction,Profile,NP*%
${copper}`;

const drill = `M48
METRIC,TZ
T1C0.800
%
T1
X5Y2.5
M30
`;

async function zipFixture(target: string, files: Record<string, string>): Promise<void> {
  const zip = new ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  const output = await import('node:fs').then(({ createWriteStream }) => createWriteStream(target));
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(output).on('close', resolve).on('error', reject);
  });
}

describe('inspectGerberZip', () => {
  it('identifies and renders a two-layer Gerber archive', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-gerber-'));
    const archive = path.join(temp, 'board.zip');
    const output = path.join(temp, 'preview');
    await zipFixture(archive, {
      'board-F_Cu.gtl': copper,
      'board-B_Cu.gbl': copper,
      'board-Edge_Cuts.gm1': outline,
      'board.drl': drill
    });

    const result = await inspectGerberZip(archive, { outputDir: output });
    expect(result.layerCount).toBe(2);
    expect(result.hasOutline).toBe(true);
    expect(result.hasDrill).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.previews).toHaveLength(4);
    expect(await readFile(path.join(output, 'local-top.png'))).not.toHaveLength(0);
    expect(JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')).schemaVersion).toBe(1);
  });

  it('rejects path traversal entries', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-gerber-'));
    const archive = path.join(temp, 'unsafe.zip');
    const zip = new ZipFile();
    // yazl itself rejects traversal, so patch a valid ZIP filename in place.
    zip.addBuffer(Buffer.from(copper), 'aa/board-F_Cu.gtl');
    zip.end();
    const output = await import('node:fs').then(({ createWriteStream }) => createWriteStream(archive));
    await new Promise<void>((resolve, reject) => zip.outputStream.pipe(output).on('close', resolve).on('error', reject));
    const bytes = await readFile(archive);
    const original = Buffer.from('aa/board-F_Cu.gtl');
    const replacement = Buffer.from('../board-F_Cu.gtl');
    for (let offset = bytes.indexOf(original); offset >= 0; offset = bytes.indexOf(original, offset + replacement.length)) {
      replacement.copy(bytes, offset);
    }
    await writeFile(archive, bytes);
    await expect(inspectGerberZip(archive, { render: false })).rejects.toMatchObject({ code: 'GERBER_INVALID' });
  });

  it('blocks a missing outline and warns when drills are absent', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-gerber-'));
    const invalid = path.join(temp, 'missing-outline.zip');
    await zipFixture(invalid, { 'board-F_Cu.gtl': copper, 'board-B_Cu.gbl': copper });
    await expect(inspectGerberZip(invalid, { render: false })).rejects.toMatchObject({ code: 'GERBER_INVALID' });

    const warning = path.join(temp, 'no-drill.zip');
    await zipFixture(warning, { 'board-F_Cu.gtl': copper, 'board-B_Cu.gbl': copper, 'board-Edge_Cuts.gm1': outline });
    const result = await inspectGerberZip(warning, { render: false });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'NO_DRILL' }));
  });

  it('does not classify an order readme as a drill file', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-gerber-'));
    const archive = path.join(temp, 'readme-no-drill.zip');
    await zipFixture(archive, {
      'Gerber_TopLayer.GTL': copper,
      'Gerber_BottomLayer.GBL': copper,
      'Gerber_BoardOutlineLayer.GKO': outline,
      'PCB下单必读.txt': '请上传 Gerber 文件后核对工艺参数。'
    });
    const result = await inspectGerberZip(archive, { render: false });
    expect(result.hasDrill).toBe(false);
    expect(result.layers).toContainEqual(expect.objectContaining({ filename: 'PCB下单必读.txt', type: 'unknown' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'NO_DRILL' }));
  });

  it('rejects duplicate copper sides and nested archives', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-gerber-'));
    const duplicate = path.join(temp, 'duplicate.zip');
    await zipFixture(duplicate, {
      'board-F_Cu.gtl': copper,
      'copy-F_Cu.gtl': copper,
      'board-B_Cu.gbl': copper,
      'board-Edge_Cuts.gm1': outline
    });
    await expect(inspectGerberZip(duplicate, { render: false })).rejects.toMatchObject({ code: 'GERBER_INVALID' });

    const nested = path.join(temp, 'nested.zip');
    await zipFixture(nested, {
      'board-F_Cu.gtl': copper,
      'board-B_Cu.gbl': copper,
      'board-Edge_Cuts.gm1': outline,
      'source.zip': 'not really a zip'
    });
    await expect(inspectGerberZip(nested, { render: false })).rejects.toMatchObject({ code: 'GERBER_INVALID' });
  });
});
