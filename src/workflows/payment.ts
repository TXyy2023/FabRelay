import { randomInt, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';
import { appPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import {
  PaymentRecordSchema,
  PaymentSnapshotSchema,
  SCHEMA_VERSION,
  type PaymentRecord,
  type PaymentSnapshot
} from '../domain/types.js';
import { LoginPage } from '../pages/login-page.js';
import { OrderListPage } from '../pages/order-list-page.js';
import { OrderPaymentPage } from '../pages/order-payment-page.js';
import { createPaymentApprovalReceipt, readAndVerifyPaymentApproval } from '../storage/payment-approval.js';
import { StateDatabase } from '../storage/database.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';

export async function preparePayment(
  orderId: string,
  options: BrowserSessionOptions & { outputDir?: string } = {}
): Promise<PaymentSnapshot> {
  const id = randomUUID();
  const outputDir = path.resolve(options.outputDir ?? path.join(appPaths.artifactsDir, 'payments', id));
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const snapshot = await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const list = new OrderListPage(session.page);
    await list.open();
    const candidate = await list.paymentCandidate(orderId);
    const artifactPath = path.join(outputDir, 'payment-candidate.png');
    await candidate.card.screenshot({ path: artifactPath });
    await chmod(artifactPath, 0o600);
    const preparedAt = new Date();
    return PaymentSnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      environment: 'test',
      orderId,
      amount: candidate.record.amount,
      currency: 'CNY',
      method: 'balance',
      rawOrderStatus: candidate.record.rawStatus,
      pageFingerprint: await list.fingerprint(),
      artifactPath,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + 15 * 60_000).toISOString()
    });
  });
  const database = await StateDatabase.open();
  try { database.savePaymentSnapshot(snapshot); } finally { database.close(); }
  return snapshot;
}

export async function approvePayment(paymentId: string): Promise<{ receipt: import('../domain/types.js').PaymentApprovalReceipt; path: string }> {
  if (!stdin.isTTY || !stdout.isTTY) throw new JlcError('APPROVAL_REQUIRED', 'Payment approval requires an interactive terminal.');
  const database = await StateDatabase.open();
  let payment: PaymentSnapshot | undefined;
  try { payment = database.getPaymentSnapshot(paymentId); } finally { database.close(); }
  if (!payment) throw new JlcError('APPROVAL_REQUIRED', `Payment snapshot ${paymentId} does not exist.`);
  if (Date.parse(payment.expiresAt) <= Date.now()) throw new JlcError('APPROVAL_EXPIRED', 'Payment snapshot has expired. Prepare it again.');
  const code = String(randomInt(100_000, 1_000_000));
  stderr.write(`\nJLC 余额付款人工审批\n\n订单: ${payment.orderId}\n方式: 账户余额\n金额上限: CNY ${payment.amount.toFixed(2)}\n页面截图: ${payment.artifactPath ?? '<无>'}\n\n这会授权一次真实测试站余额扣款。\n确认码: ${code}\n\n`);
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = (await prompt.question('输入上面的六位确认码：')).trim();
    if (answer !== code) throw new JlcError('APPROVAL_INVALID', 'The payment confirmation code did not match.');
  } finally { prompt.close(); }
  const created = await createPaymentApprovalReceipt(payment);
  const next = await StateDatabase.open();
  try { next.savePaymentApproval(created.receipt); } finally { next.close(); }
  return created;
}

export interface ExecutePaymentOptions extends BrowserSessionOptions {
  paymentId: string;
  approvalFile: string;
  requestId: string;
  outputDir?: string;
}

export async function executePayment(options: ExecutePaymentOptions): Promise<PaymentRecord> {
  const database = await StateDatabase.open();
  const payment = database.getPaymentSnapshot(options.paymentId);
  if (!payment) {
    database.close();
    throw new JlcError('APPROVAL_REQUIRED', `Payment snapshot ${options.paymentId} does not exist.`);
  }
  const approval = await readAndVerifyPaymentApproval(path.resolve(options.approvalFile), payment);
  const begin = database.beginPaymentRequest(options.requestId, payment.id);
  if (begin === 'existing') {
    const existing = database.getPaymentRequest(options.requestId);
    if (existing?.paymentId !== payment.id) {
      database.close();
      throw new JlcError('APPROVAL_INVALID', 'This request ID is already bound to another payment.');
    }
    if (existing.state === 'succeeded' && existing.recordId) {
      const saved = database.getPaymentRecord(existing.recordId);
      database.close();
      if (saved) return saved;
    }
    database.close();
    throw new JlcError('ORDER_UNKNOWN', 'A previous payment attempt with this request ID is unresolved. No second payment click is allowed.', { retryable: true });
  }
  database.close();

  const outputDir = path.resolve(options.outputDir ?? path.join(appPaths.artifactsDir, 'payments', options.requestId));
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  try {
    const record = await withBrowserSession(options, async (session) => {
      await new LoginPage(session.page).assertAuthenticated();
      const list = new OrderListPage(session.page);
      await list.open();
      const candidate = await list.paymentCandidate(payment.orderId);
      if (candidate.record.amount === undefined || Math.abs(candidate.record.amount - payment.amount) >= 0.01) {
        throw new JlcError('APPROVAL_INVALID', 'The visible order amount changed after payment approval. Prepare and approve again.');
      }
      const page = new OrderPaymentPage(session.page);
      await page.open(candidate.button);
      await page.selectBalance();
      const currentAmount = await page.amount();
      if (currentAmount > approval.maxAmount + 0.0001 || Math.abs(currentAmount - payment.amount) >= 0.01) {
        throw new JlcError('AMOUNT_EXCEEDED', 'The payment-page amount differs from the approved snapshot. Payment is blocked.', {
          details: { approvedMaximum: approval.maxAmount, preparedAmount: payment.amount, currentAmount }
        });
      }
      const artifactPath = path.join(outputDir, 'before-balance-payment.png');
      await session.page.screenshot({ path: artifactPath, fullPage: true });
      await chmod(artifactPath, 0o600);
      let rawStatus: string;
      try {
        await page.submit();
        rawStatus = await page.waitForResult(options.timeoutMs ?? 120_000);
      } catch (error) {
        if (!(error instanceof JlcError) || error.code !== 'ORDER_UNKNOWN') throw error;
        await list.open();
        const reconciled = await list.find(payment.orderId);
        if (!reconciled || reconciled.record.status === 'awaiting_payment') throw error;
        rawStatus = reconciled.record.rawStatus;
      }
      const now = new Date().toISOString();
      return PaymentRecordSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        paymentId: payment.id,
        orderId: payment.orderId,
        method: 'balance',
        amount: currentAmount,
        currency: 'CNY',
        status: 'succeeded',
        rawStatus,
        artifactPath,
        createdAt: now,
        updatedAt: now
      });
    });
    const completed = await StateDatabase.open();
    try {
      completed.savePaymentRecord(record);
      completed.finishPaymentRequest(options.requestId, 'succeeded', record.id);
    } finally { completed.close(); }
    return record;
  } catch (error) {
    const failed = await StateDatabase.open();
    try {
      failed.finishPaymentRequest(options.requestId, error instanceof JlcError && error.code === 'ORDER_UNKNOWN' ? 'unknown' : 'failed');
    } finally { failed.close(); }
    throw error;
  }
}
