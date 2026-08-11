# jlc-com-cli 0.3.0 验收报告

日期：2026-08-11
环境：Windows x64（headless，系统会话），Node.js v24.18.0
业务入口：`https://test.jlc.com/`（测试账号 00012A）

## 本轮实现

### 需求文档与首次警告

- `.md` 需求文档重写：核心功能清单补齐（PCB 前置审单、3D 预览导出标注为规划不实现；上传/全参数下单/预览图/下单/余额付款/进度追踪/18 项更多操作）；警告与 mode 章节按新语义改写。
- 首次警告升 v2：明确**第三方工具**、**所有操作由用户执行并自行承担风险**；v1 回执自动失效（本机实测 required=true）；新增 `AGENT_RELAY_NOTICE`，非交互被拒时 JSON 错误信封携带 `details.notice` + `details.agentRelay`，`disclaimer show` 同输出；SKILL.md 增加"首次访问必须向用户转述警告"强制步骤。

### 模式改名 hard/simple

- `hard`（严谨，原 manual）/`simple`（AI 选择，原 auto）；`manual`/`auto` 作为兼容别名；旧配置读取时迁移、写回时持久化为新值（本机 config 由 manual 迁移为 hard 实测）。
- CLI/TUI/README/JSON Schema 全链路同步；`parseAgentMode` 报错文案更新；版本号 0.3.0。

### 订单 18 项更多操作

- 注册表（`src/workflows/order-action-registry.ts`）：18 个动作、中文菜单匹配、三级风险分层。
- 页面对象（`src/pages/order-actions-page.ts`）：解析订单卡"更多操作"触发的 el-popover（①–⑱ 项），hover 打开、内层 `<a>` 点击、disabled 快速失败、对话框/下载/弹层处理、敏感文本脱敏。
- 工作流 + CLI：`orders actions/memo/delete/follow/unfollow/block-reorder/shipping/certificate/pause/share/template reselect|modify/label add|remove/urge review|ship/contract/delivery-note/reorder`；TUI `/actions <order-id>`。
- 闸门：read 免确认；reversible-write 需交互确认或 `--confirm <订单号>`；dangerous-write 必须 `--confirm` 精确等于订单号，缺失/不匹配即 `APPROVAL_REQUIRED` 且不执行。

### 密码自动登录（新增能力）

- `auth login --username <u> --password-stdin` 全自动：HOME 入口 → passport 账号表单 → AliyunCaptcha 滑块以拟人轨迹求解（`--disable-blink-features=AutomationControlled` + webdriver 覆盖）→ 订单子系统 CAS 票据 bootstrap 循环。
- `auth status` 改为以带 XSRF-TOKEN 的订单 API 探针为准，杜绝"页面壳可见但 CAS 已死"的误报（rawSignal: order-api-unauthenticated）。
- 修复 redact 误伤：24+ 位 kebab-case 诊断串不再被替换为 `<redacted-token>`。

## 自动验证

- TypeScript 类型检查通过。
- 8 个 Vitest 文件、68 项测试通过（新增：注册表完整性/分层/参数校验/确认闸门/toast 文本启发式/文件名脱敏/滑块轨迹/标签语义/redact 回归等 24 项）。
- `npm run build` 通过；`OrderActionsSnapshot`/`OrderActionResult` JSON Schema 重新生成并随 `schema` 命令发布。

## 真实测试站验证（headless）

- **自动登录从零跑通**：logout 清会话 → `--password-stdin` 一次成功（表单+滑块+票据），回读客编 00012A。
- `orders list` 实际回读 85 笔订单。
- `orders actions Y49436` 18/18 全部解析，带站点 `*` 状态提示。
- 可逆操作实测：follow/unfollow（菜单提示后缀回读校验状态翻转）、编辑备忘录（卡面回读"订单备忘备注：jlc-cli 0.3.0 e2e"）、添加标签"test"（修改成功）→ 移除标签清空（移除成功）、催审单（站点回复"审单员下班了…"如实返回 unknown）。
- 受阻操作 fail-closed：打印合同/下载质量保证书/暂停生产/分享到硬创社 在当前订单状态 disabled，未点击即报 `PAGE_BUSINESS_ERROR`。
- 高危操作实测：`delete` 无 `--confirm` → `APPROVAL_REQUIRED` 拒绝；有实收金额的订单被站点拒绝（failed，原文回读）；零实收已取消订单 P13277 删除成功（新列表回读不存在）；`reorder` 文件进入重下单流程且**未自动提交**。

