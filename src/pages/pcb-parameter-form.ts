import type { Locator, Page } from 'playwright';
import type { BrowserOption, PcbSpec } from '../domain/types.js';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject } from './base.js';

const fixedOptionMap: Array<{ key: keyof PcbSpec; label: string; display: (value: unknown) => string }> = [
  { key: 'material', label: '板材类别', display: String },
  { key: 'layerCount', label: '板子层数', display: String },
  { key: 'boardThicknessMm', label: '成品板厚', display: String },
  { key: 'copperWeightOz', label: '外层铜厚', display: (value) => `${value}盎司` },
  { key: 'solderMaskColor', label: '阻焊颜色', display: String },
  { key: 'silkscreenColor', label: '字符颜色', display: String },
  { key: 'surfaceFinish', label: '焊盘喷镀', display: String },
  { key: 'viaTreatment', label: '阻焊覆盖', display: String },
  { key: 'impedanceControl', label: '阻抗管控', display: String }
];

export class PcbParameterForm extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async readAnalysis(): Promise<Record<string, unknown>> {
    const [length, width, quantity] = await Promise.all([
      this.page.getByPlaceholder('长').inputValue(),
      this.page.getByPlaceholder('宽').inputValue(),
      this.page.getByPlaceholder('数量').inputValue()
    ]);
    const layerContainer = await this.fieldContainer('板子层数');
    const selectedLayer = await selectedButtonText(layerContainer);
    const warnings = await this.page.getByText(/警告|异常|无法识别|文件有问题/).allTextContents();
    return { length, width, quantity, layerCount: Number(selectedLayer), warnings: warnings.map((value) => value.trim()).filter(Boolean) };
  }

  async apply(spec: PcbSpec): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const mapping of fixedOptionMap) {
      const value = spec[mapping.key];
      if (value === undefined) continue;
      result[mapping.key] = await this.selectButton(mapping.label, mapping.display(value));
      await this.waitForSettled();
    }

    if (spec.quantity !== undefined) {
      const input = this.page.getByPlaceholder('数量');
      await input.fill(String(spec.quantity));
      await input.press('Tab');
      await this.waitForSettled();
      const actual = await input.inputValue();
      if (actual !== String(spec.quantity)) throw new JlcError('PAGE_BUSINESS_ERROR', `Quantity readback mismatch: ${actual}.`);
      result.quantity = actual;
    }

    for (const [key, value] of Object.entries(spec.processOptions)) {
      result[`processOptions.${key}`] = await this.selectButton(key, String(value));
      await this.waitForSettled();
    }

    result.confirmationMode = await this.selectButton('确认订单方式', '手动确认订单');
    result.smt = await this.selectButton('是否SMT贴片', '不需要');
    result.stencil = await this.selectButton('是否开钢网', '不需要');

    if (spec.delivery) {
      const delivery = this.page.getByText(spec.delivery, { exact: true }).first();
      await this.contract(`delivery ${spec.delivery}`, () => delivery.click());
      await this.waitForSettled();
      result.delivery = (await delivery.innerText()).trim();
    }
    if (spec.addressId) { await this.selectByInternalId('收货地址', spec.addressId); result.addressId = maskedInternalId(spec.addressId); }
    if (spec.contactId) { await this.selectByInternalId('联系方式', spec.contactId); result.contactId = maskedInternalId(spec.contactId); }
    if (spec.shippingMethodId) result.shippingMethodId = await this.selectByInternalId('选择快递', spec.shippingMethodId);
    await this.assertManualConfirmation();
    return result;
  }

  private async selectByInternalId(label: string, id: string): Promise<string> {
    const escaped = id.replaceAll('"', '\\"');
    const selector = `[data-id="${escaped}"], [data-value="${escaped}"], [value="${escaped}"]`;
    let candidate = this.page.locator(selector).first();
    if (await candidate.count() === 0 || !await candidate.isVisible().catch(() => false)) {
      const labelNode = this.page.getByText(label, { exact: true }).first();
      const section = labelNode.locator('xpath=ancestor::div[.//*[normalize-space()="修改"]][1]');
      const modify = section.getByText('修改', { exact: true }).first();
      if (await modify.isVisible().catch(() => false)) {
        await modify.click();
        await this.page.getByRole('dialog').last().waitFor({ state: 'visible' }).catch(() => undefined);
      }
      candidate = this.page.locator(selector).first();
    }
    if (await candidate.count() === 0) {
      candidate = this.page.getByText(id, { exact: true }).first();
    }
    if (await candidate.count() === 0 || !await candidate.isVisible().catch(() => false)) {
      throw new JlcError('CONTRACT_DRIFT', `${label} internal ID ${id} is not present in the page or its selection dialog.`);
    }
    await candidate.click();
    const dialog = this.page.getByRole('dialog').last();
    if (await dialog.isVisible().catch(() => false)) {
      const confirm = dialog.getByRole('button', { name: /^(?:确定|确认|使用此地址)$/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    }
    await this.waitForSettled();
    return (await candidate.innerText().catch(() => id)).trim() || id;
  }

  async assertManualConfirmation(): Promise<void> {
    const container = await this.fieldContainer('确认订单方式');
    const manual = container.getByRole('button', { name: '手动确认订单', exact: true }).first();
    const selected = await manual.evaluate((element) => typeof element.className === 'string' && element.className.split(/\s+/).includes('checked'));
    if (!selected) throw new JlcError('PAGE_BUSINESS_ERROR', 'Manual order confirmation is not selected. Submission is blocked.');
  }

  async options(): Promise<BrowserOption[]> {
    return (await this.optionsWithAvailability()).options;
  }

  async optionsWithAvailability(): Promise<{ options: BrowserOption[]; unavailableGroups: string[] }> {
    const groups = ['板材类别', '板子层数', '成品板厚', '外层铜厚', '阻抗管控', '阻焊颜色', '字符颜色', '阻焊覆盖', '焊盘喷镀', '确认订单方式', '是否SMT贴片', '是否开钢网'];
    const output: BrowserOption[] = [];
    const unavailableGroups: string[] = [];
    for (const group of groups) {
      const container = await this.optionalFieldContainer(group);
      if (!container) {
        unavailableGroups.push(group);
        continue;
      }
      const values = await container.locator('button').evaluateAll((buttons) => buttons.map((button) => {
        const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
        const className = typeof button.className === 'string' ? button.className : '';
        return {
          value: button.getAttribute('data-value') ?? text,
          displayText: text,
          disabled: button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true',
          selected: /(?:^|\s)(?:checked|active|selected|is-active)(?:\s|$)/.test(className),
          priceText: text.match(/(?:加|收费|￥|¥).*/)?.[0]
        };
      }).filter((item) => item.displayText));
      output.push(...values.map((value) => ({ group, ...value })));
    }
    const dynamic = await this.page.locator('[data-id], [data-value]').evaluateAll((elements) => elements.map((element) => {
      const value = element.getAttribute('data-id') ?? element.getAttribute('data-value') ?? '';
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      const context = (element.parentElement?.parentElement?.textContent ?? '').replace(/\s+/g, ' ');
      const group = /收货地址/.test(context) ? '收货地址'
        : /联系方式|联系人/.test(context) ? '联系方式'
          : /快递/.test(context) ? '选择快递'
            : /交期/.test(context) ? '交期' : undefined;
      const className = typeof element.className === 'string' ? element.className : '';
      return group && value && text ? {
        group,
        value,
        displayText: text.replace(/1\d{2}\d{4}\d{4}/g, '1**********').replace(/([\u4e00-\u9fa5]{2})[\u4e00-\u9fa5]+(?=省|市|区|县|路|街)/g, '$1***'),
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        selected: /(?:^|\s)(?:checked|active|selected|is-active)(?:\s|$)/.test(className)
      } : undefined;
    }).filter((item): item is { group: string; value: string; displayText: string; disabled: boolean; selected: boolean } => Boolean(item)));
    const seen = new Set(output.map((item) => `${item.group}\0${item.value}`));
    for (const item of dynamic) {
      const key = `${item.group}\0${item.value}`;
      if (!seen.has(key)) { output.push(item); seen.add(key); }
    }
    return { options: output, unavailableGroups };
  }

  private async waitForSettled(): Promise<void> {
    const loading = this.page.locator('.el-loading-mask:visible, .is-loading:visible');
    await loading.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);
    await this.page.waitForTimeout(120);
  }
}

function maskedInternalId(value: string): string {
  return `<configured:***${value.slice(-4)}>`;
}

async function selectedButtonText(container: Locator): Promise<string | undefined> {
  return await container.locator('button.checked, button.active, button.selected, button.is-active').first().innerText().catch(() => undefined);
}
