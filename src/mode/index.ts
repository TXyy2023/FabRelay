import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import {
  AgentModeContextSchema,
  AgentModeSchema,
  DisclaimerAcceptanceSchema,
  ModePreferenceValueSchema,
  SCHEMA_VERSION,
  type AgentMode,
  type AgentModeContext,
  type HistorySuggestion,
  type ModePreferenceValue,
  type PcbSpec
} from '../domain/types.js';
import { JlcError } from '../domain/errors.js';
import { parseOverride } from '../requirements/resolve.js';
import { StateDatabase } from '../storage/database.js';

const ModeConfigurationSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  mode: AgentModeSchema.default('manual'),
  globalPreferences: z.record(z.string(), ModePreferenceValueSchema).default({}),
  disclaimer: DisclaimerAcceptanceSchema.optional()
}).passthrough();

export type ModeConfiguration = z.infer<typeof ModeConfigurationSchema>;

export const AUTO_PREFERENCE_KEYS = [
  'material',
  'layerCount',
  'boardThicknessMm',
  'copperWeightOz',
  'solderMaskColor',
  'silkscreenColor',
  'surfaceFinish',
  'viaTreatment',
  'impedanceControl'
] as const satisfies ReadonlyArray<keyof PcbSpec>;

export const PRODUCTION_PARAMETER_KEYS = [
  'material',
  'layerCount',
  'boardThicknessMm',
  'copperWeightOz',
  'solderMaskColor',
  'silkscreenColor',
  'surfaceFinish',
  'viaTreatment',
  'impedanceControl'
] as const satisfies ReadonlyArray<keyof PcbSpec>;

export function parseAgentMode(value: string): AgentMode {
  const parsed = AgentModeSchema.safeParse(value.toLowerCase());
  if (!parsed.success) throw new JlcError('INVALID_ARGUMENT', 'Mode must be manual or auto.');
  return parsed.data;
}

export function nextAgentMode(mode: AgentMode): AgentMode {
  return mode === 'manual' ? 'auto' : 'manual';
}

export function modeLabel(mode: AgentMode): string {
  return mode === 'manual' ? '严谨模式' : 'AI 选择模式';
}

export async function readModeConfiguration(configFile = appPaths.configFile): Promise<ModeConfiguration> {
  const content = await readFile(configFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new JlcError('SCHEMA_ERROR', `Mode configuration could not be read: ${configFile}`, { cause: error });
  });
  if (content === undefined) return ModeConfigurationSchema.parse({});
  try {
    return ModeConfigurationSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new JlcError('SCHEMA_ERROR', `Mode configuration is invalid: ${configFile}`, { cause: error });
  }
}

export async function setAgentMode(mode: AgentMode | string, configFile = appPaths.configFile): Promise<ModeConfiguration> {
  const selected = typeof mode === 'string' ? parseAgentMode(mode) : mode;
  const current = await readModeConfiguration(configFile);
  const updated = ModeConfigurationSchema.parse({ ...current, mode: selected });
  await writeModeConfiguration(updated, configFile);
  return updated;
}

export async function cycleAgentMode(configFile = appPaths.configFile): Promise<ModeConfiguration> {
  const current = await readModeConfiguration(configFile);
  return await setAgentMode(nextAgentMode(current.mode), configFile);
}

export async function setGlobalPreference(raw: string, configFile = appPaths.configFile): Promise<ModeConfiguration> {
  const { key, value } = parsePreference(raw);
  const current = await readModeConfiguration(configFile);
  const updated = ModeConfigurationSchema.parse({
    ...current,
    globalPreferences: { ...current.globalPreferences, [key]: value }
  });
  await writeModeConfiguration(updated, configFile);
  return updated;
}

export async function unsetGlobalPreference(rawKey: string, configFile = appPaths.configFile): Promise<ModeConfiguration> {
  const key = canonicalPreferenceKey(rawKey);
  const current = await readModeConfiguration(configFile);
  const globalPreferences = { ...current.globalPreferences };
  delete globalPreferences[key];
  const updated = ModeConfigurationSchema.parse({ ...current, globalPreferences });
  await writeModeConfiguration(updated, configFile);
  return updated;
}

export async function readAgentModeContext(configFile = appPaths.configFile): Promise<AgentModeContext> {
  const configuration = await readModeConfiguration(configFile);
  const specs = configFile === appPaths.configFile ? await orderedSpecs() : [];
  const historySuggestions = inferHistorySuggestions(specs);
  return createAgentModeContext(configuration, historySuggestions);
}

