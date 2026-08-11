import { z } from 'zod';
import { JlcError } from '../domain/errors.js';
import {
  ApprovalReceiptSchema,
  AgentModeContextSchema,
  BrowserOptionsSnapshotSchema,
  CliErrorEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  DisclaimerStatusSchema,
  GerberManifestSchema,
  OrderActionResultSchema,
  OrderActionsSnapshotSchema,
  OrderRecordSchema,
  OrderAuditSnapshotSchema,
  ParameterConflictSchema,
  PaymentApprovalReceiptSchema,
  PaymentRecordSchema,
  PaymentSnapshotSchema,
  PlatformMessageSchema,
  ProductionSnapshotSchema,
  QuoteSnapshotSchema,
  ResolvedPcbSpecSchema,
  ShippingSnapshotSchema,
  StatusSnapshotSchema,
  XiaoZhiAnswerSchema
} from '../domain/types.js';

export const publicSchemas = {
  AgentModeContext: AgentModeContextSchema,
  DisclaimerStatus: DisclaimerStatusSchema,
  GerberManifest: GerberManifestSchema,
  ResolvedPcbSpec: ResolvedPcbSpecSchema,
  ParameterConflict: ParameterConflictSchema,
  QuoteSnapshot: QuoteSnapshotSchema,
  ApprovalReceipt: ApprovalReceiptSchema,
  OrderRecord: OrderRecordSchema,
  OrderAuditSnapshot: OrderAuditSnapshotSchema,
  OrderActionsSnapshot: OrderActionsSnapshotSchema,
  OrderActionResult: OrderActionResultSchema,
  PaymentSnapshot: PaymentSnapshotSchema,
  PaymentApprovalReceipt: PaymentApprovalReceiptSchema,
  PaymentRecord: PaymentRecordSchema,
  PlatformMessage: PlatformMessageSchema,
  XiaoZhiAnswer: XiaoZhiAnswerSchema,
  ProductionSnapshot: ProductionSnapshotSchema,
  ShippingSnapshot: ShippingSnapshotSchema,
  StatusSnapshot: StatusSnapshotSchema,
  BrowserOptionsSnapshot: BrowserOptionsSnapshotSchema,
  CliSuccessEnvelope: CliSuccessEnvelopeSchema,
  CliErrorEnvelope: CliErrorEnvelopeSchema
} as const;

export type PublicSchemaName = keyof typeof publicSchemas;

const commandSchemas: Record<string, PublicSchemaName> = {
  inspect: 'GerberManifest',
  preview: 'GerberManifest',
  requirements: 'ResolvedPcbSpec',
  quote: 'QuoteSnapshot',
  approval: 'ApprovalReceipt',
  order: 'OrderRecord',
  'orders-list': 'OrderRecord',
  'orders-show': 'OrderRecord',
  'orders-audit': 'OrderAuditSnapshot',
  'orders-actions': 'OrderActionsSnapshot',
  'order-action': 'OrderActionResult',
  payment: 'PaymentSnapshot',
  'payment-approval': 'PaymentApprovalReceipt',
  'payment-record': 'PaymentRecord',
  messages: 'PlatformMessage',
  xiaozhi: 'XiaoZhiAnswer',
  status: 'StatusSnapshot',
  options: 'BrowserOptionsSnapshot',
  success: 'CliSuccessEnvelope',
  error: 'CliErrorEnvelope',
  mode: 'AgentModeContext',
  disclaimer: 'DisclaimerStatus'
};

export function schemaFor(name: string): object {
  const canonical = (name in publicSchemas ? name : commandSchemas[name]) as PublicSchemaName | undefined;
  if (!canonical || !(canonical in publicSchemas)) throw new JlcError('INVALID_ARGUMENT', `Unknown schema: ${name}`);
  return z.toJSONSchema(publicSchemas[canonical], { target: 'draft-2020-12', io: 'output' });
}
