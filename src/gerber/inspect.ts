import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import pcbStackup from 'pcb-stackup';
import sharp from 'sharp';
import whatsThatGerber from 'whats-that-gerber';
import yauzl from 'yauzl';
import { JlcError } from '../domain/errors.js';
import {
  GerberManifestSchema,
  SCHEMA_VERSION,
  type GerberLayer,
  type GerberManifest,
  type GerberWarning,
  type PreviewArtifact
} from '../domain/types.js';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const NESTED_ARCHIVE = /\.(?:zip|rar|7z|tar|tgz|gz|bz2|xz)$/i;

interface ArchiveEntry {
  name: string;
  buffer: Buffer;
  size: number;
  mode: number;
}

export interface InspectGerberOptions {
  outputDir?: string;
  render?: boolean;
}

function safeEntryName(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new JlcError('GERBER_INVALID', `Unsafe archive path: ${value}`);
  }
  return normalized;
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error('Unable to read ZIP entry.'));
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('Unable to open ZIP.'));
      resolve(zip);
    });
  });
}

async function collectEntries(filePath: string): Promise<{ entries: ArchiveEntry[]; extractedSize: number }> {
  const zip = await openZip(filePath);
  const entries: ArchiveEntry[] = [];
  let extractedSize = 0;
  let count = 0;

  return await new Promise((resolve, reject) => {
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('entry', async (entry) => {
      try {
        count += 1;
        if (count > MAX_ENTRIES) throw new JlcError('GERBER_INVALID', `ZIP contains more than ${MAX_ENTRIES} entries.`);
        const name = safeEntryName(entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) throw new JlcError('GERBER_INVALID', `Symbolic links are not allowed: ${name}`);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new JlcError('GERBER_INVALID', `Encrypted ZIP entries are not supported: ${name}`);
        if (/\/$/.test(name)) return zip.readEntry();
        if (NESTED_ARCHIVE.test(name)) throw new JlcError('GERBER_INVALID', `Nested archives are not allowed: ${name}`);
        if (entry.uncompressedSize > 1024 * 1024 && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) {
          throw new JlcError('GERBER_INVALID', `Suspicious ZIP compression ratio for ${name}.`);
        }
        extractedSize += entry.uncompressedSize;
        if (extractedSize > MAX_EXTRACTED_BYTES) {
          throw new JlcError('GERBER_INVALID', `Expanded ZIP size exceeds ${MAX_EXTRACTED_BYTES} bytes.`);
        }
        const buffer = await readEntry(zip, entry);
        entries.push({ name, buffer, size: entry.uncompressedSize, mode });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on('end', () => resolve({ entries, extractedSize }));
    zip.readEntry();
  });
}

function x2Layer(content: Buffer): { type: GerberLayer['type']; side: GerberLayer['side'] } | undefined {
  const head = content.subarray(0, Math.min(content.length, 16_384)).toString('ascii');
  const functionMatch = head.match(/%TF\.FileFunction,([^*%]+)\*%/i);
  if (!functionMatch) return undefined;
  const parts = functionMatch[1].split(',').map((part) => part.trim().toLowerCase());
  const primary = parts[0];
  const sideToken = parts.find((part) => ['top', 'bot', 'bottom', 'inr', 'inner'].includes(part));
  const side: GerberLayer['side'] = sideToken === 'top' ? 'top' : sideToken === 'bot' || sideToken === 'bottom' ? 'bottom' : sideToken === 'inr' || sideToken === 'inner' ? 'inner' : 'all';
  if (primary === 'copper') return { type: 'copper', side };
  if (primary === 'soldermask') return { type: 'soldermask', side };
  if (primary === 'legend' || primary === 'silkscreen') return { type: 'silkscreen', side };
  if (primary === 'paste') return { type: 'solderpaste', side };
  if (primary === 'profile') return { type: 'outline', side: 'all' };
  if (primary.includes('plated') || primary.includes('drill')) return { type: 'drill', side: 'all' };
  return undefined;
}

function looksLikeExcellon(content: Buffer): boolean {
  const head = content.subarray(0, Math.min(content.length, 64_000)).toString('ascii').replace(/\r/g, '');
  const markers = [
    /(?:^|\n)\s*M48\s*(?:\n|$)/i.test(head),
    /(?:^|\n)\s*(?:METRIC|INCH)(?:\s*,[^\n]*)?(?:\n|$)/i.test(head),
    /(?:^|\n)\s*T\d+\s*C\s*\d/i.test(head),
    /(?:^|\n)\s*(?:T\d+\s*)?X[-+]?\d+(?:\.\d+)?Y[-+]?\d+(?:\.\d+)?/i.test(head),
    /(?:^|\n)\s*M30\s*(?:\n|$)/i.test(head)
  ];
  return markers.filter(Boolean).length >= 3 && (markers[0] || markers[1]);
}

function safeGuessedLayer(
  entry: ArchiveEntry,
  guessed: { type?: GerberLayer['type'] | null; side?: GerberLayer['side'] | null } | undefined
): { type: GerberLayer['type']; side: GerberLayer['side'] } {
  if (looksLikeExcellon(entry.buffer)) return { type: 'drill', side: 'all' };
  if (guessed?.type === 'drill') return { type: 'unknown', side: 'unknown' };
  return {
    type: guessed?.type ?? 'unknown',
    side: guessed?.side ?? 'unknown'
  };
}

function classify(entries: ArchiveEntry[]): Array<ArchiveEntry & { type: GerberLayer['type']; side: GerberLayer['side'] }> {
  const byName = whatsThatGerber(entries.map((entry) => entry.name));
  return entries.map((entry) => {
    const x2 = x2Layer(entry.buffer);
    const guessed = byName[entry.name];
    const safeGuess = safeGuessedLayer(entry, guessed);
    const type = x2?.type ?? safeGuess.type;
    const side = x2?.side ?? safeGuess.side;
    return {
      ...entry,
      type: type === null ? 'unknown' : type,
      side: side === null ? 'unknown' : side
    };
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function defaultPreviewDirectory(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath)).replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.resolve('preview', stem);
}

export async function inspectGerberZip(filePath: string, options: InspectGerberOptions = {}): Promise<GerberManifest> {
  const absolute = path.resolve(filePath);
  const fileStat = await stat(absolute).catch(() => undefined);
  if (!fileStat?.isFile()) throw new JlcError('GERBER_INVALID', `Gerber ZIP does not exist: ${absolute}`);
  if (path.extname(absolute).toLowerCase() !== '.zip') throw new JlcError('GERBER_INVALID', 'Only Gerber ZIP files are supported in the initial release.');
  if (fileStat.size > MAX_ARCHIVE_BYTES) throw new JlcError('GERBER_INVALID', `Gerber ZIP exceeds ${MAX_ARCHIVE_BYTES} bytes.`);

  const { entries, extractedSize } = await collectEntries(absolute).catch((error) => {
    if (error instanceof JlcError) throw error;
    throw new JlcError('GERBER_INVALID', 'Gerber ZIP could not be safely decoded.', { cause: error });
  });
  if (entries.length === 0) throw new JlcError('GERBER_INVALID', 'Gerber ZIP is empty.');
  const classified = classify(entries);
  const copper = classified.filter((entry) => entry.type === 'copper');
  for (const side of ['top', 'bottom'] as const) {
    const duplicates = copper.filter((entry) => entry.side === side);
    if (duplicates.length > 1) {
      throw new JlcError('GERBER_INVALID', `Multiple ${side} copper layers were identified: ${duplicates.map((entry) => entry.name).join(', ')}`);
    }
  }
  const hasOutline = classified.some((entry) => entry.type === 'outline');
  const hasDrill = classified.some((entry) => entry.type === 'drill');
  if (copper.length === 0) throw new JlcError('GERBER_INVALID', 'No copper layers could be identified. Use standard Gerber names or X2 metadata.');
  if (!hasOutline) throw new JlcError('GERBER_INVALID', 'No board outline could be identified. Use a standard outline filename or X2 Profile metadata.');

  const warnings: GerberWarning[] = [];
  if (!hasDrill) warnings.push({ code: 'NO_DRILL', message: 'No drill file was identified.', severity: 'warning' });
  const unknown = classified.filter((entry) => entry.type === 'unknown');
  for (const entry of unknown) {
    warnings.push({ code: 'UNKNOWN_LAYER', message: 'File was not mapped to a Gerber layer.', severity: 'warning', file: entry.name });
  }

  const outputDir = path.resolve(options.outputDir ?? defaultPreviewDirectory(absolute));
  const previews: PreviewArtifact[] = [];
  let dimensions: GerberManifest['dimensions'];
  if (options.render !== false) {
    await mkdir(outputDir, { recursive: true });
    const renderable = classified.filter((entry) => entry.type !== 'unknown').map((entry) => ({
      filename: entry.name,
      gerber: entry.buffer,
      type: entry.type === 'unknown' ? undefined : entry.type,
      side: entry.side === 'unknown' ? undefined : entry.side
    }));
    try {
      const stackup = await pcbStackup(renderable, { outlineGapFill: 0.011 });
      dimensions = stackup.top.width > 0 && stackup.top.height > 0
        ? { width: stackup.top.width, height: stackup.top.height, unit: stackup.top.units }
        : undefined;
      const createdAt = new Date().toISOString();
      for (const [side, svg] of [['top', stackup.top.svg], ['bottom', stackup.bottom.svg]] as const) {
        const svgPath = path.join(outputDir, `local-${side}.svg`);
        const pngPath = path.join(outputDir, `local-${side}.png`);
        await writeFile(svgPath, String(svg), 'utf8');
        await sharp(Buffer.from(String(svg))).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toFile(pngPath);
        previews.push(
          { kind: side === 'top' ? 'local-top' : 'local-bottom', path: svgPath, source: 'local', format: 'svg', createdAt },
          { kind: side === 'top' ? 'local-top' : 'local-bottom', path: pngPath, source: 'local', format: 'png', createdAt }
        );
      }
    } catch (error) {
      throw new JlcError('GERBER_INVALID', 'Gerber layers were identified but could not be rendered.', { cause: error });
    }
  }

  const manifest = GerberManifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sourcePath: absolute,
    archiveName: path.basename(absolute),
    sha256: await sha256File(absolute),
    archiveSizeBytes: fileStat.size,
    extractedSizeBytes: extractedSize,
    layerCount: copper.length,
    dimensions,
    layers: classified.map((entry) => ({ filename: entry.name, type: entry.type, side: entry.side, sizeBytes: entry.size })),
    hasOutline,
    hasDrill,
    previews,
    warnings,
    inspectedAt: new Date().toISOString()
  });
  if (options.render !== false) await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
