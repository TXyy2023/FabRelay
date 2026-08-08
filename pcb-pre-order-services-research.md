# PCB 下单前可接入在线服务调研

> 调研日期：2026-08-07  
> 目标项目：`jlc-com-cli` / `jlc-cli`  
> 适用阶段：Gerber 本地检查完成后、进入嘉立创网页报价之前  
> 调研方式：核对官方产品页、官方帮助、隐私说明与公开 API 示例；未注册账号、未上传任何用户 Gerber、未创建订单

## 1. 结论摘要

最值得在 PCB 下单前增加的不是另一个“报价页面”，而是独立的 **Preflight（预检）阶段**：在 Gerber 进入嘉立创报价页之前，先检查制造风险、文件版本、关键尺寸和远程文件处理边界。

建议的新主链路为：

```text
Gerber ZIP
→ 本地安全检查与结构识别
→ 本地制造预检（默认、离线）
→ 可选远程 DFM 服务（必须显式授权）
→ 人工查看风险与差异
→ 嘉立创网页分析和实时报价
→ 人工审批
→ 提交测试订单
```

本次调查的直接结论：

1. **`PCB Preflight` 是当前最适合做 npm CLI 可编程接入验证的候选。** 官方明确提供 PCB Manufacturing Analysis + API，公开仓库包含 Node.js、生成 DFM PDF、设计版本比较、电气短路/开路检查等 REST API 示例。
2. **`JLCDFM` 与嘉立创业务最接近。** 它支持网页 Gerber 上传、DFM/DFA、2D/3D、风险定位和 PDF 报告，但本次可见的官方入口没有公开 REST API 文档；而且域名属于海外 `jlcpcb.com` 体系，不能默认等同于中国嘉立创 `test.jlc.com`。
3. **华秋 DFM、Siemens PCBflow 的分析能力很强，但更适合人工或企业试用。** 两者都没有在公开产品页给出可直接用于普通 npm 包的开放 API 契约。
4. **Ucamco Reference Gerber Viewer、Elecrow Viewer 适合视觉复核，不是完整 DFM。** 它们不能替代制造商 CAM 审核，也不应单独决定是否允许下单。
5. **Eurocircuits PCB Checker 和 PCBShopper 可用作产品设计参考，不适合接入嘉立创主链路。** 前者绑定 Eurocircuits 账号和购物篮，后者是参数级价格比较，不处理本次真实 Gerber，也不是嘉立创实时价格来源。
6. 任何第三方云 DFM 都意味着把未发布的 PCB 设计文件传给新的数据处理方。**远程上传必须默认关闭**，不能由 `pcb quote` 静默触发。

## 2. 候选服务总表

