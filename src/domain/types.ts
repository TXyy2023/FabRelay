import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const TEST_BASE_URL = 'https://test.jlc.com/' as const;

export const AgentModeSchema = z.enum(['manual', 'auto']);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const ModePreferenceValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ModePreferenceValue = z.infer<typeof ModePreferenceValueSchema>;

export const HistorySuggestionSchema = z.object({
  key: z.string(),
  value: ModePreferenceValueSchema,
  occurrences: z.number().int().positive(),
  sampleSize: z.number().int().positive(),
  source: z.literal('order-history')
});
export type HistorySuggestion = z.infer<typeof HistorySuggestionSchema>;

export const AgentModeContextSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  mode: AgentModeSchema,
  label: z.string(),
  globalPreferences: z.record(z.string(), ModePreferenceValueSchema),
  historySuggestions: z.array(HistorySuggestionSchema),
  precedence: z.array(z.string()),
  prompt: z.string(),
  skillCommand: z.string()
});
export type AgentModeContext = z.infer<typeof AgentModeContextSchema>;

export const DisclaimerAcceptanceSchema = z.object({
  version: z.literal(1),
  noticeSha256: z.string().length(64),
  acceptedAt: z.string()
});
export type DisclaimerAcceptance = z.infer<typeof DisclaimerAcceptanceSchema>;

export const DisclaimerStatusSchema = z.object({
  required: z.boolean(),
  accepted: z.boolean(),
  version: z.literal(1),
  noticeSha256: z.string().length(64),
  acceptedAt: z.string().optional()
});
export type DisclaimerStatus = z.infer<typeof DisclaimerStatusSchema>;

export const SeveritySchema = z.enum(['info', 'warning', 'error']);
export type Severity = z.infer<typeof SeveritySchema>;

export const GerberWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: SeveritySchema,
  file: z.string().optional()
});

export const GerberLayerSchema = z.object({
  filename: z.string(),
  type: z.enum([
    'copper',
    'soldermask',
    'silkscreen',
    'solderpaste',
    'drill',
    'outline',
    'drawing',
    'unknown'
  ]),
  side: z.enum(['top', 'bottom', 'inner', 'all', 'unknown']),
  sizeBytes: z.number().int().nonnegative()
});
export type GerberLayer = z.infer<typeof GerberLayerSchema>;

export const PreviewArtifactSchema = z.object({
  kind: z.enum(['local-top', 'local-bottom', 'jlc-analysis', 'jlc-order-check', 'order-submit', 'order-success']),
  path: z.string(),
  source: z.enum(['local', 'jlc-page']),
  format: z.enum(['svg', 'png']).optional(),
  createdAt: z.string()
});
export type PreviewArtifact = z.infer<typeof PreviewArtifactSchema>;
export type GerberWarning = z.infer<typeof GerberWarningSchema>;

export const GerberManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sourcePath: z.string(),
  archiveName: z.string(),
  sha256: z.string().length(64),
  archiveSizeBytes: z.number().int().nonnegative(),
  extractedSizeBytes: z.number().int().nonnegative(),
  layerCount: z.number().int().positive(),
  dimensions: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    unit: z.enum(['mm', 'in'])
  }).optional(),
  layers: z.array(GerberLayerSchema),
  hasOutline: z.boolean(),
  hasDrill: z.boolean(),
  previews: z.array(PreviewArtifactSchema),
  warnings: z.array(GerberWarningSchema),
  inspectedAt: z.string()
});
export type GerberManifest = z.infer<typeof GerberManifestSchema>;

export const RequirementEvidenceSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  sourcePath: z.string(),
  line: z.number().int().positive().optional(),
  confidence: z.enum(['exact', 'heuristic'])
});
export type RequirementEvidence = z.infer<typeof RequirementEvidenceSchema>;

export const ParameterConflictSchema = z.object({
  key: z.string(),
  values: z.array(z.object({ value: z.unknown(), sourcePath: z.string(), line: z.number().optional() })),
  message: z.string()
});
export type ParameterConflict = z.infer<typeof ParameterConflictSchema>;

