import { SCHEMA_VERSION, XiaoZhiAnswerSchema, type XiaoZhiAnswer } from '../domain/types.js';
import { LoginPage } from '../pages/login-page.js';
import { XiaoZhiPage } from '../pages/xiaozhi-page.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';

export async function askXiaoZhi(question: string, options: BrowserSessionOptions = {}): Promise<XiaoZhiAnswer> {
  const askedAt = new Date().toISOString();
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    await session.goto('/newOrder/#/pcb/pcbOrderList');
    const answer = await new XiaoZhiPage(session.page).ask(question, options.timeoutMs);
    return XiaoZhiAnswerSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      question,
      answer,
      source: 'jlc-xiaozhi',
      askedAt,
      answeredAt: new Date().toISOString()
    });
  });
}
