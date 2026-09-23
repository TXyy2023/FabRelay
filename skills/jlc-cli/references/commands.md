# 命令、账号与登录

本 Skill 随 `jlc-cli 1.0.0-dev.4` 交付。运行 `jlc-cli --help` 查看本机版本接口；不匹配时通过该安装的 `skill path` 读取对应版本。全局参数：`--json` 输出结构化结果，`--home DIR` 选择数据目录，`--profile NAME` 选择隔离账号配置，`--timeout MS` 设置操作超时，默认 30000 毫秒。路径带空格时用双引号。下面的文件、任务、订单标识均为示意值，调用时替换为实际结果。

| 命令 | 用途与前提 |
| --- | --- |
| `jlc-cli --version` | 确认 CLI 与所加载 Skill 版本相符 |
| `jlc-cli init` | 人类交互式阅读中文说明并输入“同意”（兼容原有 ACCEPT）；非交互时先呈现返回说明，再据实际人类同意使用 `--accept --confirmed-by human`；不能代替付款确认 |
| `jlc-cli browser doctor` | 检查 `data.available`，正常输出不等于浏览器可用；可执行文件存在也不等于业务已可用 |
| `jlc-cli browser configure --engine obscura --endpoint URL` | 仅支持已有 jlc-cli 中继端点；直接 Obscura CDP 会在断连时丢失页面，因此拒绝直接连接 |
| `jlc-cli browser configure --engine obscura --executable PATH` | 保存可执行文件路径，由业务命令需要时启动 |
| `jlc-cli browser configure --engine chrome --executable PATH` | 指定 Chrome 诊断浏览器；不等于 Obscura 已验收 |
| `jlc-cli browser configure --clear-endpoint --engine obscura` | 清除外部端点，切回 CLI 自有浏览器；不能同时传 `--endpoint` |
| `jlc-cli browser stop` | 停止 CLI 自己启动的浏览器，以便切换运行配置；不关闭外部会话 |
| `jlc-cli auth login` | 发起或继续页面提供的登录方式，读取等待状态、任务与二维码 |
| `jlc-cli auth status` | 核实当前配置的登录状态 |
| `jlc-cli auth logout` | 清理当前 CLI profile 的本地会话并停止自有浏览器；不会注销外部 CDP 会话，结果以 `externalSessionUnchanged` 明示 |
| `jlc-cli account show` | 读取可见账号标识、客编、电话、手机号；网站脱敏则保留 |
| `jlc-cli task list` / `jlc-cli task show TASK` | 查找并读取持久化任务 |
| `jlc-cli skill path` | 返回此安装随包交付的 Skill 位置 |
| `jlc-cli skill install --to DIR` | 在指定 skills 根目录创建 `jlc-cli` 子目录；拒绝覆盖已有目录 |

账号配置对所有命令使用同一个 `--profile NAME`。不要在任务执行中无意切到另一个配置；任务本身关联的账号与支付摘要仍需核实。不要读取或复制浏览器 Cookie 来替代正常登录。需要替换浏览器配置时，先停止 CLI 自有浏览器；从外部端点切回自有浏览器使用 `--clear-endpoint`。`auth logout` 报告外部会话保留时，不可向用户宣称网站账户已在外部浏览器退出。

Obscura 首选由 CLI 启动，其中继保留单个上游连接；浏览器可执行文件可从 PATH、`JLC_OBSCURA_EXECUTABLE` 或显式配置发现。CDP 地址必须是本机回环地址，不含查询参数、URL 凭据或片段；远程会话须先由调用方建立受保护的本机转发。不要尝试多个客户端同时抢占同一中继。

## 多方式登录和二维码

使用 `auth login --method` 选择 `manual`、`qr`、`wechat`、`password` 或 `sms`。枚举存在不代表网站当时开放该方式；以返回的页面状态与提示为准。可选 `--username VALUE` 或 `--phone VALUE` 提供账号。密码用 `--password-env JLC_PASSWORD`、短信验证码用 `--code-env JLC_SMS_CODE`，从当前环境读取，不直接写在命令参数中，也不写入任务说明、普通日志或回调负载。滑块等人类挑战留在同一页面处理。

短信验证码目前由人类在保留的网站页面获取，CLI 只提交调用方提供的已有验证码，不自动请求发送短信。短信完整登录尚未实站验收，不能因 `--method sms` 存在就宣称已验证可用。

`wechat` 使用当前官方面板实际提供的“微信快捷登录”；按钮不可用时按提示改用 `qr`。`qr` 会在快捷面板出现时切换“使用其他头像、昵称或账号”，再交付真实二维码，不把微信头像或快捷登录按钮当二维码。若流程要求注册、创建账号或绑定手机号/已有账号，停止在 `LOGIN_IDENTITY_BINDING_REQUIRED`，由用户决定身份绑定；原登录请求不能代替这一决定。

扫码方式应展示返回的当前二维码素材，注明对应任务；不能只有“请扫码”而不提供二维码。过期或刷新后展示新的素材，停止引用旧码。二维码不见了、页面跳转或浏览器已打开，均不能说明已登录。

扫码示例：`jlc-cli auth login --method qr --wait 300 --events`。`--wait [seconds]` 默认 300 秒；不等待时命令先返回当前状态，随后观察返回的任务。`--events` 以 JSONL 输出进度，逐行处理完整事件，不把事件流当作单个 JSON 文档。二维码事件可以先交给人类查看，再等待完成事件。最终成功须经过当前身份核实，登录失败、超时、回调失败分别处理。

## 显式配置回调

仅在调用方需要接收通知时使用 `--callback URL`。允许本机回环 HTTP 或 HTTPS；凭据不放 URL。`--callback-secret-env NAME` 指向接收端约定的 HMAC 密钥环境变量，不能把密钥值写到命令参数或对话里。

接收端按 `x-jlc-cli-event-id` 去重。配置密钥时，`x-jlc-cli-signature` 为 `sha256=` 加原始请求体字节的 HMAC-SHA256 十六进制值；接收端应在解析改写正文前验证。为兼容已有接收端，同时发送同值的 `x-jlc-event-id` 和 `x-jlc-signature`。回调不携带 Cookie、令牌、密码、二维码或个人资料，只报告任务状态。不要把浏览器现场转发到未授权服务。

回调投递失败不表示登录失败。`data.callback` 中的 `eventId`、`delivered`、`attempts` 与 `error` 表示投递情况。使用 `jlc-cli task callback-retry TASK` 只重试该任务保存的通知，不重新登录或重放业务操作；重试签名仍需要相同密钥环境变量。
