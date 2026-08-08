import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import {
  BrowserOptionsSnapshotSchema,
  QuoteSnapshotSchema,
  SCHEMA_VERSION,
  TEST_BASE_URL,
  type BrowserOptionsSnapshot,
  type QuoteSnapshot
} from '../domain/types.js';
import { inspectGerberZip } from '../gerber/inspect.js';
import { LoginPage } from '../pages/login-page.js';
import { PcbOrderPage } from '../pages/pcb-order-page.js';
import { PcbParameterForm } from '../pages/pcb-parameter-form.js';
import { assertRequirementsReady, resolveRequirements } from '../requirements/resolve.js';
import { StateDatabase } from '../storage/database.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';
import { redactOrderSummary } from '../logging/redact.js';
import { readModeConfiguration } from '../mode/index.js';

export interface QuoteWorkflowOptions extends BrowserSessionOptions {
  requirementFiles: string[];
  overrides?: string[];
  autoSelections?: string[];
  outputDir?: string;
}

export async function createQuote(gerberPath: string, options: QuoteWorkflowOptions): Promise<QuoteSnapshot> {
  const id = randomUUID();
  const outputDir = path.resolve(options.outputDir ?? path.join(appPaths.artifactsDir, 'quotes', id));
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const localManifest = await inspectGerberZip(gerberPath, { outputDir });
  const resolved = await resolveRequirements(options.requirementFiles, options.overrides ?? [], options.autoSelections ?? []);
  const mode = (await readModeConfiguration()).mode;
  assertRequirementsReady(resolved, mode);
  if (resolved.spec.layerCount !== localManifest.layerCount) {
    throw new JlcError('REQUIREMENT_CONFLICT', 'Gerber copper-layer count conflicts with the requested layer count.', {
      details: { gerber: localManifest.layerCount, requested: resolved.spec.layerCount }
    });
  }
  const parameterHash = hashObject(resolved.spec);

  const quote = await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const order = new PcbOrderPage(session.page);
    const jlcAnalysis = await order.openAndUpload(localManifest.sourcePath, options.timeoutMs);
    const artifacts = [...localManifest.previews];
    artifacts.push(await order.captureAnalysis(outputDir, localManifest.sha256, parameterHash));
    const selectedParameters = await order.parameters.apply(resolved.spec);
    const money = await order.waitForStablePrice(options.timeoutMs);
    const check = await order.openOrderCheck();
    await check.assertReady();
    const rawDisplayParameters = await check.summary();
    assertNoSilentDefaults(rawDisplayParameters, resolved.spec);
    const displayParameters = redactOrderSummary(rawDisplayParameters);
    artifacts.push(await order.captureOrderCheck(check, outputDir));
    await check.close();
    const pageFingerprint = await order.fingerprint();
    return QuoteSnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      environment: 'test',
      baseUrl: TEST_BASE_URL,
      gerberPath: localManifest.sourcePath,
      gerberSha256: localManifest.sha256,
      parameterHash,
      selectionMode: mode,
      requirementEvidence: resolved.evidence,
      spec: resolved.spec,
      localManifest,
      jlcAnalysis: { ...jlcAnalysis, selectedParameters },
      displayParameters,
      money,
      addressLabel: maskedId(resolved.spec.addressId),
      contactLabel: maskedId(resolved.spec.contactId),
      shippingLabel: maskedId(resolved.spec.shippingMethodId),
      artifacts,
      pageFingerprint,
      quotedAt: new Date().toISOString()
    });
  });

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
    ...localManifest,
    parameterHash,
    previews: quote.artifacts
  }, null, 2)}\n`, { mode: 0o600 });
  const database = await StateDatabase.open();
  try { database.saveQuote(quote); } finally { database.close(); }
  return quote;
}

export function assertNoSilentDefaults(summary: Record<string, string>, spec: import('../domain/types.js').PcbSpec): void {
  const direct = new Set([
    '板材类别', '板子尺寸', '板子数量', '板子层数', '成品板厚', '外层铜厚', '阻焊颜色',
    '字符颜色', '阻焊覆盖', '焊盘喷镀', '阻抗管控', '交期', '确认订单方式', '是否需要SMT',
    '是否需要钢网', '收货地址', '联系方式', '快递方式', '发票信息', '个性化服务'
  ]);
  const explicit = new Set(Object.keys(spec.processOptions));
  const silent = Object.entries(summary).filter(([key, value]) => {
    if (direct.has(key) || explicit.has(key)) return false;
    return value !== '' && value !== '/' && value !== '去填写';
  }).map(([key, value]) => ({ key, candidate: value }));
  if (silent.length > 0) {
    throw new JlcError('REQUIREMENT_CONFLICT', 'The page supplied manufacturing defaults that were not explicitly accepted in processOptions.', {
      details: { candidates: silent, resolution: 'Add each key and chosen value to pcb.processOptions in a version 1 JSON/YAML requirement file.' }
    });
  }
}

export async function readCurrentOptions(options: BrowserSessionOptions = {}): Promise<BrowserOptionsSnapshot> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    await session.goto('/newOrder/#/pcb/pcbPlaceOrder');
    await session.page.getByRole('heading', { name: '基本信息', exact: true }).waitFor({ state: 'visible' });
    const form = new PcbParameterForm(session.page);
    const current = await form.optionsWithAvailability();
    return BrowserOptionsSnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      environment: 'test',
      options: current.options,
      unavailableGroups: current.unavailableGroups,
      pageFingerprint: await form.fingerprint(),
      capturedAt: new Date().toISOString()
    });
  });
}

export function hashObject(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function maskedId(value?: string): string | undefined {
  if (!value) return undefined;
  return `<configured:***${value.slice(-4)}>`;
}