## 未执行的高影响动作

- 未新建订单、未付款（仍走既有人工审批链路）。
- 暂停生产/重选模板/修改模板/修改收货信息 未在活订单上执行（站点对该订单 disabled 或需额外参数）；其闸门、可用性与错误路径已验证。

## 遗留与说明

- `.test-login`（用户名/密码两行）仅存于本机，已加入 .gitignore；密码只经 stdin 传入。
- 滑块为阿里云验证码，风控存在波动；求解器最多 4 次尝试，全部失败时报 `AUTH_INTERACTION_REQUIRED` 回退 headed 人工登录。

---

# jlc-com-cli 0.2.0 验收报告（历史）

日期：2026-08-07
环境：macOS ARM64，Node.js v25.3.0
业务入口：`https://test.jlc.com/`

## 本轮实现

- 修复 Gerber 钻孔误识别：只有 X2 钻孔元数据或通过内容校验的 Excellon 才能标记为钻孔层。
- 修复条件工艺字段：无 Gerber 时不渲染的 `阻抗管控`、`外层铜厚` 等字段返回 `unavailableGroups`，不再误报 `CONTRACT_DRIFT`。
- 修复订单列表加载时序：必须等待订单卡片或权威空状态，查询和分页后也要回读变化。
- 新增结构化审核结果：`orders audit <order-id>`。
- 新增到收货的状态模型：生产、物流和 `delivered` 分开保存，未知文案不猜测。
- 新增平台/站内消息页面读取：`messages list`和 TUI `/messages`。
- 新增嘉小智页面对话：`xiaozhi question <question...>`和 TUI `/xiaozhi <question>`。
- 新增余额付款三段式流程：`payment prepare -> payment approval create -> payment execute`。
- 付款审批和报价/建单审批隔离，绑定订单、金额上限、`balance` 方式、有效期和本机 Keychain 签名。
- 付款未知状态启用独立幂等记录，同一 request-id 不得二次点击。
- TUI 新增审核、付款快照、消息和嘉小智命令，嘉小智问答使用独立面板显示。

## 自动验证

- TypeScript 类型检查通过。
- 7 个 Vitest 文件、44 项测试通过。
- 覆盖文本文件不得误判为钻孔、物流签收状态、付款金额回读、付款幂等、新 TUI 命令和新 JSON Schema。
- `npm run build` 通过，生成的 JSON Schema 与 TypeScript 域模型同源。

## 真实测试站页面验证

以已登录的 CLI 专用 Chrome profile 通过 Playwright 完成：

- 登录态、PCB 下单页和订单列表可访问。
- 候选 ZIP 现正确返回 `hasDrill: false`，`PCB下单必读.txt` 为 `unknown`，并有 `NO_DRILL` 警告。
- `pcb options` 在无 Gerber 初始页面回读 45 个当前可见选项；条件字段不再导致退出码 7。
- `orders list` 实际回读到订单；指定 `limit=5` 时返回 5 条，而不是空数组。
- `orders audit` 对现有样本回读到审核状态和页面详情。
- `messages list` 通过页面消息面板回读 7 条企业动态；当次站内消息为空。
- 嘉小智 iframe 已实际展开，通过"输入消息..."提交钻孔文件问题，并回读到稳定、非空的嘉小智回复。
- 对一条现有待付款订单生成了 `balance` 付款快照和本地截图；未生成付款审批，未进入付款页，未扣款。

## 未执行的高影响动作

- 本轮候选 Gerber 缺少真实钻孔文件，且没有正式工艺要求证据，因此没有上传它。
- 没有创建新报价、报价审批或新订单。
- 没有点击订单最终提交。
- 没有代替用户生成付款审批，没有点击最终支付，余额未变化。
- 新订单的生产、发货和实物收货需要真实时间推进，不能在本次短时验收中伪造为已完成。

## 发布产物

- npm tarball：`jlc-com-cli-0.2.0.tgz`，已全局安装并回读版本 `0.2.0`。
- SHA-256：`69d8c9b1fcc3c0fe9ddd6adec120c07bbcb99ebf931fef659e1052130fc0f771`。
- 发布包仅含 `dist/`、JSON Schema、README、LICENSE 和 package metadata；不含 source map、测试、研究文档、预览、profile 或验收报告。
- 本轮没有执行警告接受；实际配置已存在早于本轮的有效接受回执。
