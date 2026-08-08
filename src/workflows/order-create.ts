import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { appPaths } from '../config/paths.js';
import { JlcError } from '../domain/errors.js';
import { OrderRecordSchema, SCHEMA_VERSION, type OrderRecord, type QuoteSnapshot } from '../domain/types.js';
import { inspectGerberZip } from '../gerber/inspect.js';
import { LoginPage } from '../pages/login-page.js';
import { OrderListPage } from '../pages/order-list-page.js';
import { PcbOrderPage } from '../pages/pcb-order-page.js';
import { OrderSuccessPage } from '../pages/order-success-page.js';
import { readAndVerifyApproval } from '../storage/approval.js';
import { StateDatabase } from '../storage/database.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';
import { redactOrderSummary } from '../logging/redact.js';

export interface CreateOrderOptions extends BrowserSessionOptions {
  quoteId: string;
  approvalFile: string;
  requestId: string;
  outputDir?: string;
}

export async function createOrder(options: CreateOrderOptions): Promise<OrderRecord> {
  const database = await StateDatabase.open();
  const quote = database.getQuote(options.quoteId);
  if (!quote) {
    database.close();
    throw new JlcError('APPROVAL_REQUIRED', `Quote ${options.quoteId} does not exist.`);
  }
  const approval = await readAndVerifyApproval(path.resolve(options.approvalFile), quote);
  const currentManifest = await inspectGerberZip(quote.gerberPath, { render: false });
  if (currentManifest.sha256 !== quote.gerberSha256) {
    database.close();
    throw new JlcError('APPROVAL_INVALID', 'The Gerber archive changed after approval.');
  }
  const begin = database.beginIdempotentRequest(options.requestId, quote.id);
  if (begin === 'existing') {
    const existing = database.getIdempotency(options.requestId);
    if (existing?.quoteId !== quote.id) {
      database.close();
      throw new JlcError('APPROVAL_INVALID', 'This request ID is already bound to another quote.');
    }
    if (existing?.state === 'succeeded' && existing.orderId) {
      const saved = database.getOrder(existing.orderId);
      database.close();
      if (saved) return saved;
    }
    database.close();
    const reconciled = await reconcileUnknown(quote, options);
    if (reconciled) return reconciled;
    throw new JlcError('ORDER_UNKNOWN', 'A previous submission with this request ID is unresolved. No new submit click is allowed.', { retryable: true });
  }
  database.close();

  const outputDir = path.resolve(options.outputDir ?? path.join(appPaths.artifactsDir, 'orders', options.requestId));
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  try {
    const record = await withBrowserSession(options, async (session) => {
      await new LoginPage(session.page).assertAuthenticated();
      const order = new PcbOrderPage(session.page);
      await order.openAndUpload(quote.gerberPath, options.timeoutMs);
      await order.parameters.apply(quote.spec);
      const money = await order.waitForStablePrice(options.timeoutMs);
      if (money.total > approval.maxAmount + 0.0001) {
        throw new JlcError('AMOUNT_EXCEEDED', `Current total CNY ${money.total.toFixed(2)} exceeds approved maximum CNY ${approval.maxAmount.toFixed(2)}.`);
      }
      const check = await order.openOrderCheck();
      await check.assertReady();
      const currentSummary = redactOrderSummary(await check.summary());
      assertSummaryMatches(quote, currentSummary);
      await check.dialog.screenshot({ path: path.join(outputDir, 'jlc-order-submit.png') });
      await chmod(path.join(outputDir, 'jlc-order-submit.png'), 0o600);

      try {
        await check.submit();
        const success = await new OrderSuccessPage(session.page).waitForSuccess(options.timeoutMs ?? 120_000);
        await session.page.screenshot({ path: path.join(outputDir, 'order-success.png'), fullPage: true });
        await chmod(path.join(outputDir, 'order-success.png'), 0o600);
        const list = new OrderListPage(session.page);
        await list.open();
        const found = await list.find(success.orderId);
        if (!found) throw new JlcError('ORDER_UNKNOWN', `Success page returned ${success.orderId}, but the order list did not contain it.`, { retryable: true });
        verifyReconciliation(quote, found.record, money.total);
        return OrderRecordSchema.parse({
          ...found.record,
          quoteId: quote.id,
          gerberSha256: quote.gerberSha256,
          updatedAt: new Date().toISOString(),
          details: {
            successTitle: success.title,
            successUrl: redactSuccessUrl(success.url),
            artifacts: {
              beforeSubmit: path.join(outputDir, 'jlc-order-submit.png'),
              success: path.join(outputDir, 'order-success.png')
            }
          }
        });
      } catch (error) {
        if (!(error instanceof JlcError) || error.code !== 'ORDER_UNKNOWN') throw error;
        const reconciled = await reconcileInSession(new OrderListPage(session.page), quote, money.total);
        if (reconciled) return reconciled;
        throw error;
      }
    });
    const completed = await StateDatabase.open();
    try {
      completed.saveOrder(record);
      completed.finishIdempotentRequest(options.requestId, 'succeeded', record.id);
    } finally { completed.close(); }
    return record;
  } catch (error) {
    const failed = await StateDatabase.open();
    try {
      const unknown = error instanceof JlcError && error.code === 'ORDER_UNKNOWN';
      failed.finishIdempotentRequest(options.requestId, unknown ? 'unknown' : 'failed');
    } finally { failed.close(); }
    throw error;
  }
}

