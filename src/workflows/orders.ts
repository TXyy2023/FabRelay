import { setTimeout as delay } from 'node:timers/promises';
import { JlcError } from '../domain/errors.js';
import type { OrderAuditSnapshot, OrderRecord, StatusSnapshot } from '../domain/types.js';
import { LoginPage } from '../pages/login-page.js';
import { OrderListPage } from '../pages/order-list-page.js';
import { StateDatabase } from '../storage/database.js';
import { withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';

export async function listOrders(options: BrowserSessionOptions & { limit?: number } = {}): Promise<OrderRecord[]> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const list = new OrderListPage(session.page);
    await list.open();
    const orders = await list.list(options.limit);
    const database = await StateDatabase.open();
    try { for (const order of orders) database.saveOrder(order); } finally { database.close(); }
    return orders;
  });
}

export async function showOrder(orderId: string, options: BrowserSessionOptions = {}): Promise<{ order: OrderRecord; status: StatusSnapshot }> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const list = new OrderListPage(session.page);
    await list.open();
    const order = await list.show(orderId);
    const status = await list.status(orderId);
    const database = await StateDatabase.open();
    try { database.saveOrder(order); database.saveStatus(status); } finally { database.close(); }
    return { order, status };
  });
}

export async function auditOrder(orderId: string, options: BrowserSessionOptions = {}): Promise<OrderAuditSnapshot> {
  return await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const list = new OrderListPage(session.page);
    await list.open();
    return await list.audit(orderId);
  });
}

export async function watchOrder(
  orderId: string,
  options: BrowserSessionOptions & { intervalMs?: number; signal?: AbortSignal; onChange: (snapshot: StatusSnapshot) => void }
): Promise<void> {
  const intervalMs = Math.max(options.intervalMs ?? 30_000, 5_000);
  await withBrowserSession(options, async (session) => {
    await new LoginPage(session.page).assertAuthenticated();
    const list = new OrderListPage(session.page);
    let lastHash: string | undefined;
    while (!options.signal?.aborted) {
      await list.open();
      const status = await list.status(orderId);
      const hash = JSON.stringify({ status: status.status, rawStatus: status.rawStatus, production: status.production, shipping: status.shipping });
      if (hash !== lastHash) {
        options.onChange(status);
        const database = await StateDatabase.open();
        try { database.saveStatus(status); } finally { database.close(); }
        lastHash = hash;
      }
      const auth = await new LoginPage(session.page).status();
      if (!auth.authenticated) throw new JlcError('AUTH_EXPIRED', 'Login expired while watching the order. Automatic login is disabled.');
      await delay(intervalMs, undefined, { signal: options.signal }).catch((error) => {
        if (!options.signal?.aborted) throw error;
      });
    }
  });
}
