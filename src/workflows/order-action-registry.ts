/**
 * Registry of the 18 order "更多操作" supported by the test-site order list.
 *
 * Each entry maps a stable action id to the Chinese menu label patterns seen in
 * the 更多操作 popover, a safety tier, and any required argument:
 * - `read`             : exports/downloads; no confirmation needed.
 * - `reversible-write` : follow/memo/labels/urge/share; interactive confirmation
 *                        or `--confirm <order-id>` required.
 * - `dangerous-write`  : delete/pause/block-reorder/shipping/templates/reorder;
 *                        always requires `--confirm` equal to the exact order id.
 * Matching uses contains-style patterns because menu rows carry ①…⑱ prefixes
 * and `*` state hints (e.g. ⑧取消关注订单*未关注订单才可操作).
 */
import type { OrderActionId, OrderActionInfo, OrderActionTier } from '../domain/types.js';

export interface OrderActionDefinition {
  id: OrderActionId;
  menuLabel: string;
  patterns: RegExp[];
  excludes?: RegExp[];
  tier: OrderActionTier;
  description: string;
  requires?: 'memo' | 'label' | 'addressId' | 'file';
}

export const ORDER_ACTION_DEFINITIONS: readonly OrderActionDefinition[] = [
  {
    id: 'reorder',
    menuLabel: '重新上传文件下单',
    patterns: [/重新上传文件下单/],
    tier: 'dangerous-write',
    description: '重新上传文件并进入下单流程（不会自动提交订单）',
    requires: 'file'
  },
  {
    id: 'print_contract',
    menuLabel: '打印合同',
    patterns: [/打印合同/],
    tier: 'read',
    description: '打印合同（导出合同页面为 PDF/图片）'
  },
  {
    id: 'delivery_note',
    menuLabel: '电子送货单及收据',
    patterns: [/电子送货单/, /送货单及收据/],
    tier: 'read',
    description: '电子送货单及收据下载'
  },
  {
    id: 'block_reorder',
    menuLabel: '标记禁止返单',
    patterns: [/禁止返单/],
    tier: 'dangerous-write',
    description: '标记该订单禁止返单'
  },
  {
    id: 'edit_memo',
    menuLabel: '编辑备忘录',
    patterns: [/编辑备忘录/, /^备忘录$/, /修改备忘/],
    tier: 'reversible-write',
    description: '编辑订单备忘录',
    requires: 'memo'
  },
  {
    id: 'delete_order',
    menuLabel: '删除订单',
    patterns: [/删除订单/, /^删除$/],
    tier: 'dangerous-write',
    description: '删除订单'
  },
  {
    id: 'follow',
    menuLabel: '关注订单',
    patterns: [/关注订单/, /^关注$/],
    excludes: [/取消关注/],
    tier: 'reversible-write',
    description: '关注订单'
  },
  {
    id: 'unfollow',
    menuLabel: '取消关注订单',
    patterns: [/取消关注/],
    tier: 'reversible-write',
    description: '取消关注订单'
  },
  {
    id: 'change_shipping',
    menuLabel: '修改收货信息',
    patterns: [/修改收货信息/],
    tier: 'dangerous-write',
    description: '修改收货信息',
    requires: 'addressId'
  },
  {
    id: 'download_qa_certificate',
    menuLabel: '下载质量保证书',
    patterns: [/质量保证书/],
    tier: 'read',
    description: '下载质量保证书'
  },
  {
    id: 'pause_production',
    menuLabel: '暂停生产',
    patterns: [/暂停生产/],
    tier: 'dangerous-write',
    description: '暂停生产'
  },
  {
    id: 'share_to_yingchuang',
    menuLabel: '分享到硬创社',
    patterns: [/硬创社/],
    tier: 'reversible-write',
    description: '分享到硬创社'
  },
  {
    id: 'reselect_template',
    menuLabel: '重选模板',
    patterns: [/重选模板/],
    tier: 'dangerous-write',
    description: '重选下单模板'
  },
  {
    id: 'modify_template',
    menuLabel: '修改模板内容',
    patterns: [/修改模板内容/],
    tier: 'dangerous-write',
    description: '修改模板内容'
  },
  {
    id: 'add_label',
    menuLabel: '添加标签',
    patterns: [/添加标签/],
    tier: 'reversible-write',
    description: '为订单添加标签',
    requires: 'label'
  },
  {
    id: 'remove_label',
    menuLabel: '移除标签',
    patterns: [/移除标签/, /删除标签/],
    tier: 'reversible-write',
    // The site's 移除标签 clears ALL labels of the order after a confirm box;
    // it cannot remove a single label.
    description: '清空订单全部标签（站点语义）'
  },
  {
    id: 'urge_review',
    menuLabel: '催审单',
    patterns: [/催审单/, /^催审$/],
    tier: 'reversible-write',
    description: '催促文件审核'
  },
  {
    id: 'urge_shipment',
    menuLabel: '催发货',
    patterns: [/催发货/],
    tier: 'reversible-write',
    description: '催促发货'
  }
];

export function resolveActionDefinition(action: OrderActionId): OrderActionDefinition {
  const definition = ORDER_ACTION_DEFINITIONS.find((item) => item.id === action);
  if (!definition) throw new Error(`Unknown order action: ${action}`);
  return definition;
}

export function describeActionAvailability(observedMenuTexts: readonly string[]): OrderActionInfo[] {
  return ORDER_ACTION_DEFINITIONS.map((definition) => {
    const matched = observedMenuTexts.find((text) => definition.patterns.some((pattern) => pattern.test(text))
      && !(definition.excludes?.some((excluded) => excluded.test(text))));
    return {
      id: definition.id,
      menuLabel: matched ?? definition.menuLabel,
      tier: definition.tier,
      available: matched !== undefined,
      reason: matched === undefined ? 'the visible 更多 menu has no matching entry' : undefined
    };
  });
}
