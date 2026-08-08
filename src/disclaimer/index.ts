import { createHash } from 'node:crypto';
import {
  DisclaimerStatusSchema,
  type DisclaimerAcceptance,
  type DisclaimerStatus
} from '../domain/types.js';
import { appPaths } from '../config/paths.js';
import { readModeConfiguration, writeModeConfiguration } from '../mode/index.js';

export const DISCLAIMER_VERSION = 1 as const;

export const DISCLAIMER_NOTICE = `警告：JLC CLI 为非官方工具

当前 CLI 为非官方插件，未获得嘉立创或其关联主体的官方发布、授权、背书或维护。

本工具会读取本地 Gerber 和要求文件，并通过浏览器自动化操作嘉立创测试站。网页变化、文件或工艺理解偏差、浏览器异常等情况，都可能导致报价、工艺或订单结果与预期不符。

使用当前 CLI 即表示你已理解上述风险，并自行承担使用该工具可能产生的后果。

本警告不会放松工具内部的测试站限制、人工审批、手动确认订单与禁止自动付款等安全边界。`;

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
