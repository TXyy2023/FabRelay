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
Use `Shift+Tab` to cycle between the persisted manual and auto Agent modes; the
active mode is always shown above and below the command box.
After login, the TUI reads the visible account area and shows the user name,
customer code, and the company that owns the current customer code. The TUI
also has platform-message and 嘉小智 conversation panels. `jlc-cli auth status
--json` returns the same user summary.

Requirements: Node.js 22.12 or newer on macOS ARM64. The package uses its own
0700 Playwright profile and never opens the user's normal Chrome profile.

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
jlc-cli messages list
jlc-cli xiaozhi question <question...>
jlc-cli schema <command-or-public-type>
```

The initial release uses the `test.jlc.com` order pages and only the test site's
own embedded message/嘉小智 surfaces, forces manual order confirmation, disables
SMT and steel mesh, and never pays automatically, modifies, cancels, or deletes
an order. Supported order readback covers file review, production nodes,
shipping, and delivered/received status without guessing unknown page text.

TUI commands include `/audit <order-id>`, `/pay <order-id>` (snapshot only),
`/messages`, and `/xiaozhi <question>`. The 嘉小智 panel shows the submitted
question and the stable page response; it does not call an external model or a
private API in place of the website iframe.

See `jlc-cli schema <command>` for the public JSON contracts.

## First-run warning

The first interactive launch shows a Chinese unofficial-tool warning before the
TUI or any account/order workflow can run. `否，退出` is selected by default.
Only an explicit interactive acceptance stores a local receipt containing the
notice version, SHA-256 fingerprint, and acceptance time; no user identity is
recorded. If the warning text changes, it must be accepted again.

Non-interactive Agents are blocked until a human runs:

```bash
jlc-cli disclaimer accept
```

`--help`, `--version`, schemas, the warning commands, and browser installation/
diagnostics remain available before acceptance. This warning states that the CLI
is not officially published, authorized, endorsed, or maintained by JLC and that
the user assumes the consequences of using it. It does not weaken test-site-only,
human-approval, manual-confirmation, or no-automatic-payment safeguards.

## AI Agent production-selection modes

The safe default is `manual`:

```bash
jlc-cli mode set manual
jlc-cli mode status --json
```

Manual mode requires user-prompt, user-document, or Gerber evidence for every
production parameter. An Agent must ask for missing evidence and cannot fill it
from habits, preferences, engineering defaults, or webpage defaults.

Auto mode preserves every explicit user value, then lets the calling AI Agent
resolve only missing production parameters from Gerber facts, global preferences,
local non-cancelled order history, current site options, and finally documented
engineering judgment:

```bash
jlc-cli mode set auto
jlc-cli mode preference set boardThicknessMm=1.6
jlc-cli mode preference set 'processOptions.产品类型=工业类'
jlc-cli mode context --json
```

Agents pass scalar autonomous choices with `--auto-set key=value`. This channel
can only fill a missing value and is rejected in manual mode; it cannot replace
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

### Slider verification login

Interactive `auth login` opens the system Google Chrome as a normal, non-Playwright
process with the dedicated `jlc-cli` profile. Complete credentials and the slider
manually, then press Command-Q in that dedicated Chrome window to exit its process.
Closing only the macOS window is not enough. The CLI reopens that same profile
through Playwright and only reports success when the account area, order
list, and PCB upload page are all accessible. It never reads the user's everyday
Chrome profile and does not automate or bypass the slider. `--password-stdin`
remains available only for authorized test accounts that do not require interactive
verification. The manual window times out after ten minutes by default; use
`--timeout <ms>` to choose a different limit.
