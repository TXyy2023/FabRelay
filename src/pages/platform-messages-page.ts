import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { PlatformMessageSchema, SCHEMA_VERSION, type PlatformMessage } from '../domain/types.js';
import { redactSensitive } from '../logging/redact.js';
import { JlcPageObject } from './base.js';
import { PAGE_CONTRACTS } from './contracts.js';

const ORDER_LIST_URL = `https://test.jlc.com${PAGE_CONTRACTS.orderListRoute}`;

export class PlatformMessagesPage extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.fullGoto(ORDER_LIST_URL);
    await this.contract('platform message panel', () => this.page.locator('.notice .pm-tabs').first().waitFor({ state: 'attached' }));
    await this.page.waitForFunction(() => document.querySelectorAll('.notice .pm-content .item:not(.last)').length > 0
      || /暂无消息|暂无数据/.test(document.body.innerText), undefined, { timeout: 30_000 }).catch((error) => {
      throw new JlcError('CONTRACT_DRIFT', 'The platform message panel did not finish its initial load.', { cause: error });
    });
  }

  async list(limit = 20): Promise<PlatformMessage[]> {
    const output: PlatformMessage[] = [];
    for (const item of [
      { label: /平台消息|企业动态/, description: '平台消息', category: 'platform' as const },
      { label: /站内消息/, description: '站内消息', category: 'inbox' as const }
    ]) {
      const root = this.page.locator('.notice').first();
      const tab = root.locator('.pm-tab').filter({ hasText: item.label }).first();
      if (!await tab.isVisible().catch(() => false)) continue;
      await this.contract(`message tab ${item.description}`, () => tab.dispatchEvent('click'));
      await this.page.waitForTimeout(150);
      const rows = root.locator('.pm-content .item:not(.last)');
      const count = Math.min(await rows.count(), Math.max(0, limit - output.length));
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        const text = clean(await row.innerText());
        if (!text) continue;
        const lines = text.split('\n').map(clean).filter(Boolean);
        const date = text.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/)?.[0];
        const safeText = String(redactSensitive(text));
        output.push(PlatformMessageSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id: createHash('sha256').update(`${item.category}\0${safeText}`).digest('hex').slice(0, 20),
          category: item.category,
          title: String(redactSensitive(lines[0] ?? text)).slice(0, 500),
          summary: lines.length > 1 ? String(redactSensitive(lines.slice(1).join(' '))).slice(0, 1_500) : undefined,
          unread: /(?:^|\s)(?:unread|new|is-new)(?:\s|$)/i.test(await row.getAttribute('class') ?? '') || /未读/.test(text),
          publishedAt: date,
          capturedAt: new Date().toISOString()
        }));
      }
      if (output.length >= limit) break;
    }
    if (output.length === 0) {
      const empty = await this.page.getByText(/暂无消息|暂无数据/).first().isVisible().catch(() => false);
      if (!empty) throw new JlcError('CONTRACT_DRIFT', 'The platform message panel rendered neither messages nor an empty state.');
    }
    return output;
  }
}

function clean(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}
