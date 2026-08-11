import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTestEnvironmentUrl } from '../src/browser/session.js';
import { persistentContextOptions } from '../src/browser/session.js';
import { parseBrowserEngine, selectBrowserRuntime } from '../src/browser/runtime.js';
import { StatusSnapshotSchema } from '../src/domain/types.js';
import { redactOrderSummary, redactSensitive } from '../src/logging/redact.js';
import { PAGE_CONTRACTS } from '../src/pages/contracts.js';
import { normalizeOrderStatus } from '../src/pages/order-list-page.js';
import { normalizeShippingStatus } from '../src/pages/order-progress-dialog.js';
import { parseVisiblePaymentAmount } from '../src/pages/order-payment-page.js';
import { schemaFor } from '../src/schema/index.js';
import { StateDatabase } from '../src/storage/database.js';
import { assertNoSilentDefaults } from '../src/workflows/quote.js';

describe('public contracts', () => {
  it('validates browser engines and prefers system Chrome in auto mode', () => {
    expect(parseBrowserEngine(undefined)).toBe('auto');
    expect(parseBrowserEngine('chrome')).toBe('chrome');
    expect(() => parseBrowserEngine('firefox')).toThrow(/auto, chrome, or chromium/);
    expect(selectBrowserRuntime('auto', {
      systemChrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      playwrightChromium: '/tmp/chromium'
    }).engine).toBe('chrome');
    expect(selectBrowserRuntime('auto', { playwrightChromium: '/tmp/chromium' }).engine).toBe('chromium');
    expect(() => selectBrowserRuntime('chrome', { playwrightChromium: '/tmp/chromium' })).toThrow(/System Google Chrome/);
  });

  it('uses the real macOS Keychain when Playwright reopens a manual Chrome profile', () => {
    const chrome = persistentContextOptions({ engine: 'chrome', executablePath: '/tmp/chrome' }, {});
    const chromium = persistentContextOptions({ engine: 'chromium', executablePath: '/tmp/chromium' }, {});
    expect(chrome.ignoreDefaultArgs).toEqual(['--use-mock-keychain', '--password-store=basic']);
    expect(chromium.ignoreDefaultArgs).toBeUndefined();
  });

  it('rejects all non-test origins', () => {
    expect(() => assertTestEnvironmentUrl('https://test.jlc.com/newOrder/')).not.toThrow();
    expect(() => assertTestEnvironmentUrl('https://www.jlc.com/newOrder/')).toThrow(/Only/);
    expect(() => assertTestEnvironmentUrl('http://test.jlc.com/')).toThrow(/Only/);
    expect(() => assertTestEnvironmentUrl('https://test.jlc.com.evil.example/')).toThrow(/Only/);
  });

  it('keeps production and shipping as separate status models', () => {
    const value = StatusSnapshotSchema.parse({
      schemaVersion: 1,
      orderId: 'Y1',
      status: 'in_production',
      rawStatus: '生产中',
      production: { status: 'in_production', rawStatus: '生产中', nodes: [{ label: '生产', state: 'active' }] },
      shipping: { status: 'not_shipped', rawStatus: '未发货' },
      capturedAt: new Date().toISOString()
    });
    expect(value.production.nodes[0]?.label).toBe('生产');
    expect(value.shipping.rawStatus).toBe('未发货');
  });

  it.each([
    ['等待审核', 'under_review'],
    ['文件审核有问题', 'file_issue'],
    ['待付款', 'awaiting_payment'],
    ['拼板中', 'in_production'],
    ['已发货', 'shipped'],
    ['已签收', 'delivered'],
    ['未见过的新状态', 'unknown']
  ] as const)('maps %s without guessing', (raw, expected) => {
    expect(normalizeOrderStatus(raw)).toBe(expected);
  });

  it('publishes page selectors and JSON schemas from code contracts', () => {
    expect(PAGE_CONTRACTS.gerberInput).toContain('type="file"');
    expect(PAGE_CONTRACTS.finalSubmitButton).toBe('确认并提交');
    expect(schemaFor('quote')).toMatchObject({ type: 'object' });
    expect(schemaFor('payment')).toMatchObject({ type: 'object' });
    expect(schemaFor('xiaozhi')).toMatchObject({ type: 'object' });
  });

  it('normalizes delivery separately and parses the authoritative payment amount', () => {
    expect(normalizeShippingStatus('正在派送')).toBe('in_transit');
    expect(normalizeShippingStatus('已签收')).toBe('delivered');
    expect(normalizeShippingStatus('物流异常')).toBe('exception');
    expect(parseVisiblePaymentAmount('账户余额 999.00\n应付金额 ￥269.09')).toBe(269.09);
  });

  it('redacts secrets recursively', () => {
    expect(redactSensitive({ password: 'plain', nested: { phone: '13600001234' }, note: 'call 13600001234' }))
      .toEqual({ password: '<redacted>', nested: { phone: '<redacted>' }, note: 'call 1**********' });
  });

  it('redacts bearer-like tokens but keeps kebab-case diagnostics readable', () => {
    expect(redactSensitive('session abcdef1234567890abcdef1234567890abcd')).toBe('session <redacted-token>');
    expect(redactSensitive('rawSignal order-api-unauthenticated')).toBe('rawSignal order-api-unauthenticated');
  });

  it('never persists visible address or contact values in quote summaries', () => {
    expect(redactOrderSummary({ 收货地址: '某省某市详细地址', 联系方式: '张三 13600001234', 阻焊颜色: '绿色' }))
      .toEqual({ 收货地址: '<redacted>', 联系方式: '<redacted>', 阻焊颜色: '绿色' });
  });

  it('blocks page defaults that were not explicitly accepted', () => {
    const base = {
      material: 'FR-4', layerCount: 2, quantity: 5, boardThicknessMm: 1.6, copperWeightOz: 1,
      solderMaskColor: '绿色', silkscreenColor: '白色', surfaceFinish: '有铅喷锡', viaTreatment: '过孔盖油',
      impedanceControl: '无要求', delivery: '样板48小时', addressId: 'a', contactId: 'c', shippingMethodId: 's',
      confirmationMode: 'manual' as const, smt: false as const, stencil: false as const, processOptions: {}
    };
    expect(() => assertNoSilentDefaults({ 产品类型: '工业/消费/其他类电子产品' }, base)).toThrow(/defaults/i);
    expect(() => assertNoSilentDefaults({ 产品类型: '工业/消费/其他类电子产品' }, {
      ...base, processOptions: { 产品类型: '工业/消费/其他类电子产品' }
    })).not.toThrow();
  });
});

describe('idempotency database', () => {
  it('does not create a second submission record for one request ID', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-db-'));
    const database = await StateDatabase.open(path.join(temp, 'state.db'));
    expect(database.beginIdempotentRequest('request-1', 'quote-1')).toBe('new');
    expect(database.beginIdempotentRequest('request-1', 'quote-1')).toBe('existing');
    database.finishIdempotentRequest('request-1', 'unknown');
    expect(database.getIdempotency('request-1')).toMatchObject({ quoteId: 'quote-1', state: 'unknown' });
    database.close();
  });

  it('does not create a second balance-payment request for one request ID', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jlc-db-'));
    const database = await StateDatabase.open(path.join(temp, 'state.db'));
    expect(database.beginPaymentRequest('pay-request-1', 'payment-1')).toBe('new');
    expect(database.beginPaymentRequest('pay-request-1', 'payment-1')).toBe('existing');
    database.finishPaymentRequest('pay-request-1', 'unknown');
    expect(database.getPaymentRequest('pay-request-1')).toMatchObject({ paymentId: 'payment-1', state: 'unknown' });
    database.close();
  });
});