export function createAgentModeContext(
  configuration: ModeConfiguration,
  historySuggestions: HistorySuggestion[] = []
): AgentModeContext {
  return AgentModeContextSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    mode: configuration.mode,
    label: modeLabel(configuration.mode),
    globalPreferences: configuration.globalPreferences,
    historySuggestions,
    precedence: configuration.mode === 'manual'
      ? ['user-evidence', 'gerber-fact']
      : ['user-evidence', 'gerber-fact', 'global-preference', 'order-history', 'agent-engineering-judgment'],
    prompt: buildModePrompt(configuration.mode, configuration.globalPreferences, historySuggestions),
    skillCommand: 'jlc-cli mode skill --file ./SKILL.md'
  });
}

export function inferHistorySuggestions(specs: readonly PcbSpec[]): HistorySuggestion[] {
  const flattened = specs.map(flattenSpecPreferences);
  const keys = new Set(flattened.flatMap((entry) => Object.keys(entry)));
  const suggestions: HistorySuggestion[] = [];
  for (const key of keys) {
    const values = flattened.flatMap((entry, index) => entry[key] === undefined ? [] : [{ value: entry[key]!, index }]);
    const groups = new Map<string, { value: ModePreferenceValue; occurrences: number; mostRecent: number }>();
    for (const item of values) {
      const serialized = JSON.stringify(item.value);
      const existing = groups.get(serialized);
      groups.set(serialized, {
        value: item.value,
        occurrences: (existing?.occurrences ?? 0) + 1,
        mostRecent: Math.min(existing?.mostRecent ?? item.index, item.index)
      });
    }
    const selected = [...groups.values()].sort((left, right) =>
      right.occurrences - left.occurrences || left.mostRecent - right.mostRecent
    )[0];
    if (selected) suggestions.push({
      key,
      value: selected.value,
      occurrences: selected.occurrences,
      sampleSize: values.length,
      source: 'order-history'
    });
  }
  return suggestions.sort((left, right) => left.key.localeCompare(right.key));
}

export function buildModePrompt(
  mode: AgentMode,
  globalPreferences: Record<string, ModePreferenceValue> = {},
  historySuggestions: HistorySuggestion[] = []
): string {
  const shared = `You are operating jlc-cli in ${mode} mode (${modeLabel(mode)}).\n` +
    'This mode governs PCB production-parameter selection only. It never authorizes order submission, payment, cancellation, SMT, PCBA, or stencil ordering. Payment is a separate prepare, human-approval, and execute workflow.\n' +
    'Always preserve explicit user values, reject conflicts, keep manual order confirmation, and require the signed human approval before creating a test order.\n';
  if (mode === 'manual') {
    return shared +
      'For every production parameter, require evidence from the user prompt, a user-provided requirements document, or a Gerber-derived fact.\n' +
      'For PDF/XLSX evidence, extract it locally and normalize the cited values into a version 1 JSON/YAML/Markdown requirements file before calling jlc-cli.\n' +
      'Do not use global preferences, order history, generic engineering defaults, or webpage defaults to fill a missing production parameter. Ask the user for the missing evidence.\n' +
      'Run `jlc-cli requirements validate ...` before `pcb quote`; unresolved text, conflicts, and missing fields are blocking.\n';
  }
  return shared +
    'For values explicitly supplied by the user, use those exact values. Never replace them with a preference or historical habit.\n' +
    'For missing production parameters, choose in this order: Gerber fact, global preference, order history, then engineering judgment constrained by current `pcb options`.\n' +
    'Record each autonomous choice with key, chosen value, source, and short rationale; pass scalar missing values through `--auto-set`, or use a generated version 1 requirements file for processOptions. Use `--set` only for an explicit user decision.\n' +
    'Do not silently accept webpage defaults. Ask the user when sources conflict, an option is unavailable, or the choice materially changes manufacturability.\n' +
    `Global preferences: ${JSON.stringify(globalPreferences)}\n` +
    `Order-history suggestions: ${JSON.stringify(historySuggestions)}\n`;
}

