import path from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import type { Download, Locator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import type { OrderActionId } from '../domain/types.js';
import { JlcPageObject } from './base.js';
import { OrderListPage } from './order-list-page.js';
import { appPaths } from '../config/paths.js';
import { ORDER_ACTION_DEFINITIONS, type OrderActionDefinition } from '../workflows/order-action-registry.js';

export interface OrderActionAttempt {
  status: 'succeeded' | 'failed' | 'unknown';
  detail?: string;
  dialogText?: string;
  artifactPaths: string[];
}

// The order card's 更多操作 trigger opens an el-popover panel whose items are
// .moreOperationLi rows labelled ①…⑱ (see the order list page contract).
const MENU_ITEM_SELECTOR = [
  '.el-popover.myPopoverWrap:visible .moreOperationLi',
  '.el-popper:visible .moreOperationLi',
  '.el-popover.myPopoverWrap:visible li',
  '.el-popper:visible li'
].join(', ');

/**
 * Page object for the order card's 更多操作 popover on the test-site order
 * list. Handles the hover-opened panel, the inner-anchor click contract,
 * disabled (`*` hint) fail-closed behavior, dialogs, downloads, and popup
 * artifacts. Site-specific selectors are grouped in MENU_ITEM_SELECTOR.
 */
export class OrderActionsPage extends JlcPageObject {
  private readonly list: OrderListPage;

  constructor(page: Page) {
    super(page);
    this.list = new OrderListPage(page);
  }

  async open(): Promise<void> {
    await this.list.open();
  }

  async locate(orderId: string): Promise<{ card: Locator; rawStatus: string }> {
    const found = await this.list.find(orderId);
    if (!found) throw new JlcError('PAGE_BUSINESS_ERROR', `Order ${orderId} was not found in the visible order list.`);
    return { card: found.card, rawStatus: found.record.rawStatus };
  }

  async isPresent(orderId: string): Promise<boolean> {
    await this.list.open();
    return (await this.list.find(orderId)) !== undefined;
  }

  definition(action: OrderActionId): OrderActionDefinition {
    const definition = ORDER_ACTION_DEFINITIONS.find((item) => item.id === action);
    if (!definition) throw new JlcError('INVALID_ARGUMENT', `Unknown order action: ${action}`);
    return definition;
  }

  // ---- menu primitives ----

  async visibleMenuTexts(card: Locator): Promise<string[]> {
    await this.openMoreMenu(card);
    const texts = await this.menuItems().evaluateAll((elements) => elements
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean));
    await this.closeMenu();
    return [...new Set(texts)];
  }

  async menuContains(card: Locator, pattern: RegExp): Promise<boolean> {
    const texts = await this.visibleMenuTexts(card);
    return texts.some((text) => pattern.test(text));
  }

  async openMoreMenu(card: Locator): Promise<void> {
    const trigger = await this.moreTrigger(card);
    // The panel is hover-triggered; fall back to click for pointer variants.
    await trigger.hover();
    const opened = await this.menuItems().first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (!opened) {
      await trigger.click();
      await this.menuItems().first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    }
    if (await this.menuItems().count() === 0) {
      throw new JlcError('CONTRACT_DRIFT', 'The 更多操作 trigger was activated but no menu items became visible.');
    }
  }

  async moreTrigger(card: Locator): Promise<Locator> {
    const candidates = [
      card.getByText('更多操作', { exact: true }),
      card.getByRole('button', { name: /^更多/ }),
      card.getByRole('link', { name: /^更多/ }),
      card.locator('span, a, button').filter({ hasText: /^更多/ })
    ];
    for (const candidate of candidates) {
      const first = candidate.first();
      if (await first.count() > 0 && await first.isVisible().catch(() => false)) return first;
    }
    throw new JlcError('CONTRACT_DRIFT', 'The order card has no visible 更多操作 menu trigger.');
  }

  menuItems(): Locator {
    return this.page.locator(MENU_ITEM_SELECTOR);
  }

  async clickMenuItem(card: Locator, definition: OrderActionDefinition): Promise<void> {
    await this.openMoreMenu(card);
    const items = this.menuItems();
    const count = await items.count();
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const text = ((await item.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
      if (!text || !matchesDefinition(definition, text)) continue;
      if (!await item.isVisible().catch(() => false)) continue;
      // The disabled state lives on the inner <a class="... disabled">; a disabled
      // row never accepts the click, so fail fast with the site's own *hint.
      const disabled = await item.evaluate((element) => {
        const anchor = element.querySelector('a');
        const classes = [element.className, anchor?.className].filter((value): value is string => typeof value === 'string');
        return element.hasAttribute('disabled')
          || element.getAttribute('aria-disabled') === 'true'
          || classes.some((value) => /(?:^|\s)(?:is-)?disabled(?:\s|$)/.test(value));
      }).catch(() => false);
      if (disabled) throw new JlcError('PAGE_BUSINESS_ERROR', `The ${definition.menuLabel} action is disabled for this order: ${text}`);
      // The Vue click handler lives on the inner <a class="operationIconName">;
      // clicking the row center misses it.
      const anchor = item.locator('a').first();
      if (await anchor.count() > 0) {
        await anchor.click();
      } else {
        await item.click();
      }
      await this.page.waitForTimeout(250);
      return;
    }
    await this.closeMenu();
    throw new JlcError('PAGE_BUSINESS_ERROR', `The ${definition.menuLabel} action is not available in the visible 更多 menu for this order.`);
  }

  async closeMenu(): Promise<void> {
    // The hover-triggered popover closes on mouse-out.
    await this.page.mouse.move(5, 5).catch(() => undefined);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(200);
  }

  // ---- dialog primitives ----

  async visibleDialog(): Promise<Locator | undefined> {
    const dialog = this.page.locator('.el-message-box:visible, .el-dialog:visible, [role="dialog"]:visible').last();
    if (await dialog.isVisible().catch(() => false)) return dialog;
    return undefined;
  }

  async readDialogText(dialog: Locator): Promise<string> {
    const text = ((await dialog.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    return redactActionText(text).slice(0, 4_000);
  }

  async clickDialogButton(dialog: Locator, pattern: RegExp): Promise<boolean> {
    const button = dialog.getByRole('button', { name: pattern }).first();
    if (await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) {
      await button.click();
      await this.page.waitForTimeout(250);
      return true;
    }
    // Fallbacks: a primary-styled button, then the last footer button that is
    // not 取消 (site dialogs use varied confirm labels).
    const primary = dialog.locator('button.el-button--primary').first();
    if (await primary.isVisible().catch(() => false) && await primary.isEnabled().catch(() => false)) {
      await primary.click();
      await this.page.waitForTimeout(250);
      return true;
    }
    const footerButtons = dialog.locator('.el-dialog__footer button, .dialog-footer button');
    const count = await footerButtons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = footerButtons.nth(index);
      const text = ((await candidate.innerText().catch(() => '')) ?? '').replace(/\s+/g, '').trim();
      if (/取消|关闭/.test(text)) continue;
      if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) {
        await candidate.click();
        await this.page.waitForTimeout(250);
        return true;
      }
    }
    return false;
  }

  async confirmVisibleDialog(): Promise<string | undefined> {
    const dialog = await this.visibleDialog();
    if (!dialog) return undefined;
    const text = await this.readDialogText(dialog);
    const confirmed = await this.clickDialogButton(dialog, /^(?:确定|确认|是的|继续|提交)$/);
    if (!confirmed) {
      await this.closeDialog(dialog);
      throw new JlcError('PAGE_BUSINESS_ERROR', `A confirmation dialog appeared but has no recognizable confirm button: ${text.slice(0, 200)}`);
    }
    return text;
  }

  async maybeConfirmDialog(): Promise<string | undefined> {
    const dialog = await this.visibleDialog();
    if (!dialog) return undefined;
    const text = await this.readDialogText(dialog);
    const clicked = await this.clickDialogButton(dialog, /^(?:确定|确认|是的|继续|提交|打印|下载|导出)$/);
    if (!clicked) await this.closeDialog(dialog);
    return text;
  }

  async closeDialog(dialog: Locator): Promise<void> {
    const close = dialog.locator('.el-dialog__headerbtn, .el-message-box__headerbtn, [aria-label="Close"]').first();
    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => undefined);
    } else {
      await this.page.keyboard.press('Escape').catch(() => undefined);
    }
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  async waitForDialogOpen(timeoutMs = 15_000): Promise<Locator> {
    // Site dialogs leave detached-but-present nodes in the DOM, so only a
    // :visible-filtered locator can wait for the one that actually opened.
    const dialog = this.page.locator('.el-message-box:visible, .el-dialog:visible, [role="dialog"]:visible').last();
    await dialog.waitFor({ state: 'visible', timeout: timeoutMs }).catch((error) => {
      throw new JlcError('CONTRACT_DRIFT', 'The action did not open the expected dialog.', { cause: error });
    });
    return dialog;
  }

  async fillDialogField(dialog: Locator, value: string, description: string): Promise<void> {
    const field = dialog.locator('textarea, input[type="text"], input:not([type])').first();
    if (!await field.isVisible().catch(() => false)) {
      throw new JlcError('CONTRACT_DRIFT', `The dialog has no editable field for ${description}.`);
    }
    await field.fill(value);
    const readback = await field.inputValue();
    if (readback !== value) throw new JlcError('PAGE_BUSINESS_ERROR', `${description} field readback mismatch: ${readback}.`);
  }

  // ---- toast ----

  async readToastResult(timeoutMs = 15_000): Promise<{ text?: string; kind?: 'success' | 'error' | 'info' }> {
    const toast = this.page.locator('.el-message:visible, .el-notification:visible').first();
    await toast.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => undefined);
    if (!await toast.isVisible().catch(() => false)) return {};
    const text = ((await toast.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    const className = await toast.evaluate((element) => typeof element.className === 'string' ? element.className : '').catch(() => '');
    const kind: 'success' | 'error' | 'info' = /success/i.test(className) ? 'success' : /error/i.test(className) ? 'error' : 'info';
    return { text: redactActionText(text), kind };
  }

  // ---- downloads / popups ----

  async captureDownload(trigger: () => Promise<void>, outputDir: string): Promise<string | undefined> {
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: 30_000 }).catch(() => undefined),
      trigger()
    ]);
    if (!download) return undefined;
    return await this.saveDownload(download, outputDir);
  }

  async saveDownload(download: Download, outputDir: string): Promise<string> {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const suggested = sanitizeFilename(download.suggestedFilename() || 'jlc-download');
    const target = path.join(outputDir, suggested);
    await download.saveAs(target);
    await chmod(target, 0o600).catch(() => undefined);
    return target;
  }

  async savePopupArtifact(popup: Page, outputDir: string, baseName: string): Promise<string[]> {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    const artifacts: string[] = [];
    const base = path.join(outputDir, baseName);
    const pdf = await popup.pdf({ path: `${base}.pdf`, format: 'A4' }).then(() => `${base}.pdf`).catch(() => undefined);
    if (pdf) {
      artifacts.push(pdf);
    } else {
      const png = `${base}.png`;
      await popup.screenshot({ path: png, fullPage: true }).catch(() => undefined);
      artifacts.push(png);
    }
    for (const artifact of artifacts) await chmod(artifact, 0o600).catch(() => undefined);
    return artifacts;
  }

  // ---- action handlers ----

  async clickConfirmToast(card: Locator, definition: OrderActionDefinition): Promise<OrderActionAttempt> {
    const dialogText = await this.clickMenuItemAndConfirm(card, definition);
    const toast = await this.readToastResult();
    return interpretToastResult(toast, dialogText);
  }

  async clickMenuItemAndConfirm(card: Locator, definition: OrderActionDefinition): Promise<string | undefined> {
    await this.clickMenuItem(card, definition);
    return await this.confirmVisibleDialog();
  }

  async dialogInput(card: Locator, definition: OrderActionDefinition, value: string, description: string): Promise<OrderActionAttempt> {
    await this.clickMenuItem(card, definition);
    const dialog = await this.waitForDialogOpen();
    await this.fillDialogField(dialog, value, description);
    const dialogText = await this.readDialogText(dialog);
    const confirmed = await this.clickDialogButton(dialog, /^(?:确定|确认|保存|提交)$/);
    if (!confirmed) {
      await this.closeDialog(dialog);
      throw new JlcError('CONTRACT_DRIFT', `The ${description} dialog has no recognizable confirm button.`);
    }
    const toast = await this.readToastResult();
    return interpretToastResult(toast, dialogText);
  }

  async setLabelChecked(card: Locator, definition: OrderActionDefinition, label: string, checked: boolean): Promise<OrderActionAttempt> {
    // The add/remove label dialogs list the account's existing label groups as
    // checkboxes; adding checks the row, removing unchecks it. New groups must
    // be created through 管理标签分组 on the order list page.
    await this.clickMenuItem(card, definition);
    const dialog = await this.waitForDialogOpen();
    const dialogText = await this.readDialogText(dialog);
    const row = dialog.locator('.el-checkbox').filter({ hasText: label }).first();
    if (!await row.isVisible().catch(() => false)) {
      await this.closeDialog(dialog);
      throw new JlcError('PAGE_BUSINESS_ERROR', `The label ${label} is not present in the visible label dialog; create it via 管理标签分组 first.`);
    }
    const isChecked = await row.evaluate((element) => element.classList.contains('is-checked')
      || Boolean(element.querySelector('.is-checked'))).catch(() => false);
    if (isChecked !== checked) {
      await row.click();
      await this.page.waitForTimeout(200);
    }
    const confirmed = await this.clickDialogButton(dialog, /^(?:确定|确认|保存|提交)$/);
    if (!confirmed) {
      await this.closeDialog(dialog);
      throw new JlcError('CONTRACT_DRIFT', 'The label dialog has no recognizable confirm button.');
    }
    const toast = await this.readToastResult();
    return interpretToastResult(toast, dialogText);
  }

  async changeShipping(card: Locator, definition: OrderActionDefinition, addressId: string): Promise<OrderActionAttempt> {
    await this.clickMenuItem(card, definition);
    const dialog = await this.waitForDialogOpen();
    const dialogText = await this.readDialogText(dialog);
    const escaped = addressId.replaceAll('"', '\\"');
    let candidate = dialog.locator(`[data-id="${escaped}"], [data-value="${escaped}"], [value="${escaped}"]`).first();
    if (!await candidate.isVisible().catch(() => false)) {
      candidate = dialog.getByText(addressId, { exact: true }).first();
    }
    if (!await candidate.isVisible().catch(() => false)) {
      await this.closeDialog(dialog);
      throw new JlcError('CONTRACT_DRIFT', `Address ${addressId} is not present in the visible shipping dialog.`);
    }
    await candidate.click();
    await this.page.waitForTimeout(200);
    const confirmed = await this.clickDialogButton(dialog, /^(?:确定|确认|保存|使用此地址)$/);
    if (!confirmed) {
      await this.closeDialog(dialog);
      throw new JlcError('CONTRACT_DRIFT', 'The shipping dialog has no recognizable confirm button.');
    }
    const toast = await this.readToastResult();
    return interpretToastResult(toast, dialogText);
  }

  async downloadAction(card: Locator, definition: OrderActionDefinition, outputDir: string): Promise<OrderActionAttempt> {
    const first = await this.captureDownload(async () => {
      await this.clickMenuItem(card, definition);
      await this.maybeConfirmDialog();
    }, outputDir);
    if (first) return { status: 'succeeded', detail: `Saved ${path.basename(first)}`, artifactPaths: [first] };
    const dialog = await this.visibleDialog();
    if (dialog) {
      const dialogText = await this.readDialogText(dialog);
      const downloadPromise = this.page.waitForEvent('download', { timeout: 30_000 }).catch(() => undefined);
      const clicked = await this.clickDialogButton(dialog, /^(?:下载|导出|Download)$/);
      if (clicked) {
        const download = await downloadPromise;
        if (download) {
          const saved = await this.saveDownload(download, outputDir);
          return { status: 'succeeded', detail: `Saved ${path.basename(saved)}`, dialogText, artifactPaths: [saved] };
        }
      }
      await this.closeDialog(dialog);
      return { status: 'unknown', dialogText, detail: 'A dialog appeared but no file download followed.', artifactPaths: [] };
    }
    return { status: 'unknown', detail: 'No download or dialog appeared after the menu action.', artifactPaths: [] };
  }

  async contractAction(card: Locator, definition: OrderActionDefinition, outputDir: string): Promise<OrderActionAttempt> {
    const popupPromise = this.page.context().waitForEvent('page', { timeout: 30_000 }).catch(() => undefined);
    const download = await this.captureDownload(async () => {
      await this.clickMenuItem(card, definition);
      await this.maybeConfirmDialog();
    }, outputDir);
    if (download) return { status: 'succeeded', detail: `Saved ${path.basename(download)}`, artifactPaths: [download] };
    const popup = await popupPromise;
    if (popup) {
      const artifacts = await this.savePopupArtifact(popup, outputDir, 'contract-page');
      await popup.close().catch(() => undefined);
      if (artifacts.length > 0) {
        return { status: 'succeeded', detail: `Captured the contract page (${artifacts.map((item) => path.basename(item)).join(', ')})`, artifactPaths: artifacts };
      }
    }
    return { status: 'unknown', detail: 'No download or popup page appeared after 打印合同.', artifactPaths: [] };
  }

  async templateAction(card: Locator, definition: OrderActionDefinition, template: string | undefined): Promise<OrderActionAttempt> {
    await this.clickMenuItem(card, definition);
    let dialog: Locator;
    try {
      dialog = await this.waitForDialogOpen(8_000);
    } catch {
      return {
        status: 'unknown',
        detail: `The ${definition.menuLabel} action navigated away from the order list without a dialog. Current URL: ${this.page.url()}. No change was confirmed.`,
        artifactPaths: []
      };
    }
    const dialogText = await this.readDialogText(dialog);
    if (!template) {
      await this.closeDialog(dialog);
      return {
        status: 'unknown',
        dialogText,
        detail: 'Pass --template <visible template name> to choose a template; nothing was changed.',
        artifactPaths: []
      };
    }
    const option = dialog.locator('li, .el-radio, .el-radio__label, label, span, div, td').filter({ hasText: template }).first();
    if (!await option.isVisible().catch(() => false)) {
      await this.closeDialog(dialog);
      throw new JlcError('PAGE_BUSINESS_ERROR', `Template ${template} is not visible in the template dialog.`);
    }
    await option.click();
    await this.page.waitForTimeout(200);
    const confirmed = await this.clickDialogButton(dialog, /^(?:确定|确认|保存|提交)$/);
    if (!confirmed) {
      await this.closeDialog(dialog);
      throw new JlcError('CONTRACT_DRIFT', 'The template dialog has no recognizable confirm button.');
    }
    const toast = await this.readToastResult();
    return interpretToastResult(toast, dialogText);
  }

  async modifyTemplateAction(card: Locator, definition: OrderActionDefinition, text: string | undefined): Promise<OrderActionAttempt> {
    await this.clickMenuItem(card, definition);
    let dialog: Locator;
    try {
      dialog = await this.waitForDialogOpen(8_000);
    } catch {
      return {
        status: 'unknown',
        detail: `The ${definition.menuLabel} action navigated away from the order list without a dialog. Current URL: ${this.page.url()}. No change was confirmed.`,
        artifactPaths: []
      };
    }
    const dialogText = await this.readDialogText(dialog);
    if (!text) {
      await this.closeDialog(dialog);
      return {
        status: 'unknown',
        dialogText,
        detail: 'Pass --text <new template content> to modify the template; nothing was changed.',
        artifactPaths: []
      };
    }
    await this.fillDialogField(dialog, text, '模板内容');
    const confirmed = await this.clickDialogButton(dialog, /^(?:确定|确认|保存|提交)$/);
    if (!confirmed) {
      await this.closeDialog(dialog);
      throw new JlcError('CONTRACT_DRIFT', 'The modify-template dialog has no recognizable confirm button.');
    }
    const toast = await this.readToastResult();
    return interpretToastResult(toast, dialogText);
  }

  async reorderWithNewFile(card: Locator, definition: OrderActionDefinition, file: string): Promise<OrderActionAttempt> {
    const dialogText = await this.clickMenuItemAndConfirm(card, definition);
    const input = this.page.locator('input[type="file"]').last();
    await input.waitFor({ state: 'attached', timeout: 30_000 }).catch((error) => {
      throw new JlcError('CONTRACT_DRIFT', '重新上传文件下单 did not present a file input.', { cause: error });
    });
    await input.setInputFiles(file);
    await this.page.locator('.el-loading-mask:visible, .is-loading:visible').waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    const fileName = path.basename(file);
    const accepted = bodyText.includes(fileName) || /上传成功|解析成功|已上传/.test(bodyText);
    return {
      status: accepted ? 'succeeded' : 'unknown',
      detail: accepted
        ? `File ${fileName} was accepted by the reorder flow. The order was NOT resubmitted; review and confirm through the normal order workflow.`
        : `The file input accepted ${fileName}, but no visible confirmation could be read. The order was NOT resubmitted.`,
      dialogText,
      artifactPaths: []
    };
  }

  resolveOutputDir(explicit?: string): string {
    return path.resolve(explicit ?? path.join(appPaths.downloadsDir, 'order-actions'));
  }
}