| 服务 | 主要用途 | 输入/输出 | 公开自动化接口 | 与当前 CLI 的适配度 | 建议 |
| --- | --- | --- | --- | --- | --- |
| [PCB Preflight](https://www.pcbpreflight.com/) | 在线 CAM、DFM、电气分析、版本比较、格式转换 | Gerber/ODB++/IPC-2581/NC 等；在线结果、JSON/PDF | **有**，官方称 REST API，公开 Node.js 和 DFM 报告示例 | 高 | 第一远程 API PoC |
| [JLCDFM](https://jlcdfm.com/) | 嘉立创体系的 DFM/DFA、2D/3D、风险定位 | Gerber ZIP/RAR，最大 50 MB；网页结果、PDF | 未发现公开 API 文档 | 高，但存在中外站点边界 | 先做人工跳转/可选 headed 流程，不直接调用内部接口 |
| [华秋 DFM](https://dfm.hqpcb.com/) | 中国站在线分析、PCB/SMT 隐患检查、文件比对 | Gerber、ODB++、Altium、PADS、Allegro 等；报告和生产文件 | 未发现公开 API 文档 | 中 | 作为中文 DFM 对照和人工复核入口 |
| [Siemens PCBflow](https://www.pcbflow.com/) | Valor 驱动的云 DFM/DFA、制造商规则、协作 | ODB++、IPC-2581、Gerber 274X；交互结果、PDF | 未发现面向普通用户的公开 API 文档 | 中 | 企业评估项，不作为首发依赖 |
| [Ucamco Reference Gerber Viewer](https://gerber-viewer.ucamco.com/) | 由 Gerber 格式维护方提供的查看、测量和多层复核 | 单个/多个 Gerber 或 ZIP；浏览器视图 | 无公开作业 API；提供网站链接资源 | 中 | 作为格式与视觉参考，不作为 DFM 门禁 |
| [Ucamco Integr8tor Nexus](https://www.ucamco.com/en/software/precam-engineering/integr8tor) | 工厂售前工程、CAM 预处理、DFM 和报价自动化 | 工厂级 CAM/ERP/CRM 工作流 | **有**，官方明确 REST API、WebSocket 和数据库接入 | 低（对终端用户过重） | 仅企业/工厂部署时再评估 |
| [Eurocircuits PCB Checker](https://www.eurocircuits.com/user-guides/visualizer-user-guides/pcb-checker-user-guide/) | 制造商自身 DRC/DFM 与可视化 | 上传 PCB 数据并完成 Full Analysis；网页 DRC/DFM | 未发现独立公开 API | 低 | 参考其交互模型，不接入 JLC 主链路 |
| [Elecrow Online Gerber Viewer](https://www.elecrow.com/gerberviewer.html) | 无注册 Gerber 查看、SVG 导出 | Gerber 274X；浏览器视图、SVG | 未发现公开 API | 低 | 仅作人工视觉对照 |
| [PCBShopper](https://pcbshopper.com/) | 多 PCB 厂商参数级价格比较 | 尺寸、层数、数量、工艺和目的地；估算价格 | 未发现公开 API | 低 | 可提供外链，不进入权威报价和审批数据 |

说明：表中的“未发现公开 API”是截至调研日期，在官方产品页、帮助入口和公开搜索结果中没有找到稳定、受支持的 API 契约；不代表网页内部没有网络请求。网页内部接口不能据此视为公共 API。

## 3. 最值得接入：PCB Preflight

### 3.1 官方可确认的能力

PCB Preflight 由 Numerical Innovations 提供，官方首页将其描述为 `PCB Manufacturing Analysis + API`，并列出：

- Gerber、ODB++、IPC-2581、NC 等 EDA/CAM 格式查看；
- 基础与高级 DFM 检查；
- 酸陷阱、热焊盘不足、焊桥、电源/地短路等检查；
- Net 短路与开路分析；
- PCB 设计版本 DIFF；
- CAM 工具和拼板；
- Gerber/NC 到 ODB++、IPC-2581 的转换；
- DFM PDF 报告；
- REST API 自动化。

官方公开仓库 [`NumericalInnovations/pcbpreflight-examples`](https://github.com/NumericalInnovations/pcbpreflight-examples) 提供以下示例：

1. 生成 JSON；
2. 提取 PCB 设计信息；
3. Node.js Server；
4. 自动 PCB 报价；
5. 比较 PCB 设计版本；
6. 生成 DFM PDF；
7. PCB 电气测试/网表比较；
8. 从 Gerber/NC 生成 ODB++；
9. 从 Gerber/CAM 生成 IPC-2581。

DFM PDF 示例描述的工作流是：提交 API Key 和 Gerber/CAM 文件，取得 `job_id_hash`，轮询作业完成，然后显示 DFM PDF。这个模式与 Node.js CLI 的异步任务模型匹配。

### 3.2 隐私与未知项

[官方隐私说明](https://www.pcbpreflight.com/landing/privacy) 表示：

- API/网站会记录 IP、User-Agent、Referrer 和访问时间；
- 文件会传输并临时存储在 PCB Preflight 服务器；
- 官方称不读取、挖掘上传文件及其元数据，处理由机器完成；
- 用户使用删除按钮后，文件会从服务器立即且不可逆删除；
- 日志数据在 14 天后删除；
- 服务使用安全环境，首页宣称 256-bit AES Encryption。

仍需在实际接入前确认：

- API 订阅价格、额度、并发和速率限制；
- API 是否提供明确的远程删除接口及删除回执；
- 数据实际存储区域、分包商和跨境处理条款；
- DFM 规则能否配置为嘉立创中国工厂能力，而不是通用规则；
- 输出 JSON Schema 和错误码的稳定性；
- 账号停用后作业、报告和备份的保留时间。

### 3.3 推荐接入等级

推荐等级：**P1，可做远程 API PoC，但不能默认启用。**

首个 PoC 只应使用项目自带的非保密测试 Gerber，验证：

```text
上传测试文件
→ 获得 job_id_hash
→ 轮询完成
→ 下载 DFM PDF/结构化结果
→ 发起删除
→ 获得删除成功证据
```

在删除接口、数据区域和商业条款未确认前，不应上传客户或未公开项目的 Gerber。

## 4. 与嘉立创最接近：JLCDFM

### 4.1 官方可确认的能力

[JLCDFM 首页](https://jlcdfm.com/) 明确提供：

- Gerber ZIP/RAR 上传，页面标注最大 50 MB；
- Web-based Viewer；
- 一键 DFM 与 DFA；
- 可使用现成规则或首选供应商规则；
- 走线、阻焊、钻孔、字符和装配等 5 个分析模块；
- 30+ 检查点、可视化问题定位；
- 一键下载 PDF 报告；
- BOM 匹配和元件 3D 模型；
- 2D/3D PCB 可视化。

[DFM 结果帮助](https://jlcpcb.com/help/article/DFM-Analysis-Result-View-Help) 还说明了：

- 每层问题按 Danger、Warning、Good 分级；
- 问题可按层和检查项定位；
- 页面展示测量值、对象、风险原因和规则阈值；
- 为避免人工审核疲劳，每个分析项只保留最低等级的 50 个结果。

### 4.2 与中国嘉立创 CLI 的边界

JLCDFM 使用 `jlcdfm.com` 和 `jlcpcb.com`，属于海外 JLCPCB 网站体系。当前 CLI 的下单目标是 `https://test.jlc.com/`，两者不能自动视为同一个区域、账号、工厂规则或数据处理主体。

本次未在 JLCDFM 官方帮助入口中找到公开 REST API 文档。因此：

- 可以把它列为可选人工 DFM 服务；
- 可以研究 Playwright headed 上传和报告导出，但必须新增独立域名白名单和远程上传授权；
- 不应调用抓包得到的内部接口代替网页；
- JLCDFM 报告不能替代中国嘉立创下单页自己的 Gerber 分析和 CAM 审核；
- 不应因名称相近而把 JLCDFM 规则直接声明为中国测试站规则。

### 4.3 推荐接入等级

推荐等级：**P1.5，先做人工入口或可选 headed 流程。**

建议先增加：

```text
jlc-cli services open jlcdfm
jlc-cli pcb preflight <gerber.zip> --provider jlcdfm --headed --allow-remote-upload
```

第二个命令只有在完成隐私确认、域名隔离和真实网页契约测试后才能实现；首版可以只提供服务说明和打开页面，不自动上传。

## 5. 其他 DFM 与查看服务

### 5.1 华秋 DFM

[华秋 DFM 官方页](https://dfm.hqpcb.com/) 提供在线分析入口和客户端，官方页面列出：

- Allegro、Altium Designer、PADS、Gerber、ODB++ 等格式解析；
- Gerber、BOM、坐标、装配图、PDF、ODB++ 导出；
- 120+ 项 PCB 制板检查和 1000+ 项 SMT 加工隐患检查；
- 开短路、断头线、走线疏密、过孔堆叠、焊盘间距、布局干涉等检查；
- BOM/PCB/Gerber 文件比对和 3D 查看；
- 独立的服务协议、隐私政策和第三方共享清单。

优点是中文界面、中国网络环境和检查项丰富。缺点是本次没有找到公开 API 文档，页面同时与华秋 PCB/SMT 下单生态相连。推荐作为人工对照工具，暂不做无契约自动化。

### 5.2 Siemens PCBflow

[PCBflow 官方页](https://www.pcbflow.com/) 表明它由 Siemens Valor NPI 技术驱动，支持：

- ODB++、IPC-2581、Gerber 274X 和其他常见格式；
- 选用制造商工艺能力执行 DFM；
- PCB 与装配 DFA；
- Flex、Rigid-Flex；
- 交互式问题定位、协作和 PDF 报告；
- Boardera 驱动的 QuickPrice；
- 云安全与 Siemens 信息安全体系。

它适合企业 NPI 和制造商协作，但官方公开页面的入口是试用/登录，没有发现适合普通 npm 客户端直接调用的公开 API 文档。若未来有企业账号和供应商规则合作，可重新评估；首版不应依赖。

### 5.3 Ucamco Reference Gerber Viewer

[Ucamco Reference Gerber Viewer](https://gerber-viewer.ucamco.com/) 由 Gerber 格式开发维护方提供，支持单个/多个 Gerber 或 ZIP、跨层查看、检查和测量。它的价值是：

- 作为 Gerber 解析和显示的厂商中立参考；
- 用于人工确认层映射、极性、曝光和几何显示是否一致；
- 帮助验证本地预览器的结果。

它不是完整 DFM，也没有公开的远程作业 API。推荐将其作为人工复核链接或测试基准，不把它加入自动下单门禁。

### 5.4 Ucamco Integr8tor Nexus

[Integr8tor Nexus 官方页](https://www.ucamco.com/en/software/precam-engineering/integr8tor) 明确提供 Web 界面、DFM、工艺参数提取、报价辅助，并通过 REST API、WebSocket 和数据库与 ERP、CRM、CIM、工程系统集成。

这是工厂售前工程和 CAM Front-end 产品，不是面向普通设计者的轻量 SaaS。它更适合 PCB 工厂、贸易商或企业内部工程系统；对 `jlc-cli` 首版而言采购、部署、规则配置和授权成本过高。

### 5.5 Eurocircuits PCB Checker

[PCB Checker 官方指南](https://www.eurocircuits.com/user-guides/visualizer-user-guides/pcb-checker-user-guide/) 说明它可以显示 Full Analysis 后的 DRC 与 DFM 信息，包括线宽、间距、环宽、镀铜指数、铜面积、锡膏面积等。

但它要求登录 Eurocircuits 账号、上传数据、完成分析并把作业保存到购物篮后才能使用。它是 Eurocircuits 制造流程的一部分，不是独立的通用 DFM API，因此只能参考其产品交互：问题分级、逐项定位、配置值与测量值对比。

### 5.6 Elecrow Online Gerber Viewer

[Elecrow Viewer](https://www.elecrow.com/gerberviewer.html) 标注无需下载或注册，支持 Gerber 274X、常见层后缀和 SVG 导出。页面同时明确说明第三方工具结果仅供参考，生产中发现问题仍由工程师联系。

它可以作为低门槛人工预览，但不应被描述为权威 DFM，也没有公开 API 契约。页面允许通过 URL 读取 Gerber，**不能为了自动化把私有 Gerber 放到公共 URL**。

### 5.7 PCBShopper

[PCBShopper](https://pcbshopper.com/) 页面宣称可同时比较 16 家 PCB 制造商，并接收尺寸、层数、数量、阻焊、字符、表面处理、板厚、铜厚、最小线宽/间距、最小钻孔和目的地等参数。

它适合做市场级成本基准，但存在以下限制：

- 不读取本次实际 Gerber；
- 不能发现特殊板框、槽孔、阻抗、盲埋孔等真实复杂度；
- 价格不等于中国嘉立创测试站实时价格；
- 本次未发现公开 API；
- 页面包含商业推广和外链。

因此可以在 TUI 中提供“外部价格参考”链接，但不能进入 `QuoteSnapshot`、审批最高金额或订单对账。

## 6. 推荐的 CLI 设计

### 6.1 命令面

建议增加：

```text
jlc-cli services list
jlc-cli services show <provider>
jlc-cli pcb preflight <gerber.zip>
jlc-cli pcb preflight <gerber.zip> --profile jlc-test
jlc-cli pcb preflight <gerber.zip> --provider pcb-preflight --allow-remote-upload
jlc-cli pcb preflight result <result-id>
jlc-cli pcb preflight delete <result-id>
```

默认 `pcb preflight` 必须完全离线。只有显式提供 `--provider` 和 `--allow-remote-upload` 才能传输 Gerber。

### 6.2 Provider 接口

建议定义稳定的内部接口：

```ts
interface PreflightProvider {
  id: string;
  kind: 'local' | 'remote-api' | 'remote-browser' | 'external-link';
  capabilities(): Promise<PreflightCapabilities>;
  submit(input: PreflightInput): Promise<RemoteJob>;
  poll(job: RemoteJob): Promise<PreflightResult>;
  downloadArtifacts(job: RemoteJob): Promise<PreflightArtifact[]>;
  delete(job: RemoteJob): Promise<DeletionReceipt>;
}
```

远程 Provider 不能获得订单、地址、联系人、Cookie 或嘉立创会话；它只接收用户明确批准的 Gerber 和必要规则参数。

### 6.3 统一结果模型

```ts
interface PreflightResult {
  schemaVersion: 1;
  id: string;
  provider: string;
  providerKind: 'local' | 'remote-api' | 'remote-browser';
  gerberSha256: string;
  ruleProfile: string;
  status: 'pass' | 'warning' | 'blocked' | 'unknown';
  findings: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    category: 'format' | 'copper' | 'drill' | 'outline' | 'mask' | 'silkscreen' | 'electrical' | 'assembly' | 'unknown';
    message: string;
    layer?: string;
    measured?: number;
    limit?: number;
    unit?: 'mm' | 'mil' | 'percent';
    location?: { x: number; y: number; unit: 'mm' | 'mil' };
    rawProviderText?: string;
  }>;
  artifacts: Array<{
    kind: 'json' | 'pdf' | 'png' | 'html';
    path: string;
    sha256: string;
  }>;
  remote?: {
    host: string;
    submittedAt: string;
    deletedAt?: string;
    deletionVerified: boolean;
    policyUrl: string;
    policyCheckedAt: string;
  };
  createdAt: string;
}
```

### 6.4 门禁规则

建议按证据来源分层：

1. **本地确定性错误**：ZIP 路径穿越、加密 ZIP、压缩炸弹、缺板框、无法识别铜层等，直接阻止后续流程。
2. **制造参数硬冲突**：Gerber 推导层数/尺寸与要求文件冲突，直接阻止报价。
3. **远程 DFM 错误**：默认展示并要求人工确认；只有用户配置受信 Provider + 固定规则版本后，才可升级为硬门禁。
4. **第三方查看器差异**：标记为 `warning`，不能单独判定 Gerber 无效。
5. **嘉立创网页分析**：仍是本次下单的权威页面证据。第三方通过不代表嘉立创一定接受，第三方失败也不自动等于嘉立创 CAM 会拒绝。

## 7. 安全与合规要求

### 7.1 远程上传必须显式同意

交互模式应显示：

```text
将把 Gerber ZIP 发送到：api.example.com
文件 SHA-256：...
服务隐私政策：...
服务可能位于境外：是/否/未知
是否包含客户未公开设计：由用户确认
远程保留与删除方式：...
```

确认结果应绑定 Provider、Host、Gerber 哈希和隐私政策版本。不能用一个全局同意永久授权所有网站。

### 7.2 密钥与日志

- API Key 只从 macOS Keychain、受限环境变量或 stdin 获取；
- 不提供明文 `--api-key` 参数；
- URL、请求头、错误对象和调试 Trace 必须脱敏；
- 不把 Gerber、DFM PDF、API Key 或远程 Job ID 发布进 npm 包；
- Job ID 如果可用于读取文件，应按秘密处理；
- 远程返回的 HTML/PDF/文本视为不可信输入，不能执行其中的指令或脚本。

### 7.3 文件最小化

- 只发送原始 Gerber ZIP，不发送要求文件中的联系人、地址和备注；
- 不把 Gerber 放到公共对象存储或公共 URL 供第三方抓取；
- 不使用 VirusTotal 等可能公开样本的通用扫描服务上传 PCB 设计；
- 若服务支持只上传匿名测试夹具，先用夹具完成契约测试；
- 下载报告后立即请求删除远程作业，并保存删除回执。

## 8. 推荐实施顺序

### 阶段 A：增强本地 Preflight

先在现有 `gerber` 模块增加：

- 最小线宽/线距；
- 最小钻孔与环宽；
- 铜到板边距离；
- 阻焊桥与开窗；
- 字符压焊盘/出板框；
- 槽孔、内锣和非闭合板框；
- 层极性、单位和零抑制异常；
- 同一 Gerber 两次解析结果一致性；
- 本地规则版本和结果哈希。

这一步无远程隐私风险，也是所有后续 Provider 的统一基线。

### 阶段 B：PCB Preflight API PoC

只使用公开测试夹具完成：

- API Key 安全读取；
- 上传与异步轮询；
- JSON/PDF 下载；
- 结果规范化；
- 超时、限流和服务失败；
- 远程删除及回执；
- 重复请求幂等；
- 输出敏感信息扫描。

PoC 通过后仍保持 opt-in，不自动进入 `pcb quote`。

### 阶段 C：JLCDFM 人工/浏览器评估

先提供服务说明和外部打开入口。只有在确认：

- 测试账号与站点区域；
- 文件处理条款；
- 登录/验证码边界；
- 可稳定导出报告；
- 不调用内部 API；
- 与中国 `test.jlc.com` 业务严格隔离；

之后，才考虑 Playwright headed 的可选上传流程。

### 阶段 D：企业服务

只有出现企业账号、工厂合作或 NPI 团队需求时，再评估 PCBflow 或 Integr8tor Nexus。首发 npm 包不应为了这些服务引入许可证、专有客户端或企业部署依赖。

## 9. 验收标准

新增 Preflight 功能至少需要满足：

1. 不带 Provider 参数时，断网也能完成本地预检；
2. 未提供 `--allow-remote-upload` 时绝不产生 Gerber 外传；
3. JSON 输出标明每条发现来自本地、第三方还是嘉立创网页；
4. Provider 超时不会被误报为 DFM 通过；
5. 远程结果与 Gerber SHA-256、规则版本绑定；
6. 修改 Gerber 后旧报告自动失效；
7. 远程删除失败会清楚标记，不能静默忽略；
8. 第三方报告不能修改 `QuoteSnapshot` 中的嘉立创实时价格；
9. 第三方报告不能绕过人工审批；
10. 真实验收只使用无保密内容的测试 Gerber；
11. 日志、SQLite、截图、Trace 和 npm tarball 通过敏感信息扫描；
12. 对每个远程 Provider 都有独立域名白名单、超时、重试和熔断策略。

## 10. 最终建议

对当前 `jlc-cli`，最稳妥的产品决策是：

```text
第一优先：实现离线 pcb preflight 和统一结果模型
第二优先：用 PCB Preflight 公共示例做可删除的远程 API PoC
第三优先：把 JLCDFM 作为显式 opt-in 的人工/浏览器增强
暂不接入：PCBflow、Integr8tor、Eurocircuits、Elecrow、PCBShopper 的自动流程
```

其中，`PCB Preflight` 是“技术上最容易接入”的候选，`JLCDFM` 是“业务上最接近嘉立创”的候选；两者角色不同，不应混为一谈。

即使接入远程 DFM，最终下单前仍必须以嘉立创测试站页面回读出的 Gerber 分析、工艺参数、实时价格、地址/快递和检查订单摘要为准。任何第三方服务都不能替代嘉立创工程审核，也不能把“在线分析通过”描述成“保证可生产”。

## 11. 官方来源

### PCB Preflight

- [PCB Preflight 官方首页](https://www.pcbpreflight.com/)
- [Solutions：Online PCB Analysis 与 API Automation](https://www.pcbpreflight.com/landing/doc)
- [官方 REST API 示例仓库](https://github.com/NumericalInnovations/pcbpreflight-examples)
- [Generate DFM Report 示例](https://github.com/NumericalInnovations/pcbpreflight-examples/tree/master/06%20Generate%20DFM%20Report)
- [隐私政策](https://www.pcbpreflight.com/landing/privacy)

### JLCDFM / JLCPCB

- [JLCDFM 官方首页](https://jlcdfm.com/)
- [JLCDFM Help 目录](https://jlcpcb.com/help/catalog/2061-DFM-Tool-Help)
- [DFM Analysis Result View Help](https://jlcpcb.com/help/article/DFM-Analysis-Result-View-Help)
- [JLCPCB Privacy & Security](https://jlcpcb.com/privacy-security)

### 其他服务

- [华秋 DFM](https://dfm.hqpcb.com/)
- [华秋 DFM 隐私政策](https://passport.huaqiu.com/agreement/dfmPrivacy.html)
- [Siemens PCBflow](https://www.pcbflow.com/)
- [Siemens Digital Industries Software Trust Center](https://www.sw.siemens.com/en-US/trust-center/)
- [Ucamco Reference Gerber Viewer](https://gerber-viewer.ucamco.com/)
- [Ucamco Integr8tor Nexus](https://www.ucamco.com/en/software/precam-engineering/integr8tor)
- [Eurocircuits PCB Checker User Guide](https://www.eurocircuits.com/user-guides/visualizer-user-guides/pcb-checker-user-guide/)
- [Elecrow Online Gerber Viewer](https://www.elecrow.com/gerberviewer.html)
- [PCBShopper](https://pcbshopper.com/)

## 12. 证据边界

本报告的证据等级：

- **E1：官方产品声明**——证明服务方公开宣传某项能力；
- **E2：官方帮助/隐私说明**——证明界面、处理流程或数据政策有文档；
- **E3：公开示例代码**——证明存在可研究的调用示例；
- **E4：真实账号端到端**——实际上传、取得结果、下载报告并删除远程文件。

本次达到 E1–E3，没有进行 E4。没有注册服务账号、没有使用 API Key、没有上传 Gerber，也没有验证商业套餐、调用额度、结果精度或远程删除接口。因此，接入前必须用非保密测试夹具进行一次真实端到端和合同/隐私复核。
