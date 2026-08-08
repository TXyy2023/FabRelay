import type { Locator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject } from './base.js';

const ORDER_LIST_URL = 'https://test.jlc.com/newOrder/#/pcb/pcbOrderList';
const ORDER_PAGE_URL = 'https://test.jlc.com/newOrder/#/pcb/newOnlinePlaceOrder';
const HOME_URL = 'https://test.jlc.com/';
const LOGIN_FRAME = 'iframe[src*="test-passport.jlc.com/window/login"]';
const SESSION_COOKIE = 'JLCGROUP_SESSIONID';

export interface AuthStatus {
  authenticated: boolean;
  orderPageAccessible: boolean;
  orderListAccessible: boolean;
  rawSignal: string;
  user?: AuthenticatedUserSummary;
}

export interface AuthenticatedUserSummary {
  displayName?: string;
  customerCode?: string;
  companyName?: string;
  source: 'visible-page';
}

export class LoginPage extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async status(): Promise<AuthStatus> {
    let persistentSsoRebuilt = false;
    let state = await this.readOrderListState();
    if (state.frameVisible || !state.orderListAccessible || !state.accountElement) {
      persistentSsoRebuilt = await this.bootstrapPersistentSso();
      if (persistentSsoRebuilt) state = await this.readOrderListState();
    }

    const { frameVisible, orderListAccessible, accountElement } = state;
    const accountVisible = accountElement !== undefined;
    const user = accountElement ? await this.readUserSummary(accountElement) : undefined;
    let orderPageAccessible = false;
    if (!frameVisible && orderListAccessible && accountVisible) {
      await this.page.goto(ORDER_PAGE_URL, { waitUntil: 'domcontentloaded' });
      orderPageAccessible = await this.page.locator('input[type="file"][name="file"]').waitFor({ state: 'attached', timeout: 8_000 }).then(() => true).catch(() => false);
    }
    const authenticated = !frameVisible && orderListAccessible && accountVisible && orderPageAccessible;
    return {
      authenticated,
      orderPageAccessible,
      orderListAccessible,
      rawSignal: frameVisible
        ? 'login-iframe-visible'
        : authenticated
          ? `${persistentSsoRebuilt ? 'persistent-sso-rebuilt-' : ''}account-order-list-and-upload-visible`
          : 'inconclusive',
      user: authenticated ? user : undefined
    };
  }

  private async readOrderListState(): Promise<{
    frameVisible: boolean;
    orderListAccessible: boolean;
    accountElement?: Locator;
  }> {
    await this.page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded' });
    const heading = this.page.getByRole('heading', { name: /全部订单|PCB未付款订单/ }).first();
    const pcbOrders = this.page.getByText('PCB/FPC订单', { exact: true }).first();
    const search = this.page.getByPlaceholder('文件名 / 订单编号 / 备忘').first();
    await Promise.race([
      heading.waitFor({ state: 'visible', timeout: 5_000 }),
      pcbOrders.waitFor({ state: 'visible', timeout: 5_000 }),
      search.waitFor({ state: 'visible', timeout: 5_000 }),
      this.page.locator(LOGIN_FRAME).waitFor({ state: 'visible', timeout: 5_000 })
    ]).catch(() => undefined);
    const frameVisible = await this.page.locator(LOGIN_FRAME).isVisible().catch(() => false);
    const orderListVisible = await heading.isVisible().catch(() => false)
      || await pcbOrders.isVisible().catch(() => false)
      || await search.isVisible().catch(() => false);
    const accountElement = await firstVisible(this.page.locator('.customer-popover-title'))
      ?? await firstVisible(this.page.getByText(/客编/));
    return { frameVisible, orderListAccessible: !frameVisible && orderListVisible, accountElement };
  }

  private async bootstrapPersistentSso(timeoutMs = 10_000): Promise<boolean> {
    await this.page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cookies = await this.page.context().cookies(HOME_URL).catch(() => []);
      if (cookies.some((cookie) => cookie.name === SESSION_COOKIE)) return true;
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  private async readUserSummary(accountElement: Locator): Promise<AuthenticatedUserSummary | undefined> {
    await accountElement.hover().catch(() => undefined);
    await this.page.waitForTimeout(500);
    const texts = await nearbyVisibleTexts(accountElement);
    const popover = this.page.locator('.customer-popover-class:visible').first();
    if (await popover.isVisible().catch(() => false)) {
      texts.push(await popover.innerText().catch(() => ''));
    }
    const labelled = this.page.getByText(/当前客编归属公司|客编归属公司|归属公司|所属公司|公司名称|用户名称|用户名|昵称/);
    const count = Math.min(await labelled.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const element = labelled.nth(index);
      if (await element.isVisible().catch(() => false)) texts.push(...await nearbyVisibleTexts(element));
    }
    const parsed = parseUserProfileTexts(texts);
    const companyName = parsed?.companyName ?? await popoverCompanyName(popover);
    if (!parsed && !companyName) return undefined;
    return { ...parsed, companyName, source: 'visible-page' };
  }

  async openLogin(): Promise<void> {
    await this.page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    if (await this.page.locator(LOGIN_FRAME).isVisible().catch(() => false)) return;
    const login = this.page.getByText('登录', { exact: true }).first();
    await this.contract('login entry', () => login.click());
    await this.contract('login iframe', () => this.page.locator(LOGIN_FRAME).waitFor({ state: 'visible' }));
  }

  async loginWithPassword(username: string, password: string): Promise<AuthStatus> {
    const existing = await this.status();
    if (existing.authenticated) return existing;
    await this.openLogin();
    const frame = this.page.frameLocator(LOGIN_FRAME);
    const otherAccount = frame.getByText('登录其他账号', { exact: true });
    if (await otherAccount.isVisible().catch(() => false)) await otherAccount.click({ force: true });
    const accountLogin = frame.getByText('账号登录', { exact: true });
    if (await accountLogin.isVisible().catch(() => false)) await accountLogin.click({ force: true });
    const account = frame.getByPlaceholder('请输入手机号码 / 客户编号 / 邮箱');
    const secret = frame.getByPlaceholder('请输入登录密码');
    await this.contract('account input', () => account.fill(username));
    await this.contract('password input', () => secret.fill(password));
    if ((await account.inputValue()).length === 0) { await account.click(); await this.page.keyboard.insertText(username); }
    if ((await secret.inputValue()).length === 0) { await secret.click(); await this.page.keyboard.insertText(password); }
    if ((await account.inputValue()).length === 0 || (await secret.inputValue()).length === 0) throw new JlcError('AUTH_INTERACTION_REQUIRED', 'The test login form rejected automated text input. Re-run `auth login --headed` and complete login manually.');
    const submit = frame.getByRole('button', { name: /登录/ }).last();
    await this.contract('login submit button', () => submit.click({ force: true }));
    await this.page.locator(LOGIN_FRAME).waitFor({ state: 'hidden', timeout: 120_000 }).catch(() => undefined);
    const status = await this.status();
    if (!status.authenticated) throw new JlcError('AUTH_REQUIRED', 'The test-site login did not reach an authenticated order page.', { details: status });
    return status;
  }

  async waitForManualLogin(timeoutMs = 5 * 60_000): Promise<AuthStatus> {
    const existing = await this.status();
    if (existing.authenticated) return existing;
    await this.openLogin();
    await this.page.locator(LOGIN_FRAME).waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => undefined);
    const status = await this.status();
    if (!status.authenticated) throw new JlcError('AUTH_REQUIRED', 'Login was not completed before the timeout.', { details: status });
    return status;
  }

  async assertAuthenticated(): Promise<void> {
    const status = await this.status();
    if (!status.authenticated) throw new JlcError('AUTH_REQUIRED', 'The dedicated JLC browser profile is not logged in.', { details: status });
  }
}

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = Math.min(await locator.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

async function nearbyVisibleTexts(locator: Locator): Promise<string[]> {
  return await locator.evaluate((element) => {
    const values: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const text = current instanceof HTMLElement ? current.innerText : current.textContent;
      const normalized = text?.replace(/\u00a0/g, ' ').trim();
      if (normalized && normalized.length <= 1_000 && !values.includes(normalized)) values.push(normalized);
      current = current.parentElement;
    }
    return values;
  }).catch(() => []);
}

