import type { Locator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject, parseMoney } from './base.js';

const PAYMENT_WORDS = /付款|支付|余额|应付金额|支付金额/;

export class OrderPaymentPage extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async open(paymentButton: Locator): Promise<void> {
    await this.contract('order payment action', () => paymentButton.click());
    await this.page.waitForTimeout(300);
    for (let step = 0; step < 3; step += 1) {
      if (await this.paymentSurfaceVisible()) return;
      const dialog = this.page.getByRole('dialog').last();
      if (!await dialog.isVisible().catch(() => false)) break;
      const text = await dialog.innerText();
      if (!/确认|订单|付款|支付/.test(text)) break;
      const confirm = dialog.getByRole('button', { name: /^(?:确定|确认|继续|去付款)$/ }).last();
      if (!await confirm.isVisible().catch(() => false) || !await confirm.isEnabled().catch(() => false)) break;
      await confirm.click();
      await this.page.waitForTimeout(400);
    }
    if (!await this.paymentSurfaceVisible()) {
      throw new JlcError('CONTRACT_DRIFT', 'The order payment action did not open a readable payment surface.');
    }
  }

  async selectBalance(): Promise<void> {
    const surface = await this.paymentSurface();
    const controls = [
      surface.getByRole('radio', { name: /余额/ }).first(),
      surface.getByRole('button', { name: /余额支付|账户余额/ }).first(),
      surface.getByText(/余额支付|账户余额/, { exact: true }).first()
    ];
    for (const control of controls) {
      if (!await control.isVisible().catch(() => false)) continue;
      const disabled = !await control.isEnabled().catch(() => true);
      if (disabled) throw new JlcError('PAGE_BUSINESS_ERROR', 'Balance payment is visible but unavailable for this order.');
      await control.click();
      await this.page.waitForTimeout(150);
      return;
    }
    const text = await surface.innerText();
    if (!/余额/.test(text)) throw new JlcError('CONTRACT_DRIFT', 'The payment page does not expose the required balance-payment method.');
  }

  async amount(): Promise<number> {
    const text = (await (await this.paymentSurface()).innerText()).replace(/,/g, ' ');
    return parseVisiblePaymentAmount(text);
  }

  async submit(): Promise<void> {
    const surface = await this.paymentSurface();
    const final = surface.getByRole('button', { name: /^(?:确认支付|立即支付|余额支付|确认付款|立即付款)$/ }).last();
    if (!await final.isVisible().catch(() => false) || !await final.isEnabled().catch(() => false)) {
      throw new JlcError('CONTRACT_DRIFT', 'No enabled final payment button is visible.');
    }
    await final.click();
    await this.page.waitForTimeout(300);
    const confirmation = this.page.getByRole('dialog').last();
    if (await confirmation.isVisible().catch(() => false)) {
      const text = await confirmation.innerText();
      if (/余额|支付|付款/.test(text)) {
        const confirm = confirmation.getByRole('button', { name: /^(?:确定|确认支付|立即支付)$/ }).last();
        if (await confirm.isVisible().catch(() => false) && await confirm.isEnabled().catch(() => false)) await confirm.click();
      }
    }
  }

  async waitForResult(timeoutMs = 120_000): Promise<string> {
    const success = this.page.getByText(/支付成功|付款成功|扣款成功/).first();
    await success.waitFor({ state: 'visible', timeout: timeoutMs }).catch((error) => {
      throw new JlcError('ORDER_UNKNOWN', 'Payment was submitted but no authoritative success state appeared. Reconciliation is required before retrying.', {
        retryable: true,
        cause: error
      });
    });
    return (await success.innerText()).trim();
  }

  private async paymentSurfaceVisible(): Promise<boolean> {
    if (/pay|payment/i.test(this.page.url())) return true;
    const final = this.page.getByRole('button', { name: /^(?:确认支付|立即支付|余额支付|确认付款|立即付款)$/ }).last();
    if (await final.isVisible().catch(() => false)) return true;
    const dialogs = this.page.getByRole('dialog');
    for (let index = await dialogs.count() - 1; index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      if (await dialog.isVisible().catch(() => false) && PAYMENT_WORDS.test(await dialog.innerText().catch(() => ''))) return true;
    }
    return false;
  }

  private async paymentSurface(): Promise<Locator> {
    const dialogs = this.page.getByRole('dialog');
    for (let index = await dialogs.count() - 1; index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      if (await dialog.isVisible().catch(() => false) && PAYMENT_WORDS.test(await dialog.innerText().catch(() => ''))) return dialog;
    }
    return this.page.locator('body');
  }
}

export function parseVisiblePaymentAmount(text: string): number {
    for (const label of ['应付金额', '支付金额', '订单金额', '实付金额', '合计']) {
      const match = text.match(new RegExp(`${label}[^\\d\uffe5\u00a5]{0,20}[\uffe5\u00a5]?\\s*([0-9]+(?:\\.[0-9]+)?)`));
      if (match) return Number(match[1]);
    }
    const amounts = [...text.matchAll(/[￥¥]\s*([0-9]+(?:\.[0-9]+)?)/g)].map((match) => Number(match[1]));
    const parsed = amounts.at(-1) ?? parseMoney(text);
    if (parsed === undefined || !Number.isFinite(parsed)) throw new JlcError('CONTRACT_DRIFT', 'The payment amount could not be read back from the visible page.');
    return parsed;
}
