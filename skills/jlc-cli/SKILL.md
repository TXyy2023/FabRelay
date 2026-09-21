---
name: jlc-cli
description: Use jlc-cli to log in to jlc.com, upload and preview PCB files, configure and quote orders, query PCB/FPC orders, perform human-confirmed balance payments, and talk to Jia Xiaozhi. Use for JLC China website business workflows, not schematic editing or local Gerber conversion.
---

# jlc-cli

通过业务 CLI 操作嘉立创中国站。常规流程使用命令；只有命令返回待接管时才操作它保留的 CDP 页面。

## 开始

先运行 `jlc-cli --version`、`jlc-cli --help`、`jlc-cli browser doctor --json`。找不到命令时说明缺少安装，不自行换用同名包或其他站点。`jlc-cli skill path` 返回随该 CLI 交付的 Skill，优先使用同版本说明。

首次使用先向人类呈现 `jlc-cli init --json` 返回的初始化范围，取得明确同意后运行 `jlc-cli init --accept --confirmed-by human`；也可由人类交互式运行 `init`。随后配置浏览器、发起登录并核实 `auth status`；扫码时向人类展示命令返回的当前二维码。登录完成以账号状态核实结果为准，不能只凭页面跳转或扫码动作。完成后可用 `jlc-cli account show --json` 做一次查询。

## 业务索引

| 需求 | 命令组与参考 |
| --- | --- |
| 安装发现、初始化、浏览器、账号配置、多方式登录、扫码、成功回调 | [命令与登录](references/commands.md) |
| 上传/解析/预览、参数、报价、检查与建单 | [PCB 工作流](references/pcb.md) |
| PCB/FPC 订单、余额付款、嘉小智 | [订单与付款](references/orders-payment.md) |
| JSON 状态、退出码、任务观察、CDP 接管、未知结果 | [结果与恢复](references/results-recovery.md) |

## 必须保留的决策边界

- `default`：用户未决定的生产参数应询问。网站预选、上次配置及解析事实不自动变成用户选择。`auto`：先有用户让 Agent 帮助选填的意图，再按其约束建议并填写；说明依据，冲突时询问。模式标志本身不是授权。
- 参数设置后读取实际生效值。网站更改或重置用户选择时报告差异，不能以流程能继续为由接受替换值。
- 上传、预览和报价不自动授权建立订单。用户已授权建单时先检查摘要，再明确提交，不把报价当作订单或付款。
- 每笔余额付款都须人类确认当前账号、订单、金额和支付方式。只有本次摘要确获人类明确同意后才能传入 `--human-confirmed`；不得伪造确认或修改本地确认记录。CLI 校验绑定、时效和一次性使用，标志本身不能证明对话事实。初始化、auto 和接管不能替代付款确认。
- 结果未知时先核实原任务和订单，不重新提交或付款。保持任务、文件、账号配置和页面对应关系；接管不能扩大已有业务授权。

只报告命令实际核实的结果。二维码交付、登录完成、解析完成、创建订单、已支付分别是不同状态。缺失字段不编造；站点脱敏信息不补全。可用能力与真实验收边界以当前 CLI 帮助和项目验收记录为准。
