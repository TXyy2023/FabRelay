import type { Locator, Page } from 'playwright';
import type { NormalizedOrderStatus, ProductionSnapshot, ShippingSnapshot } from '../domain/types.js';
import { JlcPageObject } from './base.js';

export class OrderProgressDialog extends JlcPageObject {
  readonly dialog: Locator;

  constructor(page: Page) {
    super(page);
    this.dialog = page.getByRole('dialog').filter({ hasText: '进度跟踪' }).first();
  }

  async waitForOpen(): Promise<void> {
    await this.contract('progress dialog', () => this.dialog.waitFor({ state: 'visible' }));
  }

  async production(status: NormalizedOrderStatus, rawStatus: string): Promise<ProductionSnapshot> {
    await this.waitForOpen();
    const nodes = await this.dialog.locator('.scheduleIconBox').evaluateAll((elements) => elements.map((element) => {
      const lines = Array.from(element.querySelectorAll('p')).map((value) => (value.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const className = typeof element.className === 'string' ? element.className : '';
      return {
        label: lines[1] ?? 'unknown',
        state: className.includes('todo') ? 'pending' : className.includes('active') ? 'active' : 'complete',
        time: lines.slice(2).join(' ') || undefined
      };
    }));
    return { status, rawStatus, nodes };
  }

  async shipping(): Promise<ShippingSnapshot> {
    await this.waitForOpen();
    const text = await this.dialog.innerText();
    const rawStatus = text.match(/(?:物流状态|发货状态)\s*[：:]\s*([^\n]+)/)?.[1]?.trim();
    return {
      status: normalizeShippingStatus(rawStatus),
      carrier: text.match(/(?:快递公司|承运商)\s*[：:]\s*([^\n]+)/)?.[1]?.trim(),
      trackingNumber: text.match(/(?:快递单号|物流单号)\s*[：:]\s*([A-Za-z0-9-]+)/)?.[1],
      rawStatus
    };
  }

  async close(): Promise<void> {
    await this.dialog.locator('.el-dialog__headerbtn').first().click();
    await this.dialog.waitFor({ state: 'hidden' });
  }
}

export function normalizeShippingStatus(raw?: string): ShippingSnapshot['status'] {
  if (!raw || /未发货|待发货/.test(raw)) return 'not_shipped';
  if (/已签收|已收货|妥投/.test(raw)) return 'delivered';
  if (/异常|拒收|退回|丢失/.test(raw)) return 'exception';
  if (/已发货|运输|派送|途中/.test(raw)) return 'in_transit';
  return 'unknown';
}
