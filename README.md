# jlc-com-cli

Playwright-first CLI and terminal UI for the PCB ordering workflow on the JLC
test environment.

> The initial release is intentionally restricted to `https://test.jlc.com/`.
> It creates test orders only after a locally signed human approval and always
> selects manual order confirmation. Balance payment is never automatic: it
> requires a fresh payment snapshot and a separate locally signed approval.

## Install

```bash
npm install -g jlc-com-cli
jlc-cli browser install
jlc-cli browser doctor
```

Run `jlc-cli` without arguments for the terminal UI, or use `jlc-cli --help`
for the machine-friendly command surface. Add `--json --no-input` when calling
the CLI from an agent.

In the terminal UI, type `/` to open the command palette. Use `↑/↓` to move,
`Tab` to complete, `Enter` to select or run, and `Esc` to close it. When the
palette is closed, `↑/↓` recalls up to 50 commands from the current session.
Use `Shift+Tab` to cycle between the persisted hard and simple Agent modes; the
active mode is always shown above and below the command box.
After login, the TUI reads the visible account area and shows the user name,
customer code, and the company that owns the current customer code. The TUI
also has platform-message and 嘉小智 conversation panels. `jlc-cli auth status
--json` returns the same user summary.

Requirements: Node.js 22.12 or newer on macOS ARM64 or Windows x64. The package
uses its own 0700 Playwright profile and never opens the user's normal Chrome
profile.

## Core workflow

```bash
jlc-cli auth login --headed --browser chrome
jlc-cli pcb inspect ./board-gerber.zip --json
jlc-cli pcb quote ./board-gerber.zip --requirements ./pcb.yaml --headed
jlc-cli pcb approval create --quote <quote-id>
jlc-cli pcb order create --quote <quote-id> --approval <approval-file> --headed
jlc-cli orders audit <order-id> --json
jlc-cli orders show <order-id> --json
jlc-cli orders payment prepare <order-id>
jlc-cli orders payment approval create --payment <payment-id>
jlc-cli orders payment execute --payment <payment-id> --approval <payment-approval-file>
jlc-cli messages list --json
jlc-cli xiaozhi question "PCB 下单前为什么要检查钻孔文件？"
```

Multiple requirement files and explicit conflict resolution are supported:

```bash
jlc-cli pcb quote board.zip \
  -r pcb.yaml -r customer.md -r delivery.txt \
  --set solderMaskColor=绿色 --json
```

`pcb quote` always opens and reads the real test-site order-check dialog, then
closes it without submitting. `pcb order create` requires a short-lived,
Keychain-signed approval receipt. A successful create result is emitted only
after the success page provides an order ID and the order list reads back the
same order. An ambiguous submit is marked unknown and will be reconciled before
any later attempt; it is never blindly clicked again.

Payment uses the same fail-closed principle but a different approval. `payment
prepare` only reads the awaiting-payment card and writes a short-lived snapshot
and screenshot. `payment approval create` displays the order, amount, and the
fixed `balance` method in an interactive terminal. Only `payment execute` can
click the visible payment controls. A quote/order approval cannot authorize a
payment, amount changes are blocking, and an unknown payment request ID cannot
be clicked a second time.

## Commands

```text
jlc-cli browser install|doctor
jlc-cli auth login|status|logout
jlc-cli disclaimer status|show|accept|reset
jlc-cli mode status|set|prompt|context|skill
jlc-cli mode preference list|set|unset
jlc-cli pcb inspect|preview|options|quote
jlc-cli requirements validate
jlc-cli pcb approval create
jlc-cli pcb order create
jlc-cli orders list|show|audit|watch
jlc-cli orders payment|pay prepare|approval|execute
jlc-cli orders actions <order-id>
jlc-cli orders memo|delete|follow|unfollow <order-id> ...
jlc-cli orders block-reorder|shipping|pause|share <order-id> ...
jlc-cli orders certificate|contract|delivery-note <order-id>
jlc-cli orders template reselect|modify <order-id> ...
jlc-cli orders label add|remove <order-id> --label <label>
jlc-cli orders urge review|ship <order-id>
jlc-cli orders reorder <order-id> --file <gerber.zip>
jlc-cli messages list
jlc-cli xiaozhi question <question...>
jlc-cli schema <command-or-public-type>
```

The CLI uses the `test.jlc.com` order pages and only the test site's own embedded
message/嘉小智 surfaces, forces manual order confirmation, disables SMT and steel
mesh, and never pays automatically. Supported order readback covers file review,
production nodes, shipping, and delivered/received status without guessing unknown
page text.

### Order operations (18)

`jlc-cli orders actions <order-id> --json` reports which of the 18 order
operations are visible in the order card's 更多 menu: re-upload reorder, print
contract, delivery note/receipt download, block reorder, edit memo, delete,
follow/unfollow, change shipping info, QA certificate download, pause production,
share to 硬创社, reselect/modify template, add/remove label, urge review, and urge
shipment.

Safety tiers:

- Read-only exports (`contract`, `delivery-note`, `certificate`) run directly.
- Reversible writes (`memo`, `follow`, `unfollow`, `label add|remove`,
  `urge review|ship`, `share`) need an interactive confirmation or
  `--confirm <order-id>`.
