import { createHash } from 'node:crypto';
import {
  DisclaimerStatusSchema,
  type DisclaimerAcceptance,
  type DisclaimerStatus
} from '../domain/types.js';
import { appPaths } from '../config/paths.js';
import { readModeConfiguration, writeModeConfiguration } from '../mode/index.js';

export const DISCLAIMER_VERSION = 2 as const;

export const DISCLAIMER_NOTICE = `警告：JLC CLI 为第三方工具

本 jlc-cli 为第三方使用工具，未获得嘉立创或其关联主体的官方发布、授权、背书或维护。

所有通过本 CLI 执行的操作（登录、上传文件、报价、下单、付款、订单管理操作等）均由用户本人执行，并由用户自行承担全部风险与后果。网页变化、文件或工艺理解偏差、浏览器异常等情况，都可能导致报价、工艺或订单结果与预期不符。

使用本 CLI 即表示你已理解上述风险，并自行承担使用该工具可能产生的一切后果。

本警告不会放松工具内部的测试站限制、人工审批、手动确认订单与禁止自动付款等安全边界。`;

export const AGENT_RELAY_NOTICE = `【Agent 首次访问提示 —— 请将以下内容原文转述给用户】

你（AI Agent）正在首次访问第三方工具 jlc-cli。在继续执行任何 jlc-cli 命令之前，你必须：
1. 将 \`jlc-cli disclaimer show\` 输出的完整警告原文展示/转述给用户；
2. 明确告知用户：本工具为第三方工具，所有操作均由用户本人执行，用户需自行承担全部风险与后果；
3. 只有在用户明确表示已理解并接受上述风险后，才允许继续后续操作。

用户未接受警告前，下单、付款和所有订单操作都会被拒绝。禁止代替用户接受警告，禁止绕过本提示。`;

export const DISCLAIMER_SHOW_TEXT = `${DISCLAIMER_NOTICE}\n\n${AGENT_RELAY_NOTICE}`;

export const DISCLAIMER_NOTICE_SHA256 = createHash('sha256').update(DISCLAIMER_NOTICE).digest('hex');

export async function disclaimerStatus(configFile = appPaths.configFile): Promise<DisclaimerStatus> {
  const configuration = await readModeConfiguration(configFile);
  const receipt = configuration.disclaimer;
  const accepted = isCurrentReceipt(receipt);
  return DisclaimerStatusSchema.parse({
    required: !accepted,
    accepted,
    version: DISCLAIMER_VERSION,
    noticeSha256: DISCLAIMER_NOTICE_SHA256,
    acceptedAt: accepted ? receipt?.acceptedAt : undefined
  });
}

export async function acceptDisclaimer(configFile = appPaths.configFile): Promise<DisclaimerStatus> {
  const configuration = await readModeConfiguration(configFile);
  const disclaimer: DisclaimerAcceptance = {
    version: DISCLAIMER_VERSION,
    noticeSha256: DISCLAIMER_NOTICE_SHA256,
    acceptedAt: new Date().toISOString()
  };
  await writeModeConfiguration({ ...configuration, disclaimer }, configFile);
  return await disclaimerStatus(configFile);
}

export async function resetDisclaimer(configFile = appPaths.configFile): Promise<DisclaimerStatus> {
  const configuration = await readModeConfiguration(configFile);
  const { disclaimer: _removed, ...remaining } = configuration;
  await writeModeConfiguration(remaining, configFile);
  return await disclaimerStatus(configFile);
}

function isCurrentReceipt(receipt: DisclaimerAcceptance | undefined): boolean {
  return receipt?.version === DISCLAIMER_VERSION && receipt.noticeSha256 === DISCLAIMER_NOTICE_SHA256;
}
