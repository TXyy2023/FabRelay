const sensitiveKey = /(?:password|passwd|secret|token|cookie|authorization|phone|mobile|address|invoice|tax|contact|xsrf|key)/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? '<redacted>' : redactSensitive(child)
    ]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b1\d{2}\d{4}\d{4}\b/g, '1**********')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g, '<redacted-token>');
}

export function redactOrderSummary(summary: Record<string, string>): Record<string, string> {
  const sensitive = /收货地址|联系方式|联系人|手机|电话|发票信息|税号/i;
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, sensitive.test(key) ? '<redacted>' : value]));
}
