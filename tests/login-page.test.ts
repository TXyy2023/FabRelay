import { describe, expect, it } from 'vitest';
import { buildSliderTrajectory, normalizeCompanyCandidate, parseUserProfileTexts } from '../src/pages/login-page.js';

describe('authenticated user profile readback', () => {
  it('extracts the visible user, customer code, and owning company', () => {
    expect(parseUserProfileTexts([
      '用户名：测试用户\n客编：A123456',
      '当前客编归属公司名称：深圳市示例科技有限公司'
    ])).toEqual({
      displayName: '测试用户',
      customerCode: 'A123456',
      companyName: '深圳市示例科技有限公司',
      source: 'visible-page'
    });
  });

  it('supports a company label and value rendered as adjacent elements', () => {
    expect(parseUserProfileTexts([
      '客编: 10086',
      '归属公司\n苏州市电路示例有限公司'
    ])).toMatchObject({
      customerCode: '10086',
      companyName: '苏州市电路示例有限公司'
    });
  });

  it('supports visible labels separated from values by whitespace', () => {
    expect(parseUserProfileTexts(['客编 B20001', '公司名称 上海示例电子有限公司']))
      .toMatchObject({ customerCode: 'B20001', companyName: '上海示例电子有限公司' });
  });

  it('does not guess profile fields from unrelated text', () => {
    expect(parseUserProfileTexts(['PCB/FPC订单', '全部订单', '暂无通知'])).toBeUndefined();
  });

  it('reads the owning company from the authenticated account popover item', () => {
    expect(normalizeCompanyCandidate('当前客编归属公司：深圳市示例科技有限公司')).toBe('深圳市示例科技有限公司');
    expect(normalizeCompanyCandidate('切换客编')).toBeUndefined();
  });
});

describe('slider drag trajectory', () => {
  it('covers the full track with a decelerating, wobbling path', () => {
    const points = buildSliderTrajectory(358, 1);
    expect(points).toHaveLength(34);
    const first = points[0];
    const last = points.at(-1);
    expect(first?.dx).toBeGreaterThan(0);
    expect(last?.dx).toBe(358);
    for (const point of points) {
      expect(point.dx).toBeGreaterThanOrEqual(0);
      expect(point.dx).toBeLessThanOrEqual(358);
      expect(Math.abs(point.dy)).toBeLessThanOrEqual(2);
      expect(point.waitMs).toBeGreaterThanOrEqual(6);
      expect(point.waitMs).toBeLessThanOrEqual(18);
    }
    // accelerates early: first third covers less than half the distance
    expect(points[10]?.dx ?? Infinity).toBeLessThan(358 / 2);
    expect(points[23]?.dx ?? 0).toBeGreaterThan(358 * 0.8);
  });

  it('varies the wobble by seed so retries do not repeat one pattern', () => {
    const one = buildSliderTrajectory(300, 1);
    const two = buildSliderTrajectory(300, 2);
    expect(one.map((point) => point.dy)).not.toEqual(two.map((point) => point.dy));
  });
});
