---
name: fabrelay
description: FabRelay is an unofficial JLC China (嘉立创, jlc.com) CLI skill for PCB/Gerber upload, preview, manufacturing parameters, quotes, orders, login and QR login. Use fabrelay for website business workflows, human-confirmed balance payments, and Jia Xiaozhi; not schematic editing, local Gerber conversion, or overseas JLCPCB.
license: MIT
metadata:
  repository: https://github.com/TXyy2023/FabRelay
---

# FabRelay

通过业务 CLI 操作嘉立创中国站。这是非官方社区项目，没有嘉立创官方背书。常规流程使用命令；只有命令返回待接管时才操作它保留的 CDP 页面。

## 安装检查

项目旧名为 `jlc-cli`，当前命令为 `fabrelay`；不要把旧命令可用当作新 CLI 已安装。升级会兼容既有数据目录和登录状态，详见仓库 README。

执行任何业务命令前，先运行 `fabrelay --version`，成功后再运行 `fabrelay --help`。安装本 Skill 不会自动安装 CLI。

如果提示找不到命令（`command not found` / 无法识别），向用户说明 CLI 尚未安装或未加入 PATH，并提供[项目仓库与安装说明](https://github.com/TXyy2023/FabRelay#快速开始)。当前未发布到 npm，不要安装同名的第三方包。准备 Node.js 22.12 或更高版本、npm、Git 和 Google Chrome 后，可从源码安装：

```sh
git clone https://github.com/TXyy2023/FabRelay.git
cd FabRelay
npm ci
npm run build
npm pack
npm install -g ./fabrelay-1.0.0-dev.3.tgz
fabrelay --version
fabrelay --help
```

包名对应当前开发版本，版本变化时使用 `npm pack` 实际生成的文件名；已有源码目录时先核实路径，不覆盖用户的目录。安装后重新检查版本与帮助，再继续原任务。若命令存在但启动失败，报告实际错误并检查 Node.js 版本与 PATH，不把启动失败当作未安装而盲目重装。

## 开始

完成安装检查后，运行 `fabrelay browser doctor --json` 检查浏览器可用性。`fabrelay skill path` 返回随该 CLI 交付的 Skill，优先使用同版本说明。

首次使用先向人类呈现 `fabrelay init --json` 返回的初始化范围，取得明确同意后运行 `fabrelay init --accept --confirmed-by human`；也可由人类交互式运行 `init`。随后配置浏览器、发起登录并核实 `auth status`；扫码时向人类展示命令返回的当前二维码。登录完成以账号状态核实结果为准，不能只凭页面跳转或扫码动作。完成后可用 `fabrelay account show --json` 做一次查询。

当前实站流程显式使用 `fabrelay browser configure --clear-endpoint --engine chrome`。默认 Obscura 运行时已验证，但本轮真实客户中心 SPA 与登录 iframe 仍有兼容问题；不要把运行时可连接当作业务可用，也不要声称已自动切换浏览器。已有 CLI 自有会话切换引擎前先停止该会话，详见 [浏览器与登录命令](references/commands.md)。

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
