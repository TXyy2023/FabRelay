import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { MoneyBreakdownSchema, PreviewArtifact } from '../domain/types.js';
import type { z } from 'zod';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject, parseMoney } from './base.js';
import { GerberUploadDialog } from './gerber-upload-dialog.js';
import { OrderCheckDialog } from './order-check-dialog.js';
import { PcbParameterForm } from './pcb-parameter-form.js';

type MoneyBreakdown = z.infer<typeof MoneyBreakdownSchema>;

export class PcbOrderPage extends JlcPageObject {
  readonly upload: GerberUploadDialog;
  readonly parameters: PcbParameterForm;

  constructor(page: Page) {
    super(page);
    this.upload = new GerberUploadDialog(page);
    this.parameters = new PcbParameterForm(page);
  }

  async openAndUpload(filePath: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    await this.upload.open();
    await this.upload.upload(filePath, timeoutMs);
    return await this.parameters.readAnalysis();
  }

  async waitForStablePrice(timeoutMs = 60_000): Promise<MoneyBreakdown> {
    const deadline = Date.now() + timeoutMs;
    let previous: string | undefined;
    let stable = 0;
    while (Date.now() < deadline) {
      const current = await this.readMoneyText().catch(() => undefined);
      if (current && current === previous) stable += 1;
      else stable = 0;
      if (current && stable >= 1) return this.parseBreakdown(current);
      previous = current;
      await this.page.waitForTimeout(500);
    }
    throw new JlcError('TIMEOUT', 'The page price did not produce two consecutive identical reads.', { retryable: true });
  }

  private async readMoneyText(): Promise<string> {
    const details = this.page.getByRole('heading', { name: '价格明细', exact: true }).locator('xpath=following::ul[1]');
    const total = this.page.getByRole('button', { name: /网页版下单/ }).first();
    return `${await details.innerText()}\n总价 ${await total.innerText()}`.replace(/\s+/g, ' ').trim();
  }

  private parseBreakdown(text: string): MoneyBreakdown {
    const valueFor = (label: string): number | undefined => {
      const match = text.match(new RegExp(`${escapeRegExp(label)}\\s*(?:¥|￥)?\\s*([0-9,.]+)`));
      return match ? Number(match[1].replaceAll(',', '')) : undefined;
    };
    const totalText = text.match(/总价[\s\S]*?(?:¥|￥)\s*([0-9\s.]+)/)?.[1]?.replace(/\s+/g, '');
    const total = totalText ? Number(totalText) : parseMoney(text.split('总价').at(-1) ?? '');
    if (total === undefined || !Number.isFinite(total)) throw new JlcError('PAGE_BUSINESS_ERROR', 'The visible total price could not be parsed.');
    return {
      currency: 'CNY',
      pcb: valueFor('PCB') ?? valueFor('特价'),
      extras: sumDefined([
        valueFor('喷镀费'), valueFor('外层铜厚费用'), valueFor('品质赔付费'), valueFor('阻焊覆盖费')
      ]),
      tax: valueFor('产品服务税费') ?? valueFor('税费'),
      shipping: valueFor('快递费') ?? (text.includes('快递费 包邮') ? 0 : undefined),
      discount: valueFor('优惠'),
      total,
      displayText: text
    };
  }

  async openOrderCheck(): Promise<OrderCheckDialog> {
    await this.parameters.assertManualConfirmation();
    await this.contract('check-order button', () => this.page.getByRole('button', { name: '检查订单', exact: true }).click());
    const dialog = new OrderCheckDialog(this.page);
    await dialog.waitForOpen();
    return dialog;
  }

  async captureAnalysis(outputDir: string, gerberHash: string, parameterHash: string): Promise<PreviewArtifact> {
    await mkdir(outputDir, { recursive: true });
    const canvas = this.page.locator('canvas:visible').first();
    if (await canvas.count() > 0) await waitForCanvasPaint(canvas);
    const outputPath = path.join(outputDir, 'jlc-analysis.png');
    const target = await canvas.count() > 0 ? canvas : this.page.getByRole('heading', { name: '基本信息', exact: true }).locator('xpath=ancestor::main[1]');
    await target.screenshot({ path: outputPath }).catch(() => this.page.screenshot({ path: outputPath, fullPage: true }));
    await chmod(outputPath, 0o600);
    return { kind: 'jlc-analysis', path: outputPath, source: 'jlc-page', format: 'png', createdAt: new Date().toISOString() };
  }

  async captureOrderCheck(dialog: OrderCheckDialog, outputDir: string): Promise<PreviewArtifact> {
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'jlc-order-check.png');
    await dialog.dialog.screenshot({ path: outputPath });
    await chmod(outputPath, 0o600);
    return { kind: 'jlc-order-check', path: outputPath, source: 'jlc-page', format: 'png', createdAt: new Date().toISOString() };
  }
}

async function waitForCanvasPaint(canvas: import('playwright').Locator): Promise<void> {
  let previous = '';
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await canvas.evaluate((element) => {
      const value = element as HTMLCanvasElement;
      try { return value.toDataURL().slice(-256); } catch { return `${value.width}x${value.height}`; }
    });
    if (current !== '' && current === previous) stable += 1;
    else stable = 0;
    if (stable >= 1) return;
    previous = current;
    await canvas.page().waitForTimeout(250);
  }
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
