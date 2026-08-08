import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';
import { JlcError } from '../domain/errors.js';
import type { QuoteSnapshot } from '../domain/types.js';
import { createApprovalReceipt } from '../storage/approval.js';
import { StateDatabase } from '../storage/database.js';

export async function approveQuote(quoteId: string): Promise<{ receipt: import('../domain/types.js').ApprovalReceipt; path: string }> {
  if (!stdin.isTTY || !stdout.isTTY) throw new JlcError('APPROVAL_REQUIRED', 'Approval creation requires an interactive terminal.');
  const database = await StateDatabase.open();
  let quote: QuoteSnapshot | undefined;
  try { quote = database.getQuote(quoteId); } finally { database.close(); }
  if (!quote) throw new JlcError('APPROVAL_REQUIRED', `Quote ${quoteId} does not exist.`);
  const code = String(randomInt(100_000, 1_000_000));
  stderr.write(renderApproval(quote, code));
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = (await prompt.question('输入上面的六位确认码：')).trim();
    if (answer !== code) throw new JlcError('APPROVAL_INVALID', 'The confirmation code did not match.');
  } finally {
    prompt.close();
  }
  const created = await createApprovalReceipt(quote);
  const nextDatabase = await StateDatabase.open();
  try { nextDatabase.saveApproval(created.receipt); } finally { nextDatabase.close(); }
  return created;
}

function renderApproval(quote: QuoteSnapshot, code: string): string {
  return `\nJLC 测试订单人工审批\n\n` +
    `Quote: ${quote.id}\n` +
    `Gerber SHA-256: ${quote.gerberSha256}\n` +
    `预览: ${quote.artifacts.map((artifact) => artifact.path).join(', ')}\n` +
    `制造参数:\n${Object.entries(quote.displayParameters).map(([key, value]) => `  ${key}: ${value}`).join('\n')}\n` +
    `地址: ${quote.addressLabel ?? '<未设置>'}\n联系人: ${quote.contactLabel ?? '<未设置>'}\n` +
    `快递: ${quote.shippingLabel ?? '<未设置>'}\n交期: ${quote.spec.delivery ?? '<未设置>'}\n` +
    `费用: ${quote.money.displayText}\n最高金额: CNY ${quote.money.total.toFixed(2)}\n\n` +
    `这会授权创建一笔 test.jlc.com 测试订单，不会自动付款。\n确认码: ${code}\n\n`;
}