export const PcbSpecSchema = z.object({
  material: z.string().optional(),
  layerCount: z.number().int().positive().optional(),
  quantity: z.number().int().positive().optional(),
  boardThicknessMm: z.number().positive().optional(),
  copperWeightOz: z.number().positive().optional(),
  solderMaskColor: z.string().optional(),
  silkscreenColor: z.string().optional(),
  surfaceFinish: z.string().optional(),
  viaTreatment: z.string().optional(),
  impedanceControl: z.string().optional(),
  delivery: z.string().optional(),
  addressId: z.string().optional(),
  contactId: z.string().optional(),
  shippingMethodId: z.string().optional(),
  confirmationMode: z.literal('manual').default('manual'),
  smt: z.literal(false).default(false),
  stencil: z.literal(false).default(false),
  processOptions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
});
export type PcbSpec = z.infer<typeof PcbSpecSchema>;

export const ResolvedPcbSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  spec: PcbSpecSchema,
  evidence: z.array(RequirementEvidenceSchema),
  conflicts: z.array(ParameterConflictSchema),
  unmappedRequirements: z.array(z.object({ sourcePath: z.string(), line: z.number(), text: z.string() })),
  resolvedAt: z.string()
});
export type ResolvedPcbSpec = z.infer<typeof ResolvedPcbSpecSchema>;

export const MoneyBreakdownSchema = z.object({
  currency: z.literal('CNY'),
  pcb: z.number().nonnegative().optional(),
  extras: z.number().nonnegative().optional(),
  tax: z.number().nonnegative().optional(),
  shipping: z.number().nonnegative().optional(),
  discount: z.number().nonnegative().optional(),
  total: z.number().nonnegative(),
  displayText: z.string()
});

export const QuoteSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  environment: z.literal('test'),
  baseUrl: z.literal(TEST_BASE_URL),
  gerberPath: z.string(),
  gerberSha256: z.string().length(64),
  parameterHash: z.string().length(64),
  selectionMode: AgentModeSchema.default('manual'),
  requirementEvidence: z.array(RequirementEvidenceSchema).default([]),
  spec: PcbSpecSchema,
  localManifest: GerberManifestSchema,
  jlcAnalysis: z.record(z.string(), z.unknown()),
  displayParameters: z.record(z.string(), z.string()),
  money: MoneyBreakdownSchema,
  addressLabel: z.string().optional(),
  contactLabel: z.string().optional(),
  shippingLabel: z.string().optional(),
  artifacts: z.array(PreviewArtifactSchema),
  pageFingerprint: z.string(),
  quotedAt: z.string()
});
export type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;

export const ApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  quoteId: z.string().uuid(),
  environment: z.literal('test'),
  gerberSha256: z.string().length(64),
  parameterHash: z.string().length(64),
  maxAmount: z.number().nonnegative(),
  addressId: z.string().optional(),
  shippingMethodId: z.string().optional(),
  approvedAt: z.string(),
  expiresAt: z.string(),
  signature: z.string()
});
export type ApprovalReceipt = z.infer<typeof ApprovalReceiptSchema>;

export const NormalizedOrderStatusSchema = z.enum([
  'submitted',
  'under_review',
  'file_issue',
  'awaiting_payment',
  'awaiting_production_file',
  'in_production',
  'ready_to_ship',
  'shipped',
  'delivered',
  'cancelled',
  'unknown'
]);
export type NormalizedOrderStatus = z.infer<typeof NormalizedOrderStatusSchema>;

export const OrderRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  quoteId: z.string().uuid().optional(),
  gerberSha256: z.string().length(64).optional(),
  fileName: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  currency: z.literal('CNY').default('CNY'),
  status: NormalizedOrderStatusSchema,
  rawStatus: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
  details: z.record(z.string(), z.unknown()).default({})
});
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

export const OrderAuditSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  orderId: z.string(),
  status: z.enum(['pending', 'passed', 'issue', 'unknown']),
  rawStatus: z.string(),
  detail: z.string().optional(),
  capturedAt: z.string()
});
export type OrderAuditSnapshot = z.infer<typeof OrderAuditSnapshotSchema>;

