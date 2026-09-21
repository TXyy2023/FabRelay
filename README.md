# jlc-cli

面向人类和 AI Agent 的嘉立创中国站 `jlc.com` 业务 CLI。封装登录、PCB 文件上传与网站预览、参数设置、报价、建单、订单查询、经人类确认的余额付款及嘉小智文本对话；支持保留 Obscura/Chrome 会话，异常时通过同一 CDP 页面接管。

当前包版本为 `1.0.0-dev.1`。这是开发交付，不代表已在 npm 发布或完成全部真实站点及跨平台验收。每项验证的证据边界见 [验收记录](docs/acceptance.md)。

**当前实站使用请显式选择 Chrome。** Chrome 已验证微信快捷登录、真实二维码交付、签名登录通知、独立配置的会话恢复、账号与现有 PCB 订单查询，以及生成的 Gerber 测试包上传、解析、参数设置、报价和实际 PCB 预览。默认引擎仍为 Obscura，其运行时和公开首页可用，但本轮客户中心 SPA 空白及登录 iframe 兼容问题尚未解决，不能据 Chrome 结果宣称 Obscura 的登录后业务可用。

## 安装与检查

需要 Node.js **22.12 或更高版本**。CLI 目标平台为 macOS、Windows、Linux；Obscura 浏览器的具体系统和 CPU 架构支持须以可用的上游构建及实际验证为准。

从本仓库构建 npm 安装包：

```text
npm ci
npm run build
npm pack
npm install -g ./jlc-com-cli-1.0.0-dev.1.tgz
jlc-cli --version
jlc-cli --help
```

`npm pack` 执行类型检查、测试及构建，把 CLI、文档和 Skill 一起打包。也可使用 `node dist/cli.js` 直接运行本次构建。不要将登录凭据或浏览器配置复制进仓库。

当前快速开始使用已安装的 Google Chrome；可执行文件可从标准安装位置发现，也可用 `browser configure --engine chrome --executable "path/to/chrome"` 指定实际路径。浏览器在业务命令需要时启动，CLI 中继保留连接，避免命令退出时丢失页面。Chrome 也支持显式连接本机原始 CDP。由外部端点切回自有浏览器时加 `--clear-endpoint`；切换已有自有浏览器的引擎前，先用 `browser stop` 停止该会话。

