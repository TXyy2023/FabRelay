import type { PlatformMessage } from '../domain/types.js';
import { LoginPage } from '../pages/login-page.js';
import { PlatformMessagesPage } from '../pages/platform-messages-page.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';

export async function listPlatformMessages(
  options: BrowserSessionOptions & { limit?: number } = {}
): Promise<PlatformMessage[]> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const messages = new PlatformMessagesPage(session.page);
    await messages.open();
    return await messages.list(options.limit ?? 20);
  });
}