async function popoverCompanyName(popover: Locator): Promise<string | undefined> {
  if (!await popover.isVisible().catch(() => false)) return undefined;
  const candidates = popover.locator('.flex-auto.item');
  const count = Math.min(await candidates.count().catch(() => 0), 8);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const value = normalizeCompanyCandidate(await candidate.innerText().catch(() => ''));
    if (value) return value;
  }
  return undefined;
}

export function normalizeCompanyCandidate(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim()
    .replace(/^(?:当前客编归属公司(?:名称)?|客编归属公司(?:名称)?|归属公司(?:名称)?|所属公司(?:名称)?|公司名称) *[：:]?\s*/, '');
  if (normalized.length < 2 || normalized.length > 120 || !/公司|工作室|中心|研究院|学校|大学|个人/.test(normalized)) return undefined;
  return normalized;
}

const CUSTOMER_CODE_LABEL = '(?:客户编号|客户编码|客编)';
const COMPANY_LABEL = '(?:当前客编归属公司(?:名称)?|客编归属公司(?:名称)?|归属公司(?:名称)?|所属公司(?:名称)?|公司名称)';
const DISPLAY_NAME_LABEL = '(?:用户名称|用户名|昵称|登录用户)';

export function parseUserProfileTexts(texts: readonly string[]): AuthenticatedUserSummary | undefined {
  const lines = texts
    .flatMap((text) => text.replace(/\u00a0/g, ' ').split(/[\n|｜]+/))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, index, values) => line.length > 0 && values.indexOf(line) === index);
  const allText = lines.join('\n');
  const customerCode = allText.match(new RegExp(`${CUSTOMER_CODE_LABEL}\\s*[：:#]?\\s*([A-Za-z0-9][A-Za-z0-9_-]{1,})`, 'i'))?.[1];
  const companyName = labelledValue(lines, COMPANY_LABEL);
  const displayName = labelledValue(lines, DISPLAY_NAME_LABEL);
  if (!customerCode && !companyName && !displayName) return undefined;
  return {
    displayName,
    customerCode,
    companyName,
    source: 'visible-page'
  };
}

function labelledValue(lines: string[], labelPattern: string): string | undefined {
  const inline = new RegExp(`${labelPattern}(?:\\s*[：:]\\s*|\\s+)(.+)$`, 'i');
  const labelOnly = new RegExp(`^${labelPattern}\\s*[：:]?$`, 'i');
  const nextLabel = new RegExp(`\\s+(?=${CUSTOMER_CODE_LABEL}|${COMPANY_LABEL}|${DISPLAY_NAME_LABEL})\\s*[：:]`, 'i');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(inline);
    const value = match?.[1]?.split(nextLabel)[0]?.trim();
    if (value) return value;
    if (labelOnly.test(lines[index] ?? '')) {
      const adjacent = lines[index + 1]?.trim();
      if (adjacent && !labelOnly.test(adjacent)) return adjacent;
    }
  }
  return undefined;
}