要验证默认的 [Obscura](https://github.com/h4ckf0r0day/obscura) 运行时，安装官方浏览器后将 `obscura` 放入 PATH，或配置 `--engine obscura --executable "path/to/obscura"`。已有 Obscura 会话只接受本 CLI 保留的中继端点，不能直接填写 Obscura 原始 CDP 地址。其当前站点限制、安装与保留行为见 [浏览器运行说明](docs/browser.md)。

## 快速开始

先阅读初始化授权说明，再由已明确同意的人类完成交互式 `init`，或由调用方根据该人类明确同意传入 `--accept --confirmed-by`。初始化不包含具体付款授权。

```text
jlc-cli init
jlc-cli browser configure --clear-endpoint --engine chrome
jlc-cli browser doctor --json
jlc-cli auth login --method qr --wait 300 --events
jlc-cli auth status --json
jlc-cli account show --json
```

先确认 `browser doctor` 返回的 `data.available`，命令正常输出不等于浏览器已可用。扫码登录向调用方交付当前二维码素材；Agent 应立即展示给人类。登录成功以当前账号身份核实为准。`--events` 是逐行 JSON 事件，适合先取得二维码再等待成功；不加 `--events` 时可用 `--json` 读取最终结果。会话有效时后续命令复用，无需重新扫码。密码和短信验证码仅通过 `--password-env NAME`、`--code-env NAME` 指定的环境变量传入，不能把值写进日志。

登录方式可选 `manual`、`qr`、`wechat`、`password`、`sms`，以当前页面实际开放的方式为准。`wechat` 使用官方微信快捷登录按钮；`qr` 在快捷面板出现时切换到其他账号扫码界面并交付真实二维码。快捷登录要求注册或绑定身份时返回需要用户决定，不自动完成身份绑定。短信验证码目前由人类在保留的网站页面获取，CLI 只接收已有验证码；自动请求短信未实现，短信登录尚未实站验收。

全局参数：`--json`、`--home DIR`、`--profile NAME` 和 `--timeout MS`。超时默认 30000 毫秒，`--wait [seconds]` 的等待时间默认 300 秒。默认数据目录为 `JLC_HOME` 或用户目录下的 `.jlc-cli`，账号配置位于其 `profiles/NAME`。始终在同一工作流中使用相同 profile。

## 从文件到报价

下面是业务命令的衔接方式。本轮使用生成的 **FR4、2 层、10 mm 合成测试板**，在真实网站完成上传解析、当前表单参数设置、报价及实际 PCB 画布预览；采用手动确认订单，未提交或付款。该路线当时显示 CNY 40.00，报价绑定文件与参数哈希；这是这次测试的实时报价，不是固定价格，也不代表其他工艺组合已验收。

```text
jlc-cli pcb upload "board.zip" --json
jlc-cli pcb options --draft UPLOAD_TASK --json
jlc-cli pcb set --draft OPTIONS_TASK --params @values.json --mode default --json
jlc-cli pcb preview --draft SET_TASK --json
jlc-cli pcb quote --draft PREVIEW_TASK --json
jlc-cli pcb check --draft QUOTE_TASK --json
```

上面的任务标识是示意值。**每一步返回新的 `taskId`，下一步的 `--draft` 使用最新成功结果中的 ID。** `values.json` 是字段名到明确取值的 JSON 对象；字段名、候选值和条件依赖来自当前 `pcb options`。2026-09-21 [核对的页面](docs/site-evidence.md) 说明支持 Gerber/PCB 源文件 zip/rar 压缩包、不超过 100M。格式与大小符合要求仍须等待网站实际解析，`.zip` 扩展名本身不能保证可解析。

PCB 连续链使用 `--draft` 保留对应页面；无 `--draft` 的独立查询可创建新页面。同一 CDP 端点可以有多个页面，接管须使用对应任务返回的 `data.cdp.targetId`，不能只凭端点猜测页面。

用户授权建单后使用 `pcb submit --draft CHECK_TASK`；提交不会自动付款。查询入口是 `orders list`、`orders show ORDER`、`orders progress ORDER`。余额付款使用 `payment prepare` → 人类核对摘要 → `payment confirm` → `payment execute`，具体命令和确认绑定见 [付款说明](skills/jlc-cli/references/orders-payment.md)。

## Agent Skill 与恢复

```text
jlc-cli skill path --json
jlc-cli skill install --to "path/to/agent/skills" --json
```

安装会在目标 skills 根目录创建 `jlc-cli` 子目录，已有目录不会覆盖。加载 [Skill](skills/jlc-cli/SKILL.md) 可按需阅读登录、参数、付款、回调和恢复说明。Skill 与 CLI 一起打包，不依赖开发者本机路径。

当返回 `handoff` 时，按结果获取同一页面的 CDP 地址、页面标识与诊断素材，使用 `handoff acquire TASK` 取得租约后接管，结束时通过 `handoff release TASK --lease LEASE_ID` 释放。`task watch TASK --wait 300` 先核实业务状态：原参数设置、提交或付款尚未发起且前置条件重新满足时，可自动继续原步骤；已记录提交或扣款意图时只核实结果，不重做。关闭观察进程后没有常驻业务观察器，浏览器中继仍可保留会话。

## 业务边界

`default` 不把网站预选参数当作用户决定。`auto` 仅在用户已让外部 Agent 帮助选填时使用，仍须保留明确约束。CLI 不内置模型，也不能通过一个模式或确认标志证明真实对话中的授权。

上传与预览使用网站原生能力，不进行 EDA 文件转换或本地 Gerber 渲染。设置参数后回读实际值；修改影响价格的内容后重新报价。报价、建立订单、支付成功分别报告。

每笔余额付款必须由人类确认当前账号、订单、金额和方式；初始化、自动参数模式及 CDP 接管不能替代这次确认。超时不等于付款失败。开发 CLI 的授权不包含替用户真实建单或扣款。

订单命令使用官网“PCB / FPC订单”的共用列表入口；当前实测现有 PCB 记录的列表、详情与进度，FPC 记录字段及详情差异尚未验收。FPC 新下单不在本版范围。嘉小智提供 `xiaozhi ask "问题"` 文本命令，真实发送与对应回复仍待验收；不承诺附件、流式协议或可移植历史。

## 开发与验证

```text
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

[设计说明](docs/design.md) 记录责任划分、任务持久化、授权、回调和接管规则。[验收清单](docs/acceptance.md) 覆盖 PRD F01–F14，并区分测试夹具、真实浏览器、生产站点和平台支持。历史材料保留在 `docs/archive`，不作为本次重写实现或验收的依据。
