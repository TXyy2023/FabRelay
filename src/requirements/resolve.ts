import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { JlcError } from '../domain/errors.js';
import {
  PcbSpecSchema,
  ResolvedPcbSpecSchema,
  SCHEMA_VERSION,
  type AgentMode,
  type ParameterConflict,
  type PcbSpec,
  type RequirementEvidence,
  type ResolvedPcbSpec
} from '../domain/types.js';

const aliases: Record<string, keyof PcbSpec> = {
  material: 'material',
  '板材': 'material',
  '板材类别': 'material',
  layers: 'layerCount',
  layercount: 'layerCount',
  '层数': 'layerCount',
  '板子层数': 'layerCount',
  quantity: 'quantity',
  '数量': 'quantity',
  '板子数量': 'quantity',
  thickness: 'boardThicknessMm',
  boardthicknessmm: 'boardThicknessMm',
  '板厚': 'boardThicknessMm',
  '成品板厚': 'boardThicknessMm',
  copper: 'copperWeightOz',
  copperweightoz: 'copperWeightOz',
  '铜厚': 'copperWeightOz',
  '外层铜厚': 'copperWeightOz',
  soldermask: 'solderMaskColor',
  soldermaskcolor: 'solderMaskColor',
  '阻焊': 'solderMaskColor',
  '阻焊颜色': 'solderMaskColor',
  silkscreen: 'silkscreenColor',
  silkscreencolor: 'silkscreenColor',
  '字符': 'silkscreenColor',
  '字符颜色': 'silkscreenColor',
  finish: 'surfaceFinish',
  surfacefinish: 'surfaceFinish',
  '表面处理': 'surfaceFinish',
  '焊盘喷镀': 'surfaceFinish',
  viatreatment: 'viaTreatment',
  '过孔处理': 'viaTreatment',
  '阻焊覆盖': 'viaTreatment',
  impedance: 'impedanceControl',
  impedancecontrol: 'impedanceControl',
  '阻抗': 'impedanceControl',
  '阻抗管控': 'impedanceControl',
  delivery: 'delivery',
  '交期': 'delivery',
  addressid: 'addressId',
  '地址id': 'addressId',
  contactid: 'contactId',
  '联系人id': 'contactId',
  shippingmethodid: 'shippingMethodId',
  '快递id': 'shippingMethodId'
};

const structuredKeys = new Set<keyof PcbSpec>([
  'material', 'layerCount', 'quantity', 'boardThicknessMm', 'copperWeightOz',
  'solderMaskColor', 'silkscreenColor', 'surfaceFinish', 'viaTreatment',
  'impedanceControl', 'delivery', 'addressId', 'contactId', 'shippingMethodId',
  'processOptions'
]);

const StructuredRequirementsSchema = z.object({
  version: z.literal(1),
  pcb: PcbSpecSchema.partial().strict()
}).strict();

function canonicalKey(raw: string): keyof PcbSpec | undefined {
  const normalized = raw.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  return aliases[normalized] ?? aliases[raw.trim()];
}

function parseNumber(value: string): number | undefined {
  const match = value.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function normalizeValue(key: keyof PcbSpec, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (['layerCount', 'quantity', 'boardThicknessMm', 'copperWeightOz'].includes(key)) {
    return parseNumber(trimmed);
  }
  if (key === 'material') return trimmed.replace(/fr[- ]?4/i, 'FR-4');
  return trimmed;
}

function evidenceFromStructured(filePath: string, raw: unknown, content: string): RequirementEvidence[] {
  const parsed = StructuredRequirementsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JlcError('SCHEMA_ERROR', `Structured requirement file does not match schema version 1: ${filePath}`, {
      details: parsed.error.issues
    });
  }
  const object = parsed.data.pcb as Record<string, unknown>;
  const evidence: RequirementEvidence[] = [];
  for (const [rawKey, rawValue] of Object.entries(object)) {
    const key = canonicalKey(rawKey) ?? (structuredKeys.has(rawKey as keyof PcbSpec) ? rawKey as keyof PcbSpec : undefined);
    if (!key || rawKey === 'version') continue;
    evidence.push({ key, value: normalizeValue(key, rawValue), sourcePath: filePath, line: findKeyLine(content, rawKey), confidence: 'exact' });
  }
  return evidence;
}