- Dangerous writes (`delete`, `pause`, `block-reorder`, `shipping`,
  `template reselect|modify`, `reorder`) are refused unless `--confirm` repeats
  the exact order ID. `reorder` uploads the new file into the reorder flow and
  never auto-submits an order.

Site semantics learned from the live test site: the 更多操作 panel lists all 18
entries with `*` hints for the ones the current order state blocks — blocked
entries are reported as `PAGE_BUSINESS_ERROR` without being clicked. `label add`
toggles the account's existing label groups (create groups via 管理标签分组),
while `label remove` clears **all** labels of the order after a confirm box.
`delete` is verified by re-querying the order list; server-side rejections such
as 具有实收金额的订单不能删除 are surfaced as `failed` with the site's message.

TUI commands include `/audit <order-id>`, `/actions <order-id>`,
`/pay <order-id>` (snapshot only), `/messages`, and `/xiaozhi <question>`. The 嘉小智 panel shows the submitted
question and the stable page response; it does not call an external model or a
private API in place of the website iframe.

See `jlc-cli schema <command>` for the public JSON contracts.

## First-run warning

The first interactive launch shows a Chinese third-party-tool warning before the
TUI or any account/order workflow can run. `否，退出` is selected by default.
Only an explicit interactive acceptance stores a local receipt containing the
notice version, SHA-256 fingerprint, and acceptance time; no user identity is
recorded. If the warning text changes, it must be accepted again.

The warning states that jlc-cli is a **third-party tool** — not officially
published, authorized, endorsed, or maintained by JLC — and that **every
operation is executed by, and at the sole risk of, the user**.

Non-interactive Agents are blocked until a human runs:

```bash
jlc-cli disclaimer accept
```

When an Agent is blocked this way, the JSON error envelope carries both the full
warning text and an `agentRelay` instruction: the Agent must relay the warning to
the user verbatim and continue only after the user explicitly accepts. The same
relay text is printed by `jlc-cli disclaimer show` and embedded in the generated
SKILL.md.

`--help`, `--version`, schemas, the warning commands, and browser installation/
diagnostics remain available before acceptance. This warning does not weaken
test-site-only, human-approval, manual-confirmation, or no-automatic-payment
safeguards.

## AI Agent production-selection modes

The safe default is `hard`:

```bash
jlc-cli mode set hard
jlc-cli mode status --json
```

`hard` mode (严谨模式) requires user-prompt, user-document, or Gerber evidence
for every production parameter. An Agent must ask for missing evidence and cannot
fill it from habits, preferences, engineering defaults, or webpage defaults.

`simple` mode (AI 选择模式) preserves every explicit user value, then lets the
calling AI Agent resolve only missing production parameters from Gerber facts,
global preferences, local non-cancelled order history, current site options, and
finally documented engineering judgment:

```bash
jlc-cli mode set simple
jlc-cli mode preference set boardThicknessMm=1.6
jlc-cli mode preference set 'processOptions.产品类型=工业类'
jlc-cli mode context --json
```

The legacy names `manual` and `auto` are still accepted as aliases for `hard`
and `simple`; existing config files are migrated automatically.

Agents pass scalar autonomous choices with `--auto-set key=value`. This channel
can only fill a missing value and is rejected in hard mode; it cannot replace
user-document evidence or an explicit user `--set`. Page-specific
`processOptions` should be placed in the generated requirements file.

The CLI does not embed an LLM. Agents inject the active policy using
`jlc-cli mode prompt`, or generate a reusable skill using:

```bash
jlc-cli mode skill --file ./SKILL.md
```

For PDF/XLSX evidence, the Agent reads the source locally and normalizes cited
values into the version 1 JSON/YAML/Markdown requirements format. Both modes
still block conflicts and webpage defaults, require human quote approval, keep
manual order confirmation, and never authorize payment or final submission by
the mode switch alone.

### Login: automated password or manual headed

`auth login --username <name> --password-stdin` performs a fully automated login
for authorized test accounts: it fills the passport account form, completes the
drag-slider verification with a human-like trajectory, and then reloads the order
pages until the order subsystem issues its CAS ticket. `auth status --json`
probes the order API (with the XSRF token, like the site itself) and reports
`authenticated: false` with `rawSignal: order-api-unauthenticated` when only the
page shell would render.

Interactive `auth login` (no credentials) opens the system Google Chrome as a
normal, non-Playwright process with the dedicated `jlc-cli` profile. Complete
credentials and any verification manually, then fully exit that dedicated Chrome
process: on macOS press Command-Q (closing only the window is not enough), and on
Windows close every window of the dedicated Chrome (for example Alt+F4) so it
leaves the system tray. The CLI reopens that same profile through Playwright and
only reports success when the account area, order list, order API, and PCB upload
page are all accessible. It never reads the user's everyday Chrome profile. If
automated slider verification is rejected, the CLI reports
`AUTH_INTERACTION_REQUIRED` and the headed flow remains the fallback. The manual
window times out after ten minutes by default; use `--timeout <ms>` to choose a
different limit.
