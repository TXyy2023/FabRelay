import type { Locator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import {
  SCHEMA_VERSION,
  type NormalizedOrderStatus,
  type OrderAuditSnapshot,
  type OrderRecord,
  type StatusSnapshot
} from '../domain/types.js';
import { JlcPageObject, parseMoney } from './base.js';
import { OrderDetailPage } from './order-detail-page.js';
import { OrderProgressDialog } from './order-progress-dialog.js';
import { PAGE_CONTRACTS } from './contracts.js';

const ORDER_LIST_URL = `https://test.jlc.com${PAGE_CONTRACTS.orderListRoute}`;
const statusTexts = [
  '文件审核有问题', '等待审核', '待审核', '待付款', '等待付款', '待确认生产稿',
  '拼板中', '生产中', '待发货', '已发货', '已取消', '订单已提交'
];

export class OrderListPage extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.fullGoto(ORDER_LIST_URL);
    await this.contract('order list filters', () => this.page.getByPlaceholder('文件名 / 订单编号 / 备忘').waitFor({ state: 'visible' }));
    await this.waitForListLoaded();
  }

  async list(limit = 50): Promise<OrderRecord[]> {
    await this.waitForListLoaded();
    const records: OrderRecord[] = [];
    const seen = new Set<string>();
    while (records.length < limit) {
      const cards = this.page.locator(PAGE_CONTRACTS.orderCard);
      const count = Math.min(await cards.count(), limit - records.length);
      for (let index = 0; index < count; index += 1) {
        const record = await parseCard(cards.nth(index));
        if (!seen.has(record.id)) { records.push(record); seen.add(record.id); }
      }
      if (records.length >= limit) break;
      const next = this.page.locator('.el-pagination .btn-next').first();
      if (await next.count() === 0 || !await next.isEnabled().catch(() => false)) break;
      const before = (await this.page.locator(PAGE_CONTRACTS.orderCard).first().innerText().catch(() => '')).match(/订单编号[：:]\s*([A-Za-z0-9_-]+)/)?.[1];
      await next.click();
      await this.waitForFirstCardChange(before);
      const firstText = await this.page.locator(PAGE_CONTRACTS.orderCard).first().innerText().catch(() => '');
      if (before && firstText.includes(`订单编号：${before}`)) break;
    }
    return records;
  }

  async find(orderId: string): Promise<{ record: OrderRecord; card: Locator } | undefined> {
    const input = this.page.getByPlaceholder('文件名 / 订单编号 / 备忘');
    await input.fill(orderId);
    await this.page.getByRole('button', { name: '查询', exact: true }).click();
    await this.page.locator('.el-loading-mask:visible, .is-loading:visible').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    await this.page.waitForFunction(
      ({ selector, id }) => Array.from(document.querySelectorAll(selector)).some((element) => (element.textContent ?? '').includes(id))
        || /暂无数据|暂无订单|暂无相关订单|未查询到|No Data/i.test(document.body.innerText),
      { selector: PAGE_CONTRACTS.orderCard, id: orderId },
      { timeout: 30_000 }
    ).catch((error) => {
      throw new JlcError('CONTRACT_DRIFT', `The order search for ${orderId} did not reach a result or empty state.`, { cause: error });
    });
    const card = this.page.locator(PAGE_CONTRACTS.orderCard).filter({ hasText: `订单编号：${orderId}` }).first();
    if (await card.count() === 0 || !await card.isVisible().catch(() => false)) return undefined;
    return { record: await parseCard(card), card };
  }

  async paymentCandidate(orderId: string): Promise<{ record: OrderRecord; card: Locator; button: Locator }> {
    const found = await this.find(orderId);
    if (!found) throw new JlcError('PAGE_BUSINESS_ERROR', `Order ${orderId} was not found in the visible order list.`);
    if (found.record.status !== 'awaiting_payment') {
      throw new JlcError('PAGE_BUSINESS_ERROR', `Order ${orderId} is ${found.record.rawStatus}, not awaiting payment.`);
    }
    if (found.record.amount === undefined) {
      throw new JlcError('CONTRACT_DRIFT', `Order ${orderId} has no readable visible amount, so payment is blocked.`);
    }
    const button = found.card.locator('button.payBtn').filter({ hasText: /确认|付款|支付/ }).first();
    if (!await button.isVisible().catch(() => false) || !await button.isEnabled().catch(() => false)) {
      throw new JlcError('CONTRACT_DRIFT', `Order ${orderId} is awaiting payment but has no enabled visible payment action.`);
    }
    return { ...found, button };
  }

  async show(orderId: string): Promise<OrderRecord> {
    const found = await this.find(orderId);
    if (!found) throw new JlcError('PAGE_BUSINESS_ERROR', `Order ${orderId} was not found in the visible order list.`);
    await found.card.getByRole('link', { name: '订单详情', exact: true }).click();
    const details = new OrderDetailPage(this.page);
    const summary = await details.summary();
    await details.close();
    const audit = await this.readAudit(found.card);
    return { ...found.record, details: { ...redactOrderDetails(summary), audit }, updatedAt: new Date().toISOString() };
  }

  async status(orderId: string): Promise<StatusSnapshot> {
    const found = await this.find(orderId);
    if (!found) throw new JlcError('PAGE_BUSINESS_ERROR', `Order ${orderId} was not found in the visible order list.`);
    const progressLink = found.card.getByRole('link', { name: '进度跟踪', exact: true });
    if (!await progressLink.isVisible().catch(() => false)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        orderId,
        status: found.record.status,
        rawStatus: found.record.rawStatus,
        production: { status: found.record.status, rawStatus: found.record.rawStatus, nodes: [] },
        shipping: { status: 'not_shipped' },
        capturedAt: new Date().toISOString()
      };
    }
    await progressLink.click();
    const progress = new OrderProgressDialog(this.page);
    const production = await progress.production(found.record.status, found.record.rawStatus);
    const shipping = await progress.shipping();
    await progress.close();
    return {
      schemaVersion: SCHEMA_VERSION,
      orderId,
      status: shipping.status === 'delivered' ? 'delivered' : found.record.status,
      rawStatus: found.record.rawStatus,
      production,
      shipping,
      capturedAt: new Date().toISOString()
    };
  }

  async audit(orderId: string): Promise<OrderAuditSnapshot> {
    const found = await this.find(orderId);
    if (!found) throw new JlcError('PAGE_BUSINESS_ERROR', `Order ${orderId} was not found in the visible order list.`);
    const detail = await this.readAudit(found.card);
    const status = found.record.status === 'file_issue'
      ? 'issue'
      : found.record.status === 'under_review' || found.record.status === 'submitted'
        ? 'pending'
        : detail && /通过|审核完成|审核成功/.test(detail)
          ? 'passed'
          : detail ? 'unknown' : 'unknown';
    return {
      schemaVersion: SCHEMA_VERSION,
      orderId,
      status,
      rawStatus: found.record.rawStatus,
      detail,
      capturedAt: new Date().toISOString()
    };
  }

  private async waitForListLoaded(timeoutMs = 30_000): Promise<void> {
    await this.page.locator('.el-loading-mask:visible, .is-loading:visible').waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => undefined);
    await this.page.waitForFunction(
      ({ selector }) => document.querySelectorAll(selector).length > 0
        || /暂无数据|暂无订单|未查询到|No Data/i.test(document.body.innerText),
      { selector: PAGE_CONTRACTS.orderCard },
      { timeout: timeoutMs }
    ).catch((error) => {
      throw new JlcError('CONTRACT_DRIFT', 'The order list did not render cards or an authoritative empty state.', { cause: error });
    });
  }

  private async waitForFirstCardChange(previousId?: string): Promise<void> {
    await this.page.locator('.el-loading-mask:visible, .is-loading:visible').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    if (!previousId) {
      await this.waitForListLoaded();
      return;
    }
    await this.page.waitForFunction(
      ({ selector, previous }) => {
        const text = (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ');
        return text !== '' && !text.includes(`订单编号：${previous}`) && !text.includes(`订单编号: ${previous}`);
      },
      { selector: PAGE_CONTRACTS.orderCard, previous: previousId },
      { timeout: 30_000 }
    ).catch(() => undefined);
  }

  private async readAudit(card: Locator): Promise<string | undefined> {
    const link = card.getByRole('link', { name: '审核结果', exact: true });
    if (!await link.isVisible().catch(() => false)) return undefined;
    await link.click();
    const dialog = this.page.getByRole('dialog').last();
    if (!await dialog.isVisible().catch(() => false)) return undefined;
    const text = (await dialog.innerText()).replace(/\b1\d{10}\b/g, '1**********').slice(0, 4_000);
    const close = dialog.locator('.el-dialog__headerbtn').first();
    if (await close.isVisible().catch(() => false)) await close.click();
    await dialog.waitFor({ state: 'hidden' }).catch(() => undefined);
    return text;
  }
}