function findKeyLine(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:["']?${escaped}["']?)\\s*:`);
  const index = lines.findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : undefined;
}

function textPairs(line: string): Array<[string, string]> {
  const trimmed = line.trim();
  const table = trimmed.match(/^\|?\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|?$/);
  if (table && !/^[-: ]+$/.test(table[1]) && !/^[-: ]+$/.test(table[2])) return [[table[1], table[2]]];
  const colon = trimmed.match(/^[-*]?\s*([^:：]{1,40})\s*[:：]\s*(.+)$/);
  return colon ? [[colon[1], colon[2]]] : [];
}

function evidenceFromText(filePath: string, content: string): { evidence: RequirementEvidence[]; unmapped: ResolvedPcbSpec['unmappedRequirements'] } {
  const evidence: RequirementEvidence[] = [];
  const unmapped: ResolvedPcbSpec['unmappedRequirements'] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const clean = line.trim();
    if (!clean || clean.startsWith('#') || clean.startsWith('```') || /^\|?\s*[-:]+/.test(clean)) return;
    const pairs = textPairs(clean);
    if (pairs.length === 0) {
      if (/\d|板|层|铜|阻焊|字符|沉金|喷锡|交期|快递/.test(clean)) unmapped.push({ sourcePath: filePath, line: index + 1, text: clean });
      return;
    }
    for (const [rawKey, rawValue] of pairs) {
      if (/^(?:参数|字段|key)$/i.test(rawKey.trim()) && /^(?:值|value)$/i.test(rawValue.trim())) continue;
      const key = canonicalKey(rawKey);
      if (!key) {
        unmapped.push({ sourcePath: filePath, line: index + 1, text: clean });
        continue;
      }
      evidence.push({ key, value: normalizeValue(key, rawValue), sourcePath: filePath, line: index + 1, confidence: 'exact' });
    }
  });
  return { evidence, unmapped };
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeEvidence(evidence: RequirementEvidence[]): { spec: PcbSpec; conflicts: ParameterConflict[] } {
  const grouped = new Map<string, RequirementEvidence[]>();
  for (const item of evidence) grouped.set(item.key, [...(grouped.get(item.key) ?? []), item]);
  const spec: Record<string, unknown> = { confirmationMode: 'manual', smt: false, stencil: false, processOptions: {} };
  const conflicts: ParameterConflict[] = [];
  for (const [key, items] of grouped) {
    const distinct = items.filter((item, index) => items.findIndex((candidate) => equalValue(candidate.value, item.value)) === index);
    if (distinct.length > 1) {
      conflicts.push({
        key,
        values: distinct.map((item) => ({ value: item.value, sourcePath: item.sourcePath, line: item.line })),
        message: `Conflicting values were provided for ${key}.`
      });
    } else {
      spec[key] = distinct[0]?.value;
    }
  }
  return { spec: PcbSpecSchema.parse(spec), conflicts };
}

export function parseOverride(value: string): { key: keyof PcbSpec; value: unknown } {
  const index = value.indexOf('=');
  if (index <= 0) throw new JlcError('INVALID_ARGUMENT', `Override must use key=value: ${value}`);
  const rawKey = value.slice(0, index);
  const rawValue = value.slice(index + 1);
  const key = canonicalKey(rawKey) ?? (structuredKeys.has(rawKey as keyof PcbSpec) ? rawKey as keyof PcbSpec : undefined);
  if (!key) throw new JlcError('INVALID_ARGUMENT', `Unknown PCB parameter: ${rawKey}`);
  return { key, value: normalizeValue(key, rawValue) };
}

