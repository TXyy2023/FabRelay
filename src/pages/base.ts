import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { JlcError } from '../domain/errors.js';

export abstract class JlcPageObject {
  protected constructor(protected readonly page: Page) {}

  protected async contract<T>(description: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new JlcError('CONTRACT_DRIFT', `JLC page contract changed: ${description}.`, { cause: error });
    }
  }

  protected async fieldContainer(label: string): Promise<Locator> {
    const text = await this.visibleExactText(label);
    if (!text) throw new JlcError('CONTRACT_DRIFT', `JLC page contract changed: field label ${label}.`);
    return text.locator('xpath=ancestor::div[.//button or .//input][1]');
  }

  protected async optionalFieldContainer(label: string): Promise<Locator | undefined> {
    const text = await this.visibleExactText(label);
    return text?.locator('xpath=ancestor::div[.//button or .//input][1]');
  }

  private async visibleExactText(label: string): Promise<Locator | undefined> {
    const candidates = this.page.getByText(label, { exact: true });
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return undefined;
  }

  protected async selectButton(label: string, displayText: string): Promise<string> {
    const container = await this.fieldContainer(label);
    const option = container.getByRole('button', { name: displayText, exact: true }).first();
    await this.contract(`${label} option ${displayText}`, () => option.click());
    await this.page.waitForTimeout(150);
    const selected = await option.evaluate((element) => {
      const className = typeof element.className === 'string' ? element.className : '';
      return className.split(/\s+/).some((name) => ['checked', 'active', 'selected', 'is-active'].includes(name))
        || element.getAttribute('aria-pressed') === 'true'
        || element.getAttribute('aria-selected') === 'true';
    });
    if (!selected) {
      throw new JlcError('PAGE_BUSINESS_ERROR', `${label} did not remain selected after choosing ${displayText}.`);
    }
    return (await option.innerText()).trim();
  }

  async fingerprint(): Promise<string> {
    const value = await this.page.locator('script[src]').evaluateAll((scripts) => scripts
      .map((script) => script.getAttribute('src'))
      .filter((source): source is string => Boolean(source))
      .sort());
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}

export function parseMoney(text: string): number | undefined {
  const match = text.replaceAll(',', '').match(/(?:¥|￥)?\s*(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}
