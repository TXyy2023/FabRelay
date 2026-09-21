# PCB 文件、参数、报价与提交

此流程依赖初始化、有效登录和浏览器会话。只上传用户指定且获准处理的文件。2026-09-21 核对的页面说明为 Gerber/PCB 源文件的 zip/rar 压缩包、不超过 100M；当前实现据此限制上传。站点可调整限制，输入最终须通过当前网站解析；CLI 不转换 EDA 源文件，扩展名为 `.zip` 也不能保证内容可解析。

## 上传与预览

```text
fabrelay pcb upload "board.zip" --json
fabrelay pcb preview --draft UPLOAD_TASK --json
```

每个操作返回新的 `taskId`，后续命令的 `--draft` 使用最新成功结果中的 ID，从而传递当前文件、参数、报价与检查摘要。示例中的 `UPLOAD_TASK` 等是占位值，不能原样执行。核实源文件、解析状态与预览关联。上传成功不代表解析完成；预览未生成则按结果观察或接管，不能展示上一任务的图片。预览来自网站真实结果，不承诺网站未提供的视角或本地离线渲染。

## 参数与报价

```text
fabrelay pcb options --draft PREVIEW_TASK --json
fabrelay pcb set --draft OPTIONS_TASK --params @values.json --mode default --json
fabrelay pcb quote --draft SET_TASK --json
```

`options` 的当前输出是字段、候选值和约束的来源。先读取它再构造 `values.json`，内容为字段名到明确取值的 JSON 对象，不包含 `params` 外层包装。`--params` 接受 JSON 对象文本或 `@文件路径`；跨平台优先使用文件，路径有空格时写作 `--params "@path with spaces/values.json"`。不凭示例或记忆硬编码生产参数；条件字段须在相关选项改变后重新读取。

默认模式逐项区分用户明确选择、文件解析事实与网站预选。缺少生产决策时呈现候选值并询问，不为消除错误自行补值。得到“按低成本打样帮我选择剩余参数”等明确意图后，可按其约束使用 `--mode auto`，并向用户说明建议依据；`auto` 不表示 CLI 内置了模型或会自行补参数。

设置后读取实际值和差异。网站拒绝、更改或重置显式选择时暂停相关流程，解释冲突。报价必须对应当前文件和参数；变更参数后重新报价，不能沿用旧金额。报价、未付款订单和支付成功分别报告。

## 授权范围内建立未付款订单

```text
fabrelay pcb check --draft QUOTE_TASK --json
fabrelay pcb submit --draft CHECK_TASK --json
```

仅在用户业务需求已包含建单时执行 `submit`。`check` 应汇总实际文件、参数、金额及网站要求的收货等信息；存在缺项、冲突或报价变化时先解决。提交是明确的独立命令，不额外要求付款式确认凭据，也不会自动付款。

提交完成后读取订单号及查询核实结果。超时、进程退出或回包丢失时观察同一提交任务并查询关联订单，不能再次 `submit` 来尝试拿到结果。FPC 新下单不在本版范围内。
