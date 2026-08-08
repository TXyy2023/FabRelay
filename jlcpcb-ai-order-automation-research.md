# 嘉立创 / JLCPCB AI 自动化下单与订单追踪调研

> 调研日期：2026-08-01
> 调研对象：中国嘉立创（`jlc.com` / `open.jlc.com`）、海外 JLCPCB（`jlcpcb.com` / `api.jlcpcb.com`），以及公开的 CLI、MCP、Python API 和 EasyEDA 工作流项目。

## 1. 调研目标

本调研回答以下问题：

1. 是否已经有软件可以让 AI 接收 Gerber 文件和 PCB 制造参数，自动完成报价、下单和订单追踪？
2. 如果参数不完整，AI 是否可以根据 Gerber 和制造目标自动补全或选择参数？
3. 哪些项目是真正连接了 JLCPCB 订单 API，哪些项目只是元器件搜索、Gerber 导出或浏览器准备工具？
4. 哪些能力已经有真实运行证据，哪些只有源码、mock 测试或逆向接口推断？
5. 如果要落地，应该选择官方 API、现有 MCP，还是浏览器自动化？

## 2. 结论摘要

### 2.1 直接结论

有技术路径，但截至本次调研，没有找到一个可以确认满足以下全部条件的成熟现成软件：

- 不需要嘉立创 API 入驻审批；
- 不需要用户配置账户凭证；
- AI 接收 Gerber 后自动补全所有制造参数；
- 自动完成真实付费下单；
- 自动稳定追踪生产、发货和物流；
- 已有公开的第三方端到端真实订单验证。

最现实的实现方式是：

```text
AI / MCP
  -> 官方 JLCPCB API
  -> Gerber 上传与工程预审
  -> 报价
  -> 人工确认参数、金额、地址和付款
  -> 创建订单
  -> 订单详情 / 生产进度 / 物流信息查询
```

### 2.2 最值得关注的项目