function assertSummaryMatches(quote: QuoteSnapshot, current: Record<string, string>): void {
  const important = [
    '板材类别', '板子尺寸', '板子数量', '板子层数', '成品板厚', '外层铜厚', '阻焊颜色',
    '字符颜色', '阻焊覆盖', '焊盘喷镀', '阻抗管控', '交期', '是否需要SMT', '是否需要钢网',
    '确认订单方式', '收货地址', '联系方式', '快递方式'
  ];
  const differences = important.flatMap((key) => {
    const approved = quote.displayParameters[key];
    const actual = current[key];
    return approved !== undefined && actual !== approved ? [{ key, approved, actual }] : [];
  });
  if (differences.length > 0) {
    throw new JlcError('APPROVAL_INVALID', 'The replayed order-check summary differs from the approved quote.', { details: differences });
  }
  if (current['确认订单方式'] !== '手动确认订单') {
    throw new JlcError('APPROVAL_INVALID', 'The replayed order is not configured for manual confirmation.');
  }
}

async function reconcileUnknown(quote: QuoteSnapshot, options: BrowserSessionOptions): Promise<OrderRecord | undefined> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    return await reconcileInSession(new OrderListPage(session.page), quote, quote.money.total);
  });
}

async function reconcileInSession(list: OrderListPage, quote: QuoteSnapshot, amount: number): Promise<OrderRecord | undefined> {
  await list.open();
  const recent = await list.list(50);
  const stem = path.basename(quote.gerberPath, path.extname(quote.gerberPath));
  const matched = recent.find((order) => {
    const fileMatches = order.fileName ? order.fileName.includes(stem) || stem.includes(order.fileName) : false;
    const amountMatches = order.amount === undefined || Math.abs(order.amount - amount) < 0.01;
    const timeMatches = !order.createdAt || Date.parse(order.createdAt.replace(' ', 'T')) >= Date.parse(quote.quotedAt) - 5 * 60_000;
    return fileMatches && amountMatches && timeMatches;
  });
  return matched ? OrderRecordSchema.parse({ ...matched, quoteId: quote.id, gerberSha256: quote.gerberSha256 }) : undefined;
}

function verifyReconciliation(quote: QuoteSnapshot, order: OrderRecord, amount: number): void {
  const stem = path.basename(quote.gerberPath, path.extname(quote.gerberPath));
  if (order.fileName && !order.fileName.includes(stem) && !stem.includes(order.fileName)) {
    throw new JlcError('ORDER_UNKNOWN', 'The order ID exists, but its visible filename does not match the submitted Gerber.', { retryable: true });
  }
  if (order.amount !== undefined && Math.abs(order.amount - amount) >= 0.01) {
    throw new JlcError('ORDER_UNKNOWN', 'The order ID exists, but its visible amount differs from the submitted total.', { retryable: true });
  }
}

function redactSuccessUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) if (!/order|produceOrderAccessId/i.test(key)) url.searchParams.set(key, '<redacted>');
  return url.toString();
}
