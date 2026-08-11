import { describe, expect, it } from 'vitest';
import {
  MAX_LABEL_LENGTH,
  MAX_MEMO_LENGTH,
  assertActionArgs,
  assertActionGate
} from '../src/workflows/order-actions.js';
import {
  ORDER_ACTION_DEFINITIONS,
  describeActionAvailability,
  resolveActionDefinition
} from '../src/workflows/order-action-registry.js';
import {
  interpretToastResult,
  matchesDefinition,
  redactActionText,
  sanitizeFilename
} from '../src/pages/order-actions-page.js';
import {
  OrderActionResultSchema,
  OrderActionsSnapshotSchema,
  OrderActionIdSchema
} from '../src/domain/types.js';
import { schemaFor } from '../src/schema/index.js';

const ALL_ACTION_IDS = [
  'reorder', 'print_contract', 'delivery_note', 'block_reorder', 'edit_memo',
  'delete_order', 'follow', 'unfollow', 'change_shipping', 'download_qa_certificate',
  'pause_production', 'share_to_yingchuang', 'reselect_template', 'modify_template',
  'add_label', 'remove_label', 'urge_review', 'urge_shipment'
] as const;

describe('order action registry (18 operations)', () => {
  it('registers exactly the 18 required operations with unique ids', () => {
    expect(ORDER_ACTION_DEFINITIONS.map((definition) => definition.id).sort()).toEqual([...ALL_ACTION_IDS].sort());
    expect(new Set(ORDER_ACTION_DEFINITIONS.map((definition) => definition.id)).size).toBe(18);
    for (const id of ALL_ACTION_IDS) {
      expect(OrderActionIdSchema.safeParse(id).success).toBe(true);
      expect(resolveActionDefinition(id).menuLabel.length).toBeGreaterThan(0);
    }
  });

  it('assigns safety tiers: downloads read-only, toggles reversible, destructive writes dangerous', () => {
    const tier = Object.fromEntries(ORDER_ACTION_DEFINITIONS.map((definition) => [definition.id, definition.tier]));
    expect(tier.print_contract).toBe('read');
    expect(tier.delivery_note).toBe('read');
    expect(tier.download_qa_certificate).toBe('read');
    for (const id of ['edit_memo', 'follow', 'unfollow', 'add_label', 'remove_label', 'urge_review', 'urge_shipment', 'share_to_yingchuang'] as const) {
      expect(tier[id]).toBe('reversible-write');
    }
    for (const id of ['reorder', 'block_reorder', 'delete_order', 'change_shipping', 'pause_production', 'reselect_template', 'modify_template'] as const) {
      expect(tier[id]).toBe('dangerous-write');
    }
  });

  it('declares required arguments for parameterized actions', () => {
    expect(resolveActionDefinition('edit_memo').requires).toBe('memo');
    expect(resolveActionDefinition('add_label').requires).toBe('label');
    // remove_label clears ALL labels on the site, so it takes no label argument
    expect(resolveActionDefinition('remove_label').requires).toBeUndefined();
    expect(resolveActionDefinition('change_shipping').requires).toBe('addressId');
    expect(resolveActionDefinition('reorder').requires).toBe('file');
    expect(resolveActionDefinition('urge_review').requires).toBeUndefined();
  });

  it('maps observed menu text to availability without guessing', () => {
    const observed = ['订单详情', '重新上传文件下单', '打印合同', '备忘录', '删除订单', '取消关注', '添加标签', '催审单'];
    const availability = describeActionAvailability(observed);
    const byId = Object.fromEntries(availability.map((item) => [item.id, item]));
    expect(byId.reorder.available).toBe(true);
    expect(byId.print_contract.available).toBe(true);
    expect(byId.edit_memo.available).toBe(true);
    expect(byId.edit_memo.menuLabel).toBe('备忘录');
    expect(byId.delete_order.available).toBe(true);
    expect(byId.unfollow.available).toBe(true);
    expect(byId.add_label.available).toBe(true);
    expect(byId.urge_review.available).toBe(true);
    // 取消关注 must not count as 关注
    expect(byId.follow.available).toBe(false);
    expect(byId.follow.reason).toContain('更多');
    expect(byId.pause_production.available).toBe(false);
  });

  it('matches follow/unfollow labels without cross-contamination', () => {
    const follow = resolveActionDefinition('follow');
    const unfollow = resolveActionDefinition('unfollow');
    expect(matchesDefinition(follow, '关注')).toBe(true);
    expect(matchesDefinition(follow, '关注订单')).toBe(true);
    expect(matchesDefinition(follow, '取消关注')).toBe(false);
    expect(matchesDefinition(unfollow, '取消关注')).toBe(true);
    expect(matchesDefinition(unfollow, '关注')).toBe(false);
  });
});