export function buildAgentSkillMarkdown(): string {
  return `---
name: jlc-pcb-ordering
description: Operate jlc-cli for Gerber inspection, PCB requirement resolution, Playwright quoting, human approval, test-order creation, and order tracking. Use whenever an agent handles a JLC PCB order or chooses PCB production parameters; always load the persisted manual or auto selection policy first.
---

# JLC PCB ordering

Run \`jlc-cli mode context --json\` before resolving requirements and again if the user changes mode. Treat its \`prompt\`, preferences, and completed-order history as the active selection policy.

## Resolve production parameters

- Preserve every explicit user value and block conflicting user evidence.
- In \`manual\`, require user prompt, user document, or Gerber evidence for every production parameter. Ask for anything missing.
- In \`auto\`, fill only missing production parameters using the context precedence. Record key, value, source, and rationale for every autonomous choice; use \`--auto-set\` so the CLI prevents overriding user evidence.
- Read PDF/XLSX evidence with local document tools, then normalize cited values to a version 1 JSON/YAML/Markdown requirements file accepted by jlc-cli.
- Never silently accept webpage defaults. Query \`jlc-cli pcb options --json\` when current site choices matter.

## Execute safely

1. Inspect the Gerber locally.
2. Validate and resolve requirements.
3. Quote through the visible test-site workflow.
4. Present the immutable quote for signed human approval.
5. Create a test order only with a valid approval and action-time user authorization.
6. Verify the success page and order-list readback.
7. Read the file-review result, production nodes, shipping, and delivery state from the visible pages.
8. If an order is awaiting payment, prepare a payment snapshot. Execute balance payment only with the separately signed, unexpired payment approval and action-time user authorization.

Never pay automatically or infer payment authority from this mode, a quote approval, or an order approval. Never modify, cancel, or delete an order. Never order PCBA, SMT, or a stencil. Never bypass login or CAPTCHA. Keep manual order confirmation enabled.
`;
}

async function orderedSpecs(): Promise<PcbSpec[]> {
  const database = await StateDatabase.open();
  try {
    return database.listOrders(50).flatMap((order) => {
      if (order.status === 'cancelled' || order.status === 'file_issue') return [];
      if (!order.quoteId) return [];
      const quote = database.getQuote(order.quoteId);
      return quote ? [quote.spec] : [];
    });
  } finally {
    database.close();
  }
}

function flattenSpecPreferences(spec: PcbSpec): Record<string, ModePreferenceValue> {
  const result: Record<string, ModePreferenceValue> = {};
  for (const key of AUTO_PREFERENCE_KEYS) {
    const value = spec[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  for (const [key, value] of Object.entries(spec.processOptions)) result[`processOptions.${key}`] = value;
  return result;
}

function parsePreference(raw: string): { key: string; value: ModePreferenceValue } {
  const index = raw.indexOf('=');
  if (index <= 0) throw new JlcError('INVALID_ARGUMENT', `Preference must use key=value: ${raw}`);
  const rawKey = raw.slice(0, index).trim();
  const rawValue = raw.slice(index + 1).trim();
  if (rawKey.startsWith('processOptions.')) {
    const label = rawKey.slice('processOptions.'.length).trim();
    if (!label) throw new JlcError('INVALID_ARGUMENT', 'processOptions preference requires a visible page label.');
    return { key: `processOptions.${label}`, value: parseScalar(rawValue) };
  }
  const parsed = parseOverride(raw);
  if (!AUTO_PREFERENCE_KEYS.includes(parsed.key as typeof AUTO_PREFERENCE_KEYS[number])) {
    throw new JlcError('INVALID_ARGUMENT', 'Global mode preferences only support PCB production parameters, not quantity, delivery, address, contact, or shipping.');
  }
  if (typeof parsed.value !== 'string' && typeof parsed.value !== 'number' && typeof parsed.value !== 'boolean') {
    throw new JlcError('INVALID_ARGUMENT', `Preference ${rawKey} must be a scalar value.`);
  }
  return { key: parsed.key, value: parsed.value };
}

function canonicalPreferenceKey(rawKey: string): string {
  if (rawKey.startsWith('processOptions.')) return rawKey;
  const parsed = parseOverride(`${rawKey}=`);
  if (!AUTO_PREFERENCE_KEYS.includes(parsed.key as typeof AUTO_PREFERENCE_KEYS[number])) {
    throw new JlcError('INVALID_ARGUMENT', `Unknown production preference: ${rawKey}`);
  }
  return parsed.key;
}

function parseScalar(value: string): ModePreferenceValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export async function writeModeConfiguration(configuration: ModeConfiguration, configFile: string): Promise<void> {
  if (configFile === appPaths.configFile) await ensureAppPaths();
  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, configFile);
    await chmod(configFile, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
