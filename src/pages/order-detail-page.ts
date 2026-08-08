import type { Locator, Page } from 'playwright';
import { JlcPageObject } from './base.js';
import { PAGE_CONTRACTS } from './contracts.js';

export class OrderDetailPage extends JlcPageObject {
  readonly dialog: Locator;

  constructor(page: Page) {
    super(page);
    this.dialog = page.locator(PAGE_CONTRACTS.orderDetailsDialog).first();
  }

  async waitForOpen(): Promise<void> {
    await this.contract('PCB order details dialog', () => this.dialog.waitFor({ state: 'visible' }));
  }

  async summary(): Promise<Record<string, string>> {
    await this.waitForOpen();
    const values = await this.dialog.locator('tr').evaluateAll((rows) => rows.map((row) => {
      const header = row.querySelector('th')?.textContent?.replace(/\s+/g, ' ').trim().replace(/：$/, '');
      const cell = row.querySelector('td')?.textContent?.replace(/\s+/g, ' ').trim();
      return header && cell ? [header, cell] : undefined;
    }).filter((item): item is [string, string] => Boolean(item)));
    return Object.fromEntries(values);
  }

  async close(): Promise<void> {
    await this.dialog.locator('.el-dialog__headerbtn').first().click();
    await this.dialog.waitFor({ state: 'hidden' });
  }
}