async function parseCard(card: Locator): Promise<OrderRecord> {
  const text = (await card.innerText()).replace(/\r/g, '');
  const id = text.match(/订单编号[：:]\s*([A-Za-z0-9_-]+)/)?.[1];
  if (!id) throw new JlcError('CONTRACT_DRIFT', 'An order card has no readable order ID.');
  const rawStatus = statusTexts.find((value) => text.includes(value)) ?? '未知状态';
  const amountText = [...text.matchAll(/[￥¥]\s*([0-9,.]+)/g)].at(-1)?.[0];
  const fileName = await card.locator('a').evaluateAll((links) => links
    .map((link) => (link.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((value) => value && !['订单详情', '审核结果', '进度跟踪', '修改订单', '下载工程文件', '下激光钢网', '下相同工艺订单', '样板', '小批量'].includes(value)));
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    fileName,
    amount: amountText ? parseMoney(amountText) : undefined,
    currency: 'CNY',
    status: normalizeOrderStatus(rawStatus),
    rawStatus,
    createdAt: text.match(/(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/)?.[1],
    updatedAt: new Date().toISOString(),
    details: {}
  };
}

export function normalizeOrderStatus(raw: string): NormalizedOrderStatus {
  if (/文件.*问题|审核.*问题/.test(raw)) return 'file_issue';
  if (/等待审核|待审核|审核中/.test(raw)) return 'under_review';
  if (/待付款|等待付款|未支付/.test(raw)) return 'awaiting_payment';
  if (/确认生产稿/.test(raw)) return 'awaiting_production_file';
  if (/生产中|拼板中|加工中/.test(raw)) return 'in_production';
  if (/待发货|备货完成/.test(raw)) return 'ready_to_ship';
  if (/已签收|已收货|妥投/.test(raw)) return 'delivered';
  if (/已发货|运输中/.test(raw)) return 'shipped';
  if (/取消/.test(raw)) return 'cancelled';
  if (/已提交|下单成功/.test(raw)) return 'submitted';
  return 'unknown';
}

function redactOrderDetails(details: Record<string, string>): Record<string, unknown> {
  const sensitive = /联系人|手机|电话|地址|发票|税号/i;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, sensitive.test(key) ? '<redacted>' : value]));
}
