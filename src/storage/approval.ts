import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPassword, setPassword } from '@napi-rs/keyring/keytar.js';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import {
  ApprovalReceiptSchema,
  type ApprovalReceipt,
  type QuoteSnapshot
} from '../domain/types.js';

const KEYCHAIN_SERVICE = 'jlc-com-cli';
const KEYCHAIN_ACCOUNT = 'approval-hmac-v1';

async function signingKey(): Promise<Buffer> {
  let stored = await getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!stored) {
    stored = randomBytes(32).toString('base64');
    await setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, stored);
  }
  return Buffer.from(stored, 'base64');
}

function unsignedPayload(value: Omit<ApprovalReceipt, 'signature'>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

async function signature(value: Omit<ApprovalReceipt, 'signature'>): Promise<string> {
  return createHmac('sha256', await signingKey()).update(unsignedPayload(value)).digest('base64url');
}

export async function createApprovalReceipt(quote: QuoteSnapshot, ttlMinutes = 15): Promise<{ receipt: ApprovalReceipt; path: string }> {
  await ensureAppPaths();
  const approvedAt = new Date();
  const unsigned: Omit<ApprovalReceipt, 'signature'> = {
    schemaVersion: 1,
    id: randomUUID(),
    quoteId: quote.id,
    environment: 'test',
    gerberSha256: quote.gerberSha256,
    parameterHash: quote.parameterHash,
    maxAmount: quote.money.total,
    addressId: quote.spec.addressId,
    shippingMethodId: quote.spec.shippingMethodId,
    approvedAt: approvedAt.toISOString(),
    expiresAt: new Date(approvedAt.getTime() + ttlMinutes * 60_000).toISOString()
  };
  const receipt = ApprovalReceiptSchema.parse({ ...unsigned, signature: await signature(unsigned) });
  const outputPath = path.join(appPaths.approvalsDir, `${receipt.id}.json`);
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { receipt, path: outputPath };
}

export async function readAndVerifyApproval(filePath: string, quote: QuoteSnapshot): Promise<ApprovalReceipt> {
  let parsed: ApprovalReceipt;
  try {
    parsed = ApprovalReceiptSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    throw new JlcError('APPROVAL_INVALID', 'Approval file is invalid.', { cause: error });
  }
  const { signature: actual, ...unsigned } = parsed;
  const expected = await signature(unsigned);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new JlcError('APPROVAL_INVALID', 'Approval signature does not match this machine.');
  }
  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new JlcError('APPROVAL_EXPIRED', 'Approval has expired. Create a new approval after reviewing the quote.');
  }
  if (
    parsed.quoteId !== quote.id ||
    parsed.environment !== quote.environment ||
    parsed.gerberSha256 !== quote.gerberSha256 ||
    parsed.parameterHash !== quote.parameterHash
  ) {
    throw new JlcError('APPROVAL_INVALID', 'Approval is not bound to this quote, Gerber, and parameter set.');
  }
  return parsed;
}