export const PaymentSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  environment: z.literal('test'),
  orderId: z.string(),
  amount: z.number().nonnegative(),
  currency: z.literal('CNY'),
  method: z.literal('balance'),
  rawOrderStatus: z.string(),
  pageFingerprint: z.string(),
  artifactPath: z.string().optional(),
  preparedAt: z.string(),
  expiresAt: z.string()
});
export type PaymentSnapshot = z.infer<typeof PaymentSnapshotSchema>;

export const PaymentApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  paymentId: z.string().uuid(),
  environment: z.literal('test'),
  orderId: z.string(),
  method: z.literal('balance'),
  maxAmount: z.number().nonnegative(),
  approvedAt: z.string(),
  expiresAt: z.string(),
  signature: z.string()
});
export type PaymentApprovalReceipt = z.infer<typeof PaymentApprovalReceiptSchema>;

export const PaymentRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  paymentId: z.string().uuid(),
  orderId: z.string(),
  method: z.literal('balance'),
  amount: z.number().nonnegative(),
  currency: z.literal('CNY'),
  status: z.enum(['succeeded', 'unknown', 'failed']),
  rawStatus: z.string(),
  artifactPath: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type PaymentRecord = z.infer<typeof PaymentRecordSchema>;

export const ProductionSnapshotSchema = z.object({
  status: NormalizedOrderStatusSchema,
  rawStatus: z.string(),
  nodes: z.array(z.object({ label: z.string(), state: z.string(), time: z.string().optional() }))
});
export type ProductionSnapshot = z.infer<typeof ProductionSnapshotSchema>;

export const ShippingSnapshotSchema = z.object({
  status: z.enum(['not_shipped', 'in_transit', 'delivered', 'exception', 'unknown']).default('unknown'),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
  rawStatus: z.string().optional()
});
export type ShippingSnapshot = z.infer<typeof ShippingSnapshotSchema>;

export const StatusSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  orderId: z.string(),
  status: NormalizedOrderStatusSchema,
  rawStatus: z.string(),
  production: ProductionSnapshotSchema,
  shipping: ShippingSnapshotSchema,
  capturedAt: z.string()
});
export type StatusSnapshot = z.infer<typeof StatusSnapshotSchema>;

export const BrowserOptionSchema = z.object({
  group: z.string(),
  value: z.string(),
  displayText: z.string(),
  disabled: z.boolean(),
  selected: z.boolean(),
  priceText: z.string().optional()
});
export type BrowserOption = z.infer<typeof BrowserOptionSchema>;

export const BrowserOptionsSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  environment: z.literal('test'),
  options: z.array(BrowserOptionSchema),
  unavailableGroups: z.array(z.string()).default([]),
  pageFingerprint: z.string(),
  capturedAt: z.string()
});
export type BrowserOptionsSnapshot = z.infer<typeof BrowserOptionsSnapshotSchema>;

export const PlatformMessageSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  category: z.enum(['platform', 'inbox']),
  title: z.string(),
  summary: z.string().optional(),
  unread: z.boolean(),
  publishedAt: z.string().optional(),
  capturedAt: z.string()
});
export type PlatformMessage = z.infer<typeof PlatformMessageSchema>;

export const XiaoZhiAnswerSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  question: z.string(),
  answer: z.string(),
  source: z.literal('jlc-xiaozhi'),
  askedAt: z.string(),
  answeredAt: z.string()
});
export type XiaoZhiAnswer = z.infer<typeof XiaoZhiAnswerSchema>;

export interface CliMeta {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  environment: 'test';
}

export const CliMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: z.string(),
  environment: z.literal('test')
});

export const CliSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  meta: CliMetaSchema
});

export const CliErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.unknown().optional() }),
  meta: CliMetaSchema
});

export interface CliSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: CliMeta;
}

export interface CliErrorEnvelope {
  ok: false;
  error: { code: string; message: string; retryable: boolean; details?: unknown };
  meta: CliMeta;
}
