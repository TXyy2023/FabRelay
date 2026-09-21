# jlc-com-cli 0.2.0 验收报告

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
- 嘉小智 iframe 已实际展开，通过“输入消息...”提交钻孔文件问题，并回读到稳定、非空的嘉小智回复。
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
