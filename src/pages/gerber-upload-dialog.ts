import path from 'node:path';
import type { Page } from 'playwright';
import { JlcError } from '../domain/errors.js';
import { JlcPageObject } from './base.js';
import { PAGE_CONTRACTS } from './contracts.js';

const UPLOAD_URL = `https://test.jlc.com${PAGE_CONTRACTS.uploadRoute}`;

export class GerberUploadDialog extends JlcPageObject {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.fullGoto(UPLOAD_URL);
    await this.contract('Gerber file input', () => this.page.locator(PAGE_CONTRACTS.gerberInput).waitFor({ state: 'attached' }));
  }

  async upload(filePath: string, timeoutMs = 120_000): Promise<void> {
    const input = this.page.locator(PAGE_CONTRACTS.gerberInput).first();
    await this.contract('Gerber file input', () => input.setInputFiles(path.resolve(filePath)));
    await Promise.race([
      this.page.waitForURL(/#\/pcb\/pcbPlaceOrder(?:[?#]|$)/, { timeout: timeoutMs }),
      this.page.getByText(/上传失败|解析失败|分析失败/).first().waitFor({ state: 'visible', timeout: timeoutMs }).then(async () => {
        throw new JlcError('PAGE_BUSINESS_ERROR', await this.page.getByText(/上传失败|解析失败|分析失败/).first().innerText());
      })
    ]).catch((error) => {
      if (error instanceof JlcError) throw error;
      throw new JlcError('TIMEOUT', 'Gerber upload or JLC analysis did not complete in time.', { retryable: true, cause: error });
    });
    await this.page.getByRole('heading', { name: '基本信息', exact: true }).waitFor({ state: 'visible', timeout: timeoutMs }).catch((error) => {
      throw new JlcError('PAGE_BUSINESS_ERROR', 'JLC did not reach the PCB parameter page after upload.', { cause: error });
    });
  }
}
