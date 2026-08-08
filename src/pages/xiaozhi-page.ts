import type { FrameLocator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject } from './base.js';

export class XiaoZhiPage extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<FrameLocator> {
    const iframe = this.page.locator('iframe[src*="ai-livechat-platform-web"]').first();
    await this.contract('嘉小智 iframe', () => iframe.waitFor({ state: 'visible' }));
    const frame = iframe.contentFrame();
    const app = frame.locator('#app');
    const box = await iframe.boundingBox();
    if (!box || box.width < 200 || box.height < 200) {
      await this.contract('嘉小智 launcher', () => app.click({ position: { x: 35, y: 35 }, force: true }));
    }
    await this.contract('嘉小智 input', () => frame.getByPlaceholder('输入消息...').waitFor({ state: 'visible' }));
    return frame;
  }

  async ask(question: string, timeoutMs = 120_000): Promise<string> {
    const trimmed = question.trim();
    if (!trimmed) throw new JlcError('INVALID_ARGUMENT', '嘉小智问题不能为空。');
    if (trimmed.length > 2_000) throw new JlcError('INVALID_ARGUMENT', '嘉小智问题不能超过 2000 个字符。');
    const frame = await this.open();
    const answers = frame.locator('.ai-message-container .markdown-content');
    const before = await answers.count();
    const input = frame.getByPlaceholder('输入消息...');
    await input.fill(trimmed);
    await input.press('Enter');

    const deadline = Date.now() + timeoutMs;
    let previous = '';
    let stableReads = 0;
    while (Date.now() < deadline) {
      const count = await answers.count();
      const current = count > before ? clean(await answers.last().innerText().catch(() => '')) : '';
      if (current && current === previous) stableReads += 1;
      else stableReads = 0;
      if (current && stableReads >= 2) return current;
      previous = current;
      await this.page.waitForTimeout(500);
    }
    throw new JlcError('TIMEOUT', '嘉小智未在限定时间内返回稳定回复。', { retryable: true });
  }
}

function clean(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}
