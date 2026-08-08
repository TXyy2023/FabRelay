import type { Locator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject } from './base.js';

export class OrderCheckDialog extends JlcPageObject {
  readonly dialog: Locator;

  constructor(page: Page) {
    super(page);
    this.dialog = page.getByRole('dialog', { name: /订单检查/ });
  }

  async waitForOpen(): Promise<void> {
    await this.contract('order-check dialog', () => this.dialog.waitFor({ state: 'visible' }));
  }

  async summary(): Promise<Record<string, string>> {
    await this.waitForOpen();
    const rows = await this.dialog.locator('tr').evaluateAll((elements) => elements.map((row) => {
      const cells = Array.from(row.querySelectorAll('th,td')).map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
      return cells.length >= 2 ? [cells[0], cells.slice(1).join(' ')] : undefined;
    }).filter((value): value is [string, string] => Boolean(value?.[0])));
    return Object.fromEntries(rows);
  }

  async assertReady(): Promise<void> {
    const text = await this.dialog.innerText();
    const missing = [...text.matchAll(/(\d+)\s*项未填写/g)].map((match) => Number(match[1])).find((count) => count > 0);
    if (missing) throw new JlcError('PAGE_BUSINESS_ERROR', `Order check reports ${missing} missing fields.`);
    const mode = (await this.summary())['确认订单方式'];
    if (mode !== '手动确认订单') throw new JlcError('PAGE_BUSINESS_ERROR', 'Order check does not show manual confirmation.');
  }

  async close(): Promise<void> {
    const close = this.dialog.locator('.el-dialog__headerbtn').first();
    if (await close.isVisible().catch(() => false)) await close.click();
    else await this.page.keyboard.press('Escape');
    await this.dialog.waitFor({ state: 'hidden' });
  }

  async submit(): Promise<void> {
    await this.assertReady();
    const button = this.dialog.getByRole('button', { name: '确认并提交', exact: true });
    if (!await button.isEnabled()) throw new JlcError('PAGE_BUSINESS_ERROR', 'The final test-order submit button is disabled.');
    await button.click();
  }
}
