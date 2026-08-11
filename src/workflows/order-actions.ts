/**
 * Orchestration for the 18 order operations: argument validation, the
 * confirmation gate (see order-action-registry.ts tiers), browser dispatch, and
 * post-action readback verification (delete re-queries the list; follow/unfollow
 * re-read the menu's *hint suffix). All results are fail-closed: anything the
 * page does not positively confirm stays `unknown` rather than `succeeded`.
 */
import { stat } from 'node:fs/promises';
import { stdin, stderr, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Locator } from 'playwright';
import { JlcError } from '../domain/errors.js';
import {
  OrderActionResultSchema,
  OrderActionsSnapshotSchema,
  SCHEMA_VERSION,
  type OrderActionId,
  type OrderActionResult,
  type OrderActionsSnapshot
} from '../domain/types.js';
import { LoginPage } from '../pages/login-page.js';
import { OrderActionsPage, type OrderActionAttempt } from '../pages/order-actions-page.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';
import { describeActionAvailability, resolveActionDefinition, type OrderActionDefinition } from './order-action-registry.js';

export interface OrderActionRunOptions extends BrowserSessionOptions {
  confirm?: string;
  memo?: string;
  label?: string;
  addressId?: string;
  template?: string;
  text?: string;
  file?: string;
  outputDir?: string;
  /** Injectable for tests; defaults to TTY detection. */
  interactive?: boolean;
}

// The test site's memo textarea is maxlength=100; labels are short free text.
export const MAX_MEMO_LENGTH = 100;
export const MAX_LABEL_LENGTH = 50;

export function assertActionArgs(definition: OrderActionDefinition, options: OrderActionRunOptions): void {
  switch (definition.requires) {
    case 'memo': {
      if (!options.memo?.trim()) throw new JlcError('INVALID_ARGUMENT', `Action ${definition.id} requires --text <memo content>.`);
      if (options.memo.trim().length > MAX_MEMO_LENGTH) throw new JlcError('INVALID_ARGUMENT', `Memo text must be at most ${MAX_MEMO_LENGTH} characters.`);
      return;
    }
    case 'label': {
      if (!options.label?.trim()) throw new JlcError('INVALID_ARGUMENT', `Action ${definition.id} requires --label <label>.`);
      if (options.label.trim().length > MAX_LABEL_LENGTH) throw new JlcError('INVALID_ARGUMENT', `Label must be at most ${MAX_LABEL_LENGTH} characters.`);
      return;
    }
    case 'addressId': {
      if (!options.addressId?.trim()) throw new JlcError('INVALID_ARGUMENT', `Action ${definition.id} requires --address-id <visible address id>.`);
      return;
    }
    case 'file': {
      if (!options.file?.trim()) throw new JlcError('INVALID_ARGUMENT', `Action ${definition.id} requires --file <gerber.zip>.`);
      return;
    }
    default:
      return;
  }
}

export function assertActionGate(definition: OrderActionDefinition, orderId: string, confirm: string | undefined, interactiveAllowed: boolean): void {
  if (definition.tier === 'dangerous-write') {
    if (confirm !== orderId) {
      throw new JlcError('APPROVAL_REQUIRED', `Dangerous order action ${definition.id} (${definition.menuLabel}) requires \`--confirm ${orderId}\`. Nothing was executed.`);
    }
    return;
  }
  if (definition.tier === 'reversible-write') {
    if (confirm === orderId) return;
    if (interactiveAllowed) return;
    throw new JlcError('APPROVAL_REQUIRED', `Order action ${definition.id} (${definition.menuLabel}) requires \`--confirm ${orderId}\` or an interactive confirmation. Nothing was executed.`);
  }
}

export async function listOrderActions(orderId: string, options: BrowserSessionOptions = {}): Promise<OrderActionsSnapshot> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const actions = new OrderActionsPage(session.page);
    await actions.open();
    const { card, rawStatus } = await actions.locate(orderId);
    const texts = await actions.visibleMenuTexts(card);
    return OrderActionsSnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      orderId,
      rawStatus,
      actions: describeActionAvailability(texts),
      capturedAt: new Date().toISOString()
    });
  });
}