describe('order action argument validation', () => {
  const base = {};

  it('requires memo text with a bounded length', () => {
    const memo = resolveActionDefinition('edit_memo');
    expect(() => assertActionArgs(memo, base)).toThrow(/--text/);
    expect(() => assertActionArgs(memo, { memo: '   ' })).toThrow(/--text/);
    expect(() => assertActionArgs(memo, { memo: 'x'.repeat(MAX_MEMO_LENGTH + 1) })).toThrow(/at most/);
    expect(() => assertActionArgs(memo, { memo: '加急' })).not.toThrow();
  });

  it('requires label with a bounded length', () => {
    const add = resolveActionDefinition('add_label');
    expect(() => assertActionArgs(add, base)).toThrow(/--label/);
    expect(() => assertActionArgs(add, { label: 'x'.repeat(MAX_LABEL_LENGTH + 1) })).toThrow(/at most/);
    expect(() => assertActionArgs(add, { label: '重点' })).not.toThrow();
  });

  it('requires address id for shipping changes and a file for reorder', () => {
    expect(() => assertActionArgs(resolveActionDefinition('change_shipping'), base)).toThrow(/--address-id/);
    expect(() => assertActionArgs(resolveActionDefinition('change_shipping'), { addressId: 'addr-1' })).not.toThrow();
    expect(() => assertActionArgs(resolveActionDefinition('reorder'), base)).toThrow(/--file/);
    expect(() => assertActionArgs(resolveActionDefinition('reorder'), { file: 'board.zip' })).not.toThrow();
  });
});

describe('order action confirmation gate', () => {
  it('blocks dangerous actions unless --confirm equals the order id', () => {
    const del = resolveActionDefinition('delete_order');
    expect(() => assertActionGate(del, 'JLC123', undefined, true)).toThrow(/--confirm JLC123/);
    expect(() => assertActionGate(del, 'JLC123', 'WRONG', true)).toThrow(/--confirm JLC123/);
    expect(() => assertActionGate(del, 'JLC123', 'JLC123', false)).not.toThrow();
  });

  it('never substitutes interactive consent for a dangerous action', () => {
    const pause = resolveActionDefinition('pause_production');
    expect(() => assertActionGate(pause, 'O1', undefined, true)).toThrow(/APPROVAL|--confirm/);
  });

  it('allows reversible actions with --confirm or interactive consent only', () => {
    const follow = resolveActionDefinition('follow');
    expect(() => assertActionGate(follow, 'O1', 'O1', false)).not.toThrow();
    expect(() => assertActionGate(follow, 'O1', undefined, true)).not.toThrow();
    expect(() => assertActionGate(follow, 'O1', undefined, false)).toThrow(/--confirm O1/);
    expect(() => assertActionGate(follow, 'O1', 'O2', false)).toThrow(/--confirm O1/);
  });

  it('does not gate read-only downloads', () => {
    const cert = resolveActionDefinition('download_qa_certificate');
    expect(() => assertActionGate(cert, 'O1', undefined, false)).not.toThrow();
  });
});

describe('order action result interpretation', () => {
  it('maps toast kind to result status', () => {
    expect(interpretToastResult({ text: '操作成功', kind: 'success' }).status).toBe('succeeded');
    expect(interpretToastResult({ text: '操作失败', kind: 'error' }).status).toBe('failed');
    expect(interpretToastResult({ text: '请稍候', kind: 'info' }).status).toBe('unknown');
    expect(interpretToastResult({}).status).toBe('unknown');
    expect(interpretToastResult({ kind: 'error' }).detail).toContain('rejected');
  });

  it('falls back to toast text when the site omits status classes', () => {
    expect(interpretToastResult({ text: '操作成功', kind: 'info' }).status).toBe('succeeded');
    expect(interpretToastResult({ text: '标签不存在', kind: 'info' }).status).toBe('failed');
    expect(interpretToastResult({ text: '审单员下班了，上班后将优先为您处理审单', kind: 'info' }).status).toBe('unknown');
  });

  it('sanitizes download filenames and redacts sensitive text', () => {
    expect(sanitizeFilename('电子送货单/收据.pdf')).toBe('电子送货单_收据.pdf');
    expect(sanitizeFilename('..\\evil:name*.pdf')).toBe('_evil_name_.pdf');
    expect(sanitizeFilename('')).toBe('jlc-download');
    expect(redactActionText('联系人 13912345678 已通知')).toBe('联系人 1********** 已通知');
    expect(redactActionText('收货地址：广东省深圳市南山区科技园')).toContain('广东***');
  });

  it('parses action snapshots and results through the public schemas', () => {
    const snapshot = OrderActionsSnapshotSchema.parse({
      schemaVersion: 1,
      orderId: 'JLC1',
      rawStatus: '生产中',
      actions: [{ id: 'urge_review', menuLabel: '催审单', tier: 'reversible-write', available: true }],
      capturedAt: new Date().toISOString()
    });
    expect(snapshot.actions[0]?.id).toBe('urge_review');
    const result = OrderActionResultSchema.parse({
      schemaVersion: 1,
      orderId: 'JLC1',
      action: 'edit_memo',
      status: 'succeeded',
      detail: '操作成功',
      artifactPaths: [],
      capturedAt: new Date().toISOString()
    });
    expect(result.artifactPaths).toEqual([]);
    expect(() => OrderActionResultSchema.parse({
      schemaVersion: 1, orderId: 'JLC1', action: 'not_an_action', status: 'succeeded', capturedAt: new Date().toISOString()
    })).toThrow();
  });

  it('publishes the action schemas from the public schema registry', () => {
    expect(schemaFor('orders-actions')).toMatchObject({ type: 'object' });
    expect(schemaFor('order-action')).toMatchObject({ type: 'object' });
    expect(schemaFor('OrderActionsSnapshot')).toMatchObject({ type: 'object' });
    expect(schemaFor('OrderActionResult')).toMatchObject({ type: 'object' });
  });
});
