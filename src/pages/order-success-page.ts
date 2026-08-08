import type { Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject } from './base.js';

export class OrderSuccessPage extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async waitForSuccess(timeoutMs = 120_000): Promise<{ orderId: string; url: string; title: string }> {
    await Promise.race([
      this.page.waitForURL(/(?:success|produceOrderAccessId)/i, { timeout: timeoutMs }),
      this.page.getByText(/下单成功|订单提交成功/).first().waitFor({ state: 'visible', timeout: timeoutMs })
    ]).catch((error) => {
      throw new JlcError('ORDER_UNKNOWN', 'Submission was clicked but no authoritative success state appeared. Reconciliation is required.', { retryable: true, cause: error });
    });
    const url = this.page.url();
    const title = await this.page.title();
    const fromUrl = new URL(url).searchParams.get('produceOrderAccessId')
      ?? new URL(url).searchParams.get('orderId')
      ?? url.match(/[?#&](?:produceOrderAccessId|orderId)=([^&#]+)/i)?.[1];
    const text = await this.page.locator('body').innerText();
    const fromText = text.match(/(?:订单编号|订单号|订单ID)\s*[：:]?\s*([A-Za-z0-9_-]+)/)?.[1];
    const orderId = fromUrl ?? fromText;
    if (!orderId) throw new JlcError('ORDER_UNKNOWN', 'The success page is visible but no order ID could be read.', { retryable: true });
    return { orderId, url, title };
  }
}
