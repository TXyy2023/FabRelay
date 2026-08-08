import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPassword, setPassword } from '@napi-rs/keyring/keytar.js';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import {
  PaymentApprovalReceiptSchema,
  SCHEMA_VERSION,
  type PaymentApprovalReceipt,
  type PaymentSnapshot
} from '../domain/types.js';

const KEYCHAIN_SERVICE = 'jlc-com-cli';
const KEYCHAIN_ACCOUNT = 'payment-approval-hmac-v1';

async function signingKey(): Promise<Buffer> {
  let stored = await getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!stored) {
    stored = randomBytes(32).toString('base64');
    await setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, stored);
  }
  return Buffer.from(stored, 'base64');
}

function unsignedPayload(value: Omit<PaymentApprovalReceipt, 'signature'>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

async function signature(value: Omit<PaymentApprovalReceipt, 'signature'>): Promise<string> {
  return createHmac('sha256', await signingKey()).update(unsignedPayload(value)).digest('base64url');
}

export async function createPaymentApprovalReceipt(
  payment: PaymentSnapshot,
  ttlMinutes = 10
): Promise<{ receipt: PaymentApprovalReceipt; path: string }> {
  await ensureAppPaths();
  if (Date.parse(payment.expiresAt) <= Date.now()) throw new JlcError('APPROVAL_EXPIRED', 'Payment snapshot has expired. Prepare it again.');
  const approvedAt = new Date();
  const unsigned: Omit<PaymentApprovalReceipt, 'signature'> = {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    paymentId: payment.id,
    environment: 'test',
    orderId: payment.orderId,
    method: 'balance',
    maxAmount: payment.amount,
    approvedAt: approvedAt.toISOString(),
    expiresAt: new Date(Math.min(
      approvedAt.getTime() + ttlMinutes * 60_000,
      Date.parse(payment.expiresAt)
    )).toISOString()
  };
  const receipt = PaymentApprovalReceiptSchema.parse({ ...unsigned, signature: await signature(unsigned) });
  const outputPath = path.join(appPaths.approvalsDir, `payment-${receipt.id}.json`);
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { receipt, path: outputPath };
}

export async function readAndVerifyPaymentApproval(
  filePath: string,
  payment: PaymentSnapshot
): Promise<PaymentApprovalReceipt> {
  let parsed: PaymentApprovalReceipt;
  try {
    parsed = PaymentApprovalReceiptSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    throw new JlcError('APPROVAL_INVALID', 'Payment approval file is invalid.', { cause: error });
  }
  const { signature: actual, ...unsigned } = parsed;
  const expected = await signature(unsigned);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new JlcError('APPROVAL_INVALID', 'Payment approval signature does not match this machine.');
  }
  if (Date.parse(parsed.expiresAt) <= Date.now() || Date.parse(payment.expiresAt) <= Date.now()) {
    throw new JlcError('APPROVAL_EXPIRED', 'Payment approval or payment snapshot has expired. Prepare and approve again.');
  }
  if (
    parsed.paymentId !== payment.id ||
    parsed.environment !== payment.environment ||
    parsed.orderId !== payment.orderId ||
    parsed.method !== payment.method ||
    Math.abs(parsed.maxAmount - payment.amount) >= 0.0001
  ) {
    throw new JlcError('APPROVAL_INVALID', 'Payment approval is not bound to this order, amount, and balance-payment method.');
  }
  return parsed;
}