export async function runOrderAction(orderId: string, action: OrderActionId, options: OrderActionRunOptions = {}): Promise<OrderActionResult> {
  const definition = resolveActionDefinition(action);
  assertActionArgs(definition, options);
  if (definition.requires === 'file') {
    const info = await stat(options.file!).catch(() => undefined);
    if (!info?.isFile()) throw new JlcError('INVALID_ARGUMENT', `--file does not point to an existing file: ${options.file}`);
  }
  const interactive = options.interactive ?? (stdin.isTTY === true && stdout.isTTY === true);
  let interactiveAllowed = false;
  if (definition.tier === 'reversible-write' && options.confirm !== orderId && interactive) {
    interactiveAllowed = await confirmInteractively(definition, orderId);
  }
  assertActionGate(definition, orderId, options.confirm, interactiveAllowed);

  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const page = new OrderActionsPage(session.page);
    await page.open();
    const { card, rawStatus } = await page.locate(orderId);
    const outputDir = page.resolveOutputDir(options.outputDir);
    const attempt = await executeOrderAction(page, card, definition, options, outputDir);
    const verified = await verifyAttempt(page, orderId, definition, attempt);
    return OrderActionResultSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      orderId,
      action,
      status: verified.status,
      detail: verified.detail,
      dialogText: verified.dialogText,
      artifactPaths: verified.artifactPaths,
      rawStatus,
      capturedAt: new Date().toISOString()
    });
  });
}

async function executeOrderAction(
  page: OrderActionsPage,
  card: Locator,
  definition: OrderActionDefinition,
  options: OrderActionRunOptions,
  outputDir: string
): Promise<OrderActionAttempt> {
  switch (definition.id) {
    case 'edit_memo':
      return await page.dialogInput(card, definition, options.memo!.trim(), '备忘录');
    case 'add_label':
      return await page.setLabelChecked(card, definition, options.label!.trim(), true);
    case 'remove_label':
      // Site semantics: clears every label on the order after a confirm box.
      return await page.clickConfirmToast(card, definition);
    case 'change_shipping':
      return await page.changeShipping(card, definition, options.addressId!.trim());
    case 'print_contract':
      return await page.contractAction(card, definition, outputDir);
    case 'delivery_note':
    case 'download_qa_certificate':
      return await page.downloadAction(card, definition, outputDir);
    case 'reselect_template':
      return await page.templateAction(card, definition, options.template);
    case 'modify_template':
      return await page.modifyTemplateAction(card, definition, options.text);
    case 'reorder':
      return await page.reorderWithNewFile(card, definition, options.file!);
    default:
      return await page.clickConfirmToast(card, definition);
  }
}

async function verifyAttempt(
  page: OrderActionsPage,
  orderId: string,
  definition: OrderActionDefinition,
  attempt: OrderActionAttempt
): Promise<OrderActionAttempt> {
  if (attempt.status === 'failed') return attempt;
  if (definition.id === 'delete_order') {
    // The server delete is async; give it a moment before the list readback.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const present = await page.isPresent(orderId).catch(() => true);
    if (!present) {
      return { ...attempt, status: 'succeeded', detail: `${attempt.detail ?? ''} The order no longer appears in the visible order list.`.trim() };
    }
    return attempt.status === 'succeeded'
      ? { ...attempt, status: 'unknown', detail: 'The page reported success, but the order is still visible in the list.' }
      : attempt;
  }
  if (definition.id === 'follow' || definition.id === 'unfollow') {
    // The menu always lists both 关注 and 取消关注; the actionable state shows
    // as a *hint suffix (e.g. ⑧取消关注订单*未关注订单才可操作), so verify via it.
    const located = await page.locate(orderId).catch(() => undefined);
    if (!located) return attempt;
    const texts = await page.visibleMenuTexts(located.card).catch(() => []);
    const unfollowText = texts.find((text) => /取消关注/.test(text));
    if (!unfollowText) return attempt;
    const stillUnfollowed = /未关注/.test(unfollowText);
    const toggled = definition.id === 'follow' ? !stillUnfollowed : stillUnfollowed;
    if (toggled) return { ...attempt, status: 'succeeded', detail: attempt.detail ?? 'The visible menu hint confirms the follow state.' };
    return attempt.status === 'succeeded'
      ? { ...attempt, status: 'unknown', detail: 'The menu hint suggests the follow state did not change.' }
      : attempt;
  }
  return attempt;
}

async function confirmInteractively(definition: OrderActionDefinition, orderId: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = (await prompt.question(`即将对订单 ${orderId} 执行「${definition.menuLabel}」。输入 是 继续：`)).trim();
    return /^(?:是|y|yes)$/i.test(answer);
  } finally {
    prompt.close();
  }
}