| 目标 | 首选 | 判断 |
|---|---|---|
| 海外 JLCPCB，快速做 MCP 原型 | [`jlcpcb-mcp`](https://github.com/Eyalm321/jlcpcb-mcp) | 当前公开项目中最接近“Gerber → 报价 → 订单 → 生产状态”的完整 MCP |
| 海外 JLCPCB，自建服务或 MCP | [`jlcpcb_api`](https://github.com/i2cjak/jlcpcb_api) | Python 底层客户端，适合自己控制权限、审计和业务逻辑 |
| 需要 Swamp 工作流编排 | [`swamp-jlcpcb`](https://github.com/NeilHanlon/swamp-jlcpcb) | 有上传、报价、下单和状态模型，但明确是 BETA，未端到端验证 |
| 只做历史订单和物流追踪 | [`jlcpcb-cli`](https://github.com/hatlabs/jlcpcb-cli) | 查询能力较完整，但不是新的 Gerber 下单客户端 |
| 中国嘉立创 | [官方开放平台](https://open.jlc.com/) + 自建 MCP | 最稳妥；不能直接把海外项目的 endpoint 当作国内接口使用 |

### 2.3 最重要的判断

`jlcpcb-mcp` 的源码和 npm 发布包确实包含创建真实付费订单的工具，但其测试把官方网络客户端 mock 掉了。它证明了“调用路径已实现”，不能证明“任意用户拿来就能真实下单”。

`swamp-jlcpcb` 的 README 更明确地写出：实时 API 尚未完成端到端测试，API 权限在发布时处于待审或被拒状态。因此，第三方项目的“支持下单”应理解为“实现了下单调用逻辑”，而不是“已经验证过生产账户下单成功”。

## 3. 自动化能力分级

为了避免把不同能力混在一起，本调研把自动化分为五级：

| 等级 | 能力 | 是否等同于真实下单 |
|---|---|---|
| L0 | 生成 Gerber、BOM、CPL、JLCPCB 格式 ZIP | 否 |
| L1 | 上传文件、解析/预审、计算报价和交期 | 否 |
| L2 | 创建订单草稿、购物车或订单请求 | 不一定 |
| L3 | 服务端确认创建订单，返回订单号/批次号 | 接近，但仍要核对付款和生产状态 |
| L4 | 付款完成、进入生产，并能查询生产和物流状态 | 才能称为端到端闭环 |

本次找到的公开项目，大部分达到 L1 或 L2；`jlcpcb-mcp`、`swamp-jlcpcb` 和 `i2cjak/jlcpcb_api` 具备达到 L3 的代码路径，但没有公开足够的 L4 证据。

## 4. 官方平台调查

### 4.1 中国嘉立创开放平台

官方入口：

- [嘉立创开放平台首页](https://open.jlc.com/)
- [开发指南](https://open.jlc.com/develop-guide)
- [创建应用](https://open.jlc.com/develop-guide?doc=create)
- [配置密钥](https://open.jlc.com/develop-guide?doc=config)
- [请求签名](https://open.jlc.com/develop-guide?doc=signature)
- [网页 PCB 下单入口](https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder)

### 官方明确写出的能力

开放平台首页写明，它基于嘉立创的下单、交易、物流等基础服务开放给生态合作伙伴；PCB 智造场景支持：

- PCB 在线计价；
- 创建订单/返单；
- 查询订单信息和进度；
- 企业 ERP 对接；
- 自动订单跟进。

因此，国内嘉立创官方确实存在企业级接口路线，不能说“完全没有 API”。但它也不是匿名、免认证的公共 API。

### 接入前置条件

官方开发指南要求：

1. 入驻开放平台并通过审批；
2. 创建应用；
3. 开通相应业务/API 权限；
4. 配置 `accessKey` 和 `secretKey`；
5. 按 JOP 规则生成 HMAC-SHA256 签名；
6. 按官方文档处理业务返回码和权限范围。

官方还明确说明：

- API 请求使用 HTTPS；
- 普通请求使用 JSON，文件上传使用 multipart；
- HTTP 200 只表示请求被接收并返回响应，不代表业务执行成功；
- 必须继续检查业务 `code` 和 `message`。

### 国内接口的关键边界

公开首页证明了“计价、订单、进度”能力存在，但公开页面没有把所有国内业务 endpoint、参数枚举、付款方式和物流字段完整展开。因此，在没有拿到自己账号的官方开发文档和权限列表前，不应直接复制海外项目的路径，例如：

```text
/overseas/openapi/pcb/uploadGerber
/overseas/openapi/pcb/calculate
/overseas/openapi/pcb/create
```

这些路径来自海外 OpenAPI 的 SDK、客户端或第三方项目，不能默认等价于中国嘉立创开放平台接口。

### 4.2 海外 JLCPCB API Platform

官方入口：

- [JLCPCB API Platform](https://api.jlcpcb.com/)
- [API Documentation](https://api.jlcpcb.com/docs/start)
- [海外订单追踪帮助页](https://jlcpcb.com/help/article/51-How-to-Track-My-Order)

### 官方首页明确宣传的能力

海外 API 平台面向 Enterprise Users 和 Distributors，页面明确宣传：

- online quoting；
- automated purchase orders；
- production、logistics 和 order tracking 的实时数据同步；
- PCB API 的实时报价、下单和订单生命周期管理；
- real-time status tracking。

官方流程是：

```text
Apply for API access
  -> Create an app
  -> Start development and testing
```

### 接入条件

海外平台同样需要注册开发者账号、申请 API access、创建应用并获得相应权限。详细文档和业务 scope 可能需要登录后确认。

### 公开项目常见的海外 PCB API 路径

下面这些路径由多个公开客户端、SDK 逆向文档和 MCP 项目重复使用，属于“第三方实现中高度一致的接口形状”，但具体参数和权限仍应以自己的官方应用文档为准：

| 业务 | 常见方法和路径 | 作用 |
|---|---|---|
| Gerber 上传 | `POST /overseas/openapi/pcb/uploadGerber` | 上传 Gerber ZIP，返回 `fileKey` 或类似文件引用 |
| 报价 | `POST /overseas/openapi/pcb/calculate` | 按文件和工艺参数计算价格、交期和运费 |
| 创建订单 | `POST /overseas/openapi/pcb/create` | 创建 PCB/钢网订单 |
| 订单详情 | `POST /overseas/openapi/pcb/order/detail` | 按批次号查询订单详情 |
| WIP | `POST /overseas/openapi/pcb/wip/get` | 查询生产中的工序或状态 |
| 工程审核 | `POST /overseas/openapi/pcb/audit/get` | 查询 Gerber/订单审核信息 |

### 物流追踪的证据等级

官方首页对 logistics tracking 有宣传，但公开项目所展示的接口大多是订单详情和 WIP 查询：

- `swamp-jlcpcb` 把订单状态接口返回值中的部分内容归一化为 `tracking`；
- `jlcpcb-cli` 通过网页登录后的订单详情接口可以提取 `trackingNumber`/快递单号字段；
- 目前没有找到一个无需账号权限即可确认的、独立且稳定的物流 webhook 公开说明。

因此，更严谨的表述是：

> 海外官方平台明确支持订单生命周期和物流相关数据同步；生产进度查询有较明确的公开接口迹象；独立物流查询、回调和可用字段必须在实际 API 账号权限下验证。

### 4.3 国内网页自动化路线

国内网页端存在标准 PCB 下单入口：

<https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder>

公开页面可以看到板层数、尺寸、数量、阻焊颜色、字符颜色、表面处理、SMT/钢网、收货地址、交期和提交订单等界面。浏览器自动化理论上可以完成：

1. 登录；
2. 上传或提交 Gerber；
3. 填写参数；
4. 获取预估价格；
5. 检查订单；
6. 确认并提交。

但它不是稳定的公开 API，风险包括：

- 登录态、Cookie、验证码和风控；
- 页面字段和前端 bundle 经常变化；
- 付款方式和收货地址属于高敏感外部状态；
- 提交订单可能触发真实扣款或订单确认；
- “看到订单页面”不等于服务器创建成功。

如果没有官方 API 权限，浏览器路线适合作为“AI 准备订单 + 人工最后确认”的辅助流程，不适合作为无人值守自动付款系统。

## 5. 重点第三方项目详查

### 5.1 `jlcpcb-mcp`

项目：

- [GitHub](https://github.com/Eyalm321/jlcpcb-mcp)
- [npm](https://www.npmjs.com/package/jlcpcb-mcp)
- [PCB tool source](https://github.com/Eyalm321/jlcpcb-mcp/blob/main/src/tools/pcb.ts)
- [PCB tests](https://github.com/Eyalm321/jlcpcb-mcp/blob/main/src/__tests__/tools/pcb.test.ts)

### 发布和安装

当前 npm 包版本为 `0.3.3`，以 stdio MCP server 运行：

```bash
npx -y jlcpcb-mcp
```

README 给出的 Claude Code 配置形式是：

```bash
claude mcp add jlcpcb -- npx -y jlcpcb-mcp
```

### 与 PCB 下单相关的工具

| MCP 工具 | 能力 |
|---|---|
| `jlcpcb_pcb_upload_gerber` | 上传 Gerber ZIP，返回 `fileKey` |
| `jlcpcb_pcb_upload_blind_via_hole_img` | 上传盲埋孔叠层图片 |
| `jlcpcb_pcb_impedance_template_list` | 查询阻抗模板 |
| `jlcpcb_pcb_stencil_price_config` | 查询钢网价格配置 |
| `jlcpcb_pcb_calculate_price` | PCB/钢网报价，不创建订单 |
| `jlcpcb_pcb_get_order_detail` | 按批次号查询订单详情 |
| `jlcpcb_pcb_get_audit_info` | 查询工程审核信息 |
| `jlcpcb_pcb_get_wip_process` | 查询生产 WIP 状态 |
| `jlcpcb_pcb_create_order` | 创建真实付费 PCB/钢网订单 |

### 配置项

```text
JLCPCB_APP_ID
JLCPCB_ACCESS_KEY
JLCPCB_SECRET_KEY
JLCPCB_ENDPOINT
JLCPCB_ENABLE_ORDERS
```

其中：

- 前三个用于官方 API 鉴权；
- `JLCPCB_ENDPOINT` 默认是 `https://open.jlcpcb.com`；
- `JLCPCB_ENABLE_ORDERS` 默认关闭；
- 只有同时配置凭证并显式开启订单开关，才会调用创建订单工具。

### 代码和测试证明了什么

源码中确实存在：

- Gerber multipart 上传；
- HMAC/JOP 签名；
- 报价请求；
- 订单详情和 WIP 查询；
- `/overseas/openapi/pcb/create` 创建订单调用。

测试中明确验证了：

- 没有凭证时工具不调用网络；
- 报价会把参数发送到 calculate 路径；
- WIP 使用 `orderUUID`；
- 订单开关关闭时不创建订单；
- 订单开关打开时会调用 create 路径。

但测试把 `officialRequest` 和 `officialUpload` 替换成 Vitest mock，README 也说明测试会 mock 网络和数据库。因此，它没有证明：

- API 账号已经获批；
- Gerber 在真实账号中上传成功；
- 报价参数与实际页面完全一致；
- 真实订单已生成并付款；
- 物流字段在你的账号下可用。

### 适用判断

这是目前最好的海外 MCP 原型，但不建议直接把 `jlcpcb_pcb_create_order` 暴露给完全自主的 AI。应先将它改成 quote-only，再加人工审批层。

### 5.2 `swamp-jlcpcb`

项目：<https://github.com/NeilHanlon/swamp-jlcpcb>

它把 JLCPCB 作为 Swamp 自动化图中的 fabrication 节点，模型方法包括：

- `upload_gerber`；
- `quote`；
- `order`；
- `order_status`。

README 还定义了带来源和 SHA-256 的证据对象，例如：

```text
{ vendor, quoteUsd, leadTimeDays, orderRef }
```

优点是把报价、订单和证据链建模得比较清楚。缺点也很明确：

- 项目标注 BETA；
- live API path 尚未端到端验证；
- API 权限按 partner 审批，发布时处于 pending/denied 状态；
- endpoint 和响应形状部分来自官方 Java SDK 的逆向分析。

它适合参考审计记录和工作流设计，不适合作为“已验证的生产下单软件”。

### 5.3 `i2cjak/jlcpcb_api`

项目：<https://github.com/i2cjak/jlcpcb_api>

这是 Python 客户端，提供 PCB service：

- `upload_gerber_file`；
- `get_online_calculate_price`；
- `create_order`；
- `get_order_detail_by_batch_num`；
- `get_pcb_wip_process`；
- `get_pcb_audit_info`；
- 钢网价格和阻抗模板接口。

客户端处理了：

- JOP 签名；
- multipart Gerber 上传；
- `J-Trace-ID` 读取；
- HTTP 状态码与业务 `code` 双重判断；
- `code == 200` 才视为业务成功。

测试主要验证请求构造、multipart 字段和官方签名样例，属于很好的底层封装参考，但不是实单验证。

如果要自建中文 MCP 或内部 CLI，这个项目比直接复制前端请求更适合作为代码参考；但是仍要先确认它的接口版本和你的账号区域。

### 5.4 `jlcpcb-cli`

项目：<https://github.com/hatlabs/jlcpcb-cli>

这是一个订单数据 CLI，通过真实 Chrome 登录后保存 Cookie，再调用嘉立创网页 API：

```bash
jlcpcb-cli login
jlcpcb-cli --json orders list
jlcpcb-cli --json orders list --status production
jlcpcb-cli --json orders get <batch-number>
```

支持：

- 订单批次列表；
- `shipped`、`production`、`cancelled`、`unpaid`、`review` 状态筛选；
- PCB/SMT/3DP 订单详情；
- 费用拆分；
- 物流方式和快递单号；
- 付款记录、退款、发票。

它很适合作为订单追踪适配器，但 README 没有提供创建 Gerber 订单或报价的功能。由于 Cookie 保存和网页 API 依赖，它比官方 Open API 更容易受网站变化影响。

### 5.5 其他 AI/EDA 项目

### `kicad-jlcpcb`

项目：<https://github.com/BeckhamLabsLLC/kicad-jlcpcb>

它通过 Claude Code + MCP 完成：

- LCSC/JLCPCB 元件搜索；
- KiCad PCB 生成；
- pin map 获取；
- Gerber 打包；
- EasyEDA 交接。

项目自己说明最终流程是把 PCB 放入 EasyEDA，再由 EasyEDA 路由和下单，仍然需要打开网页并点击。因此它是“设计到可下单文件”的工具，不是 API 订单执行器。

### `pcba-design-skills`

项目：<https://github.com/Keitark/pcba-design-skills>

它包含 Codex/Claude Code 的 PCBA 设计、发布、报价和订单准备技能，强调：

- BOM/CPL/生产文件一致性；
- 报价和摆件预览；
- 用户审批门；
- 在真正提交订单前安全停止。

这是安全工作流参考，不是无人值守下单器。

### `easyeda-mcp-pro` 和 `Spectoda/easyeda-mcp`

项目：

- [easyeda-mcp-pro](https://github.com/oaslananka/easyeda-mcp-pro)
- [Spectoda/easyeda-mcp](https://github.com/Spectoda/easyeda-mcp)

它们主要用于 EasyEDA 项目检查、BOM、DRC、Gerber/CPL 导出和供应商信息。`easyeda-mcp-pro` 的 vendor terms 明确禁止没有人工确认的自动付费 JLCPCB 订单；`Spectoda/easyeda-mcp` 也将订单流程定义为 human review/browser handoff。

## 6. Gerber 和参数能否由 AI 自动补全

### 6.1 裸 PCB

Gerber ZIP 通常可以提供或推导：

- 铜层数量；
- 板框尺寸；
- 铜层和阻焊层；
- 钻孔文件；
- 字符层；
- 部分特殊结构。

但 Gerber 本身通常不能可靠表达下列制造意图：

| 参数 | Gerber 是否可靠提供 | 是否需要用户确认 |
|---|---:|---:|
| 层数 | 通常可以推导 | 建议确认 |
| 长宽 | 通常可以推导 | 建议确认 |
| 板厚 | 通常不能 | 是 |
| 材料 | 通常不能 | 是 |
| 外层/内层铜厚 | 通常不能完整推断 | 是 |
| 阻焊颜色 | 通常不能 | 是 |
| 字符颜色 | 通常不能 | 是 |
| 表面处理 | 通常不能 | 是 |
| 阻抗叠层 | 不能仅凭普通 Gerber 确定 | 是 |
| 数量 | 不能从单份 Gerber 可靠确定 | 是 |
| 拼板方式 | 不能可靠确定 | 是 |
| 交期和运输 | 与 Gerber 无关 | 是 |
| 收货地址/付款方式 | 与 Gerber 无关 | 是 |

因此，AI 可以做“候选参数生成”和“报价方案比较”，不应把推测结果直接当作用户授权的制造规格。

### 6.2 PCBA/SMT

如果目标是贴片成品，而不是裸 PCB，通常还需要：

- Gerber；
- BOM；
- CPL/POS/坐标文件；
- 贴片面；
- 元器件替代策略；
- 基础/扩展料选择；
- 钢网、工艺边、MARK 点等装配信息。

仅有 Gerber 不能完成 PCBA 下单。元器件库存、价格和替代关系还会随时间变化，不能只靠模型记忆。

### 6.3 推荐的 AI 参数策略

AI 应该把参数分成四类：

| 类别 | 处理方式 |
|---|---|
| 从 Gerber 可验证提取 | 自动提取，并提供原始文件依据 |
| 低风险默认值 | 可以根据用户预设 profile 生成，但要标记为默认 |
| 会影响质量/可靠性/成本的参数 | 给出候选值和影响，必须人工确认 |
| 地址、支付、订单提交 | 永远作为外部动作，必须单独确认 |

比较安全的交互是：

```text
AI: Gerber 推断为 2 层、100 x 80 mm，以下参数缺失：板厚、铜厚、表面处理、数量。
AI: 给出经济、可靠性、快速交期三个报价方案。
用户: 选择方案 B，数量 10，确认最高金额为 X。
系统: 重新报价并显示最终参数。
用户: 确认创建订单。
系统: 才调用 create order。
```

## 7. 推荐落地架构

### 7.1 分层架构

```text
本地文件层
  - Gerber ZIP / BOM / CPL
  - 文件大小、格式、SHA-256

解析和审查层
  - 层数、尺寸、钻孔、文件完整性
  - DFM/工程审核
  - 缺失参数清单

AI 决策层
  - 根据用户目标提出参数候选
  - 解释成本、交期和工艺影响
  - 不直接拥有付款权限

JLC 适配层
  - 官方 API 签名
  - 上传、报价、审核、订单详情、WIP、物流
  - 中国和海外 endpoint 分开实现

审批和审计层
  - 最终参数确认
  - 金额上限
  - 地址确认
  - 订单前后响应留档
```

### 7.2 建议的 MCP 工具面

建议把工具拆开，不提供一个“AI 自由控制所有订单行为”的超级工具：

| 工具 | 权限级别 | 作用 |
|---|---|---|
| `gerber_inspect` | 只读 | 解析文件、计算 hash、提取层数和尺寸 |
| `jlc_quote_pcb` | 外部读/报价 | 上传 Gerber并获取报价和交期 |
| `jlc_get_audit` | 外部读 | 获取工程审核结果 |
| `jlc_compare_options` | 只读/报价 | 比较不同工艺方案 |
| `jlc_create_order` | 高风险 | 仅在显式审批 token/确认后创建订单 |
| `jlc_get_order_detail` | 外部读 | 查询订单详情 |
| `jlc_get_production_status` | 外部读 | 查询生产工序和 WIP |
| `jlc_get_shipping_status` | 外部读 | 查询物流字段/快递单号 |
| `jlc_poll_order` | 外部读 | 定时轮询并生成状态快照 |

`jlc_create_order` 不应在普通会话中默认暴露；至少应有：

- 用户确认文本或确认按钮；
- quote ID 与最终订单参数绑定；
- Gerber hash 不变；
- 金额上限；
- 收货地址二次确认；
- 订单幂等/重复提交保护；
- 订单响应和批次号持久化。

### 7.3 审计记录建议

每次报价和下单至少保存：

```json
{
  "vendorRegion": "china-or-overseas",
  "gerberSha256": "...",
  "inputFiles": ["board-gerber.zip", "bom.csv", "cpl.csv"],
  "normalizedParams": {},
  "aiAssumptions": [],
  "userConfirmedParams": {},
  "quoteResponse": {},
  "quotedAmount": 0,
  "currency": "CNY-or-USD",
  "approval": {
    "confirmed": false,
    "confirmedAt": null,
    "maxAmount": null
  },
  "orderId": null,
  "batchNum": null,
  "productionSnapshots": [],
  "trackingNumber": null
}
```

不要把 `secretKey`、Cookie、支付信息或完整凭证写入该记录。

## 8. 分阶段实施建议

### 阶段 0：账号和区域确认

- 确认使用中国嘉立创还是海外 JLCPCB；
- 申请相应开放平台；
- 确认 API scope、付款方式和订单状态字段；
- 不把中国和海外 endpoint 混用。

### 阶段 1：只读和报价

只开放：

- Gerber 文件检查；
- 上传；
- 报价；
- 工程审核；
- 订单查询。

验收标准：

- 真实账号上传成功；
- 返回 `fileKey`；
- 业务 code 成功；
- 报价金额与网页人工报价可解释地一致；
- 失败时能显示业务错误，不只看 HTTP 200。

### 阶段 2：人工确认下单

- AI 生成最终参数表；
- 用户确认数量、工艺、地址、运输和最高金额；
- 系统记录 hash、quote response 和确认记录；
- 调用创建订单；
- 读取订单号/批次号/订单详情；
- 先不做无人值守循环下单。

### 阶段 3：生产和物流追踪

- 轮询订单详情和 WIP；
- 记录生产节点变更；
- 解析快递单号和发货状态；
- 若官方没有 webhook，则用定时任务轮询；
- 对生产状态和物流状态分别建模，避免把 WIP 当成物流轨迹。

### 阶段 4：受控自动化

只有在完成多次真实订单验证后，才考虑：

- 固定项目 profile 自动报价；
- 低金额订单自动提交；
- 固定收货地址白名单；
- 固定工艺白名单；
- 异常或价格变化自动暂停。

即使进入此阶段，也建议保留订单提交前的人工审批开关。

## 9. 风险与失败模式

| 风险 | 表现 | 对策 |
|---|---|---|
| API 未获批 | 401/403、权限不足 | 先申请并确认业务 scope |
| 区域混用 | endpoint 可访问但业务失败 | 中国和海外实现分成两个 adapter |
| 把 HTTP 200 当成功 | 请求返回但订单未创建 | 检查业务 code、message 和 data |
| mock 测试误导 | 本地测试通过，真实账号失败 | 必须用测试订单或真实低风险订单验证 |
| Gerber 参数缺失 | 报价与实际生产不一致 | 维护参数来源和人工确认状态 |
| AI 自行选择高风险参数 | 材料、阻抗、表面处理错误 | 设为强制确认字段 |
| 重复提交 | 重复订单或重复扣款 | hash、quote ID、订单状态和幂等保护 |
| 网页 API 变化 | CLI/浏览器自动化失效 | 优先官方 API，网页仅作为 fallback |
| Cookie 泄露 | 订单、地址或账号被滥用 | 系统密钥库、最小权限、短期会话 |
| PCBA 元件替代 | AI 选了不兼容或缺货元件 | BOM 锁定、封装/参数/库存三重校验 |
| 物流字段不完整 | 只有生产状态没有快递轨迹 | 分别验证 WIP、订单详情、物流接口 |

## 10. 最终选型建议

### 如果使用中国嘉立创账号

推荐：

```text
中国嘉立创开放平台
  + 自建中文 MCP/CLI
  + 本地 Gerber/BOM/CPL 检查器
  + 人工确认和审计层
```

不建议直接拿海外 `jlcpcb-mcp` 的 endpoint 当作国内 API 客户端。

### 如果使用海外 JLCPCB 账号

推荐先以 `jlcpcb-mcp` 做 quote-only 原型：

1. 配置官方 API 凭证；
2. 验证 Gerber 上传；
3. 验证报价和业务 code；
4. 验证工程审核和 WIP；
5. 再决定是否 fork 并加入自己的审批、审计和订单服务。

如果更重视可控性和代码质量，可以用 `i2cjak/jlcpcb_api` 做底层客户端，自建 MCP 工具层。

### 如果当前只需要追踪已有订单

可以先试 `jlcpcb-cli`，但应把它定位为网页登录型订单查询工具，不要把它当作官方下单 API。

## 11. 公开来源清单

### 官方来源

- [中国嘉立创开放平台](https://open.jlc.com/)
- [中国开发指南](https://open.jlc.com/develop-guide)
- [中国创建应用说明](https://open.jlc.com/develop-guide?doc=create)
- [中国 API 密钥说明](https://open.jlc.com/develop-guide?doc=config)
- [中国 JOP 签名说明](https://open.jlc.com/develop-guide?doc=signature)
- [中国 PCB 网页下单](https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder)
- [海外 JLCPCB API Platform](https://api.jlcpcb.com/)
- [海外 API 文档入口](https://api.jlcpcb.com/docs/start)
- [海外订单追踪帮助](https://jlcpcb.com/help/article/51-How-to-Track-My-Order)

### 第三方项目

- [`jlcpcb-mcp`](https://github.com/Eyalm321/jlcpcb-mcp)
- [`jlcpcb-mcp` npm package](https://www.npmjs.com/package/jlcpcb-mcp)
- [`swamp-jlcpcb`](https://github.com/NeilHanlon/swamp-jlcpcb)
- [`jlcpcb_api`](https://github.com/i2cjak/jlcpcb_api)
- [`jlcpcb-cli`](https://github.com/hatlabs/jlcpcb-cli)
- [`JLCPCB-API`](https://github.com/Jackster/JLCPCB-API)
- [`kicad-jlcpcb`](https://github.com/BeckhamLabsLLC/kicad-jlcpcb)
- [`pcba-design-skills`](https://github.com/Keitark/pcba-design-skills)
- [`easyeda-mcp-pro`](https://github.com/oaslananka/easyeda-mcp-pro)
- [`Spectoda/easyeda-mcp`](https://github.com/Spectoda/easyeda-mcp)

## 12. 证据等级说明

本文使用以下证据等级：

| 等级 | 含义 |
|---|---|
| E1 | 嘉立创官方页面、官方开发指南或官方帮助页明确声明 |
| E2 | 第三方项目源码中存在对应接口、工具或字段 |
| E3 | 第三方项目有单元测试、mock 测试或签名样例测试 |
| E4 | 已用真实账号、真实文件和真实订单完成端到端验证 |

本次公开资料检索中：

- 中国和海外官方平台的“存在 API/订单/追踪能力”达到 E1；
- `jlcpcb-mcp` 的工具和下单开关达到 E2/E3；
- `swamp-jlcpcb` 明确只有 E2/E3，且自述未达到 E4；
- `i2cjak/jlcpcb_api` 的请求构造和签名达到 E2/E3；
- 没有找到一个公开项目能够对任意用户账号证明完整 E4 闭环。

> 本文没有修改或上传任何用户的 Gerber、订单、地址或支付信息。