export function matchesDefinition(definition: OrderActionDefinition, text: string): boolean {
  if (definition.excludes?.some((pattern) => pattern.test(text))) return false;
  return definition.patterns.some((pattern) => pattern.test(text));
}

export function interpretToastResult(
  toast: { text?: string; kind?: 'success' | 'error' | 'info' },
  dialogText?: string
): OrderActionAttempt {
  // The site's toast classes are unreliable; the text is the authoritative signal.
  const failedByText = toast.text ? /失败|错误|无法|不能|不存在/.test(toast.text) : false;
  const succeededByText = toast.text ? /成功|已完成/.test(toast.text) && !failedByText : false;
  if (toast.kind === 'success' || succeededByText) {
    return { status: 'succeeded', detail: toast.text, dialogText, artifactPaths: [] };
  }
  if (toast.kind === 'error' || failedByText) {
    return { status: 'failed', detail: toast.text ?? 'The page rejected the action.', dialogText, artifactPaths: [] };
  }
  if (toast.text) {
    return { status: 'unknown', detail: toast.text, dialogText, artifactPaths: [] };
  }
  return { status: 'unknown', detail: 'No visible toast or message readback after the action.', dialogText, artifactPaths: [] };
}

export function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'jlc-download';
}

export function redactActionText(text: string): string {
  return text
    .replace(/\b1\d{10}\b/g, '1**********')
    .replace(/([一-龥]{2})[一-龥]+(?=省|市|区|县|路|街)/g, '$1***');
}