export async function resolveRequirements(
  filePaths: string[],
  overrides: string[] = [],
  autoSelections: string[] = []
): Promise<ResolvedPcbSpec> {
  const evidence: RequirementEvidence[] = [];
  const unmapped: ResolvedPcbSpec['unmappedRequirements'] = [];
  for (const input of filePaths) {
    const filePath = path.resolve(input);
    const content = await readFile(filePath, 'utf8').catch((error) => {
      throw new JlcError('INVALID_ARGUMENT', `Requirement file could not be read: ${filePath}`, { cause: error });
    });
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.json' || extension === '.yaml' || extension === '.yml') {
      let parsed: unknown;
      try {
        parsed = extension === '.json' ? JSON.parse(content) : YAML.parse(content);
      } catch (error) {
        throw new JlcError('SCHEMA_ERROR', `Structured requirement file could not be parsed: ${filePath}`, { cause: error });
      }
      evidence.push(...evidenceFromStructured(filePath, parsed, content));
    }
    else if (extension === '.md' || extension === '.txt') {
      const parsed = evidenceFromText(filePath, content);
      evidence.push(...parsed.evidence);
      unmapped.push(...parsed.unmapped);
    } else {
      throw new JlcError('INVALID_ARGUMENT', `Unsupported requirement file extension: ${extension}`);
    }
  }

  const overrideKeys = new Set<string>();
  for (const raw of overrides) {
    const parsed = parseOverride(raw);
    overrideKeys.add(parsed.key);
    evidence.push({ key: parsed.key, value: parsed.value, sourcePath: '<cli-override>', confidence: 'exact' });
  }
  const filtered = evidence.filter((item) => item.sourcePath === '<cli-override>' || !overrideKeys.has(item.key));
  for (const raw of autoSelections) {
    const parsed = parseOverride(raw);
    const explicit = filtered.filter((item) => item.key === parsed.key);
    if (explicit.length > 0) {
      const same = explicit.every((item) => equalValue(item.value, parsed.value));
      if (!same) {
        throw new JlcError('REQUIREMENT_CONFLICT', `Agent auto-selection cannot override explicit user evidence for ${parsed.key}.`, {
          details: {
            key: parsed.key,
            attempted: parsed.value,
            explicit: explicit.map((item) => ({ value: item.value, sourcePath: item.sourcePath, line: item.line }))
          }
        });
      }
      continue;
    }
    filtered.push({ key: parsed.key, value: parsed.value, sourcePath: '<agent-auto-selection>', confidence: 'heuristic' });
  }
  const merged = mergeEvidence(filtered);
  return ResolvedPcbSpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    spec: merged.spec,
    evidence: filtered,
    conflicts: merged.conflicts,
    unmappedRequirements: unmapped,
    resolvedAt: new Date().toISOString()
  });
}

export function assertRequirementsReady(resolved: ResolvedPcbSpec, mode: AgentMode = 'manual'): void {
  const autonomous = resolved.evidence.filter((item) => item.sourcePath === '<agent-auto-selection>');
  if (mode === 'manual' && autonomous.length > 0) {
    throw new JlcError('REQUIREMENT_CONFLICT', 'Agent auto-selections are forbidden in manual mode.', {
      details: { mode, keys: autonomous.map((item) => item.key), resolution: 'Obtain user or Gerber evidence and pass it as a requirements file or explicit --set.' }
    });
  }
  if (resolved.conflicts.length > 0) {
    throw new JlcError('REQUIREMENT_CONFLICT', 'Requirement conflicts must be resolved before quoting.', {
      details: { mode, conflicts: resolved.conflicts, resolution: 'Explicit user values take priority; ask the user when their sources conflict.' }
    });
  }
  if (resolved.unmappedRequirements.length > 0) {
    throw new JlcError('REQUIREMENT_CONFLICT', 'Unmapped requirement text must be handled before quoting.', {
      details: { mode, unmappedRequirements: resolved.unmappedRequirements }
    });
  }
  const required: Array<keyof PcbSpec> = [
    'material', 'layerCount', 'quantity', 'boardThicknessMm', 'copperWeightOz',
    'solderMaskColor', 'silkscreenColor', 'surfaceFinish', 'viaTreatment', 'impedanceControl', 'delivery',
    'addressId', 'contactId', 'shippingMethodId'
  ];
  const missing = required.filter((key) => resolved.spec[key] === undefined || resolved.spec[key] === '');
  if (missing.length > 0) {
    const resolution = mode === 'manual'
      ? 'Every missing production parameter requires user prompt, user-document, or Gerber evidence. Ask the user; do not use preferences, history, or defaults.'
      : 'Call `jlc-cli mode context --json`; resolve missing production parameters by policy and pass every autonomous scalar choice through --auto-set (or a generated version 1 requirements file with provenance).';
    throw new JlcError('REQUIREMENT_CONFLICT', `Required PCB parameters are missing in ${mode} mode.`, {
      details: { mode, missing, resolution }
    });
  }
}
