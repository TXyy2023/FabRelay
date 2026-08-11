#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Command, CommanderError, Option } from 'commander';
import { browserDoctor, installChromium } from '../browser/doctor.js';
import { runManualChromeLogin } from '../browser/manual-login.js';
import { parseBrowserEngine } from '../browser/runtime.js';
import { clearBrowserSession, withBrowserSession, type BrowserSessionOptions } from '../browser/session.js';
import { createOutputContext, writeError, writeSuccess } from '../cli/output.js';
import { JlcError } from '../domain/errors.js';
import { inspectGerberZip } from '../gerber/inspect.js';
import { LoginPage } from '../pages/login-page.js';
import {
  AGENT_RELAY_NOTICE,
  DISCLAIMER_NOTICE,
  DISCLAIMER_SHOW_TEXT,
  disclaimerStatus,
  resetDisclaimer
} from '../disclaimer/index.js';
import {
  buildAgentSkillMarkdown,
  readAgentModeContext,
  readModeConfiguration,
  setAgentMode,
  setGlobalPreference,
  unsetGlobalPreference
} from '../mode/index.js';
import { assertRequirementsReady, resolveRequirements } from '../requirements/resolve.js';
import { schemaFor } from '../schema/index.js';
import { StateDatabase } from '../storage/database.js';
import { runDisclaimerPrompt, startTui } from '../tui/app.js';
import { approveQuote } from '../workflows/approval.js';
import { createOrder } from '../workflows/order-create.js';
import { auditOrder, listOrders, showOrder, watchOrder } from '../workflows/orders.js';
import { listOrderActions, runOrderAction } from '../workflows/order-actions.js';
import { ORDER_ACTION_DEFINITIONS } from '../workflows/order-action-registry.js';
import type { OrderActionId } from '../domain/types.js';
import { createQuote, readCurrentOptions } from '../workflows/quote.js';
import { listPlatformMessages } from '../workflows/messages.js';
import { approvePayment, executePayment, preparePayment } from '../workflows/payment.js';
import { askXiaoZhi } from '../workflows/xiaozhi.js';

interface GlobalOptions {
  json?: boolean;
  noInput?: boolean;
  input?: string;
  requestId?: string;
  timeout?: string;
  output?: string;
  headed?: boolean;
  headless?: boolean;
  slowMo?: string;
  browser?: string;
}

class NoInputOption extends Option {
  override attributeName(): string {
    return 'noInput';
  }
}

const rawArgs = process.argv.slice(2);
const requestIdIndex = rawArgs.indexOf('--request-id');
const outputContext = createOutputContext(rawArgs.includes('--json'), requestIdIndex >= 0 ? rawArgs[requestIdIndex + 1] : undefined);

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function browserOptions(command: Command): BrowserSessionOptions {
  const value = globals(command);
  if (value.headed && value.headless) throw new JlcError('INVALID_ARGUMENT', '--headed and --headless cannot be used together.');
  const timeoutMs = value.timeout === undefined ? undefined : positiveInteger(value.timeout, '--timeout');
  const slowMo = value.slowMo === undefined ? undefined : nonnegativeInteger(value.slowMo, '--slow-mo');
  return {
    browser: parseBrowserEngine(value.browser),
    headed: value.headed === true && value.headless !== true,
    timeoutMs,
    slowMo
  };
}

const program = new Command()
  .name('jlc-cli')
  .description('Playwright-first CLI for the JLC PCB test-order workflow')
  .version('0.3.0')
  .option('--json', 'write a stable JSON envelope')
  .addOption(new NoInputOption('--no-input', 'disable interactive prompts'))
  .option('--input <source>', 'read structured command input; use - for stdin')
  .option('--request-id <id>', 'idempotency and tracing request ID')
  .option('--timeout <ms>', 'browser timeout in milliseconds')
  .option('--output <directory>', 'artifact output directory')
  .option('--browser <engine>', 'browser engine: auto, chrome, or chromium', 'auto')
  .option('--headless', 'run the selected browser headlessly')
  .option('--headed', 'show the selected browser')
  .option('--slow-mo <ms>', 'delay Playwright actions');

program.exitOverride();

const browser = program.command('browser').description('manage the Chrome and Playwright Chromium runtimes');
browser.command('install').action(async () => writeSuccess(outputContext, await installChromium()));
browser.command('doctor').action(async (_options, command) => {
  writeSuccess(outputContext, await browserDoctor(browserOptions(command).browser));
});

const auth = program.command('auth').description('manage the dedicated test-site browser session');
auth.command('login')
  .option('--username <value>', 'test account username; never persisted')
  .option('--password-stdin', 'read the password from stdin')
  .action(async (options: { username?: string; passwordStdin?: boolean }, command: Command) => {
    const automatic = Boolean(options.passwordStdin);
    if (automatic && !options.username) throw new JlcError('INVALID_ARGUMENT', '--username is required with --password-stdin.');
    if (!automatic && globals(command).noInput) throw new JlcError('AUTH_INTERACTION_REQUIRED', 'Manual login is disabled by --no-input.');
    const selectedOptions = browserOptions(command);
    if (!automatic && globals(command).headless) {
      throw new JlcError('INVALID_ARGUMENT', 'Manual slider verification cannot run with --headless.');
    }
    if (!automatic && selectedOptions.browser === 'chromium') {
      throw new JlcError('INVALID_ARGUMENT', 'Manual slider verification requires --browser auto or --browser chrome.');
    }
    if (!automatic) {
      await runManualChromeLogin(selectedOptions.timeoutMs ?? 10 * 60_000);
      const result = await withBrowserSession({ ...selectedOptions, browser: 'chrome', headed: false }, async (session) => {
        return await new LoginPage(session.page).status();
      });
      if (!result.authenticated) {
        throw new JlcError('AUTH_REQUIRED', 'Chrome closed, but the dedicated profile did not pass account, order-list, and PCB-order-page verification.', {
          details: result
        });
      }
      writeSuccess(outputContext, { ...result, loginMode: 'manual-system-chrome', browser: 'chrome' });
      return;
    }
    const result = await withBrowserSession({ ...selectedOptions, headed: globals(command).headed }, async (session) => {
      const login = new LoginPage(session.page);
      return await login.loginWithPassword(options.username!, (await readStdin()).trimEnd());
    });
    writeSuccess(outputContext, result);
  });
auth.command('status').action(async (_options, command) => {
  const result = await withBrowserSession(browserOptions(command), async (session) => await new LoginPage(session.page).status());
  writeSuccess(outputContext, result);
});
auth.command('logout').action(async (_options, command) => {
  await clearBrowserSession({ browser: browserOptions(command).browser });
  writeSuccess(outputContext, { loggedOut: true });
});

const disclaimer = program.command('disclaimer').description('show or acknowledge the first-run third-party-tool warning');
disclaimer.command('status').action(async () => writeSuccess(outputContext, await disclaimerStatus()));
disclaimer.command('show').action(() => writeSuccess(outputContext, DISCLAIMER_SHOW_TEXT));
disclaimer.command('accept').action(async () => {
  const accepted = await runDisclaimerPrompt();
  if (!accepted) throw new JlcError('APPROVAL_REQUIRED', '未接受第三方工具警告，已取消运行。');
  writeSuccess(outputContext, await disclaimerStatus());
});
disclaimer.command('reset').description('show the warning again on the next run').action(async () => {
  writeSuccess(outputContext, await resetDisclaimer());
});

const modeCommand = program.command('mode').description('show or change the AI Agent production-selection mode');
modeCommand.action(async () => writeSuccess(outputContext, await readAgentModeContext()));
modeCommand.command('status').action(async () => writeSuccess(outputContext, await readAgentModeContext()));
modeCommand.command('set <mode>').action(async (value: string) => {
  const configuration = await setAgentMode(value);
  writeSuccess(outputContext, { mode: configuration.mode, persisted: true });
});
modeCommand.command('prompt').description('print the active prompt for AI Agent injection').action(async () => {
  const context = await readAgentModeContext();
  writeSuccess(outputContext, context.prompt);
});
modeCommand.command('context').description('print mode, preferences, order-history suggestions, and prompt').action(async () => {
  writeSuccess(outputContext, await readAgentModeContext());
});
modeCommand.command('skill').description('print or write an Agent SKILL.md')
  .option('--file <path>', 'write the generated SKILL.md to this path')
  .action(async (options: { file?: string }) => {
    const markdown = buildAgentSkillMarkdown();
    if (!options.file) return writeSuccess(outputContext, markdown);
    const outputPath = path.resolve(options.file);
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, markdown, { mode: 0o600 });
    writeSuccess(outputContext, { file: outputPath, mode: (await readModeConfiguration()).mode });
  });

const preference = modeCommand.command('preference').description('manage global production preferences used by simple mode');
preference.command('list').action(async () => {
  const configuration = await readModeConfiguration();
  writeSuccess(outputContext, { mode: configuration.mode, globalPreferences: configuration.globalPreferences });
});
preference.command('set <key=value>').action(async (value: string) => {
  const configuration = await setGlobalPreference(value);
  writeSuccess(outputContext, { mode: configuration.mode, globalPreferences: configuration.globalPreferences });
});
preference.command('unset <key>').action(async (key: string) => {
  const configuration = await unsetGlobalPreference(key);
  writeSuccess(outputContext, { mode: configuration.mode, globalPreferences: configuration.globalPreferences });
});

const requirements = program.command('requirements');
requirements.command('validate <files...>')
  .option('--set <key=value>', 'resolve a parameter explicitly', collect, [])
  .option('--auto-set <key=value>', 'fill a missing parameter as a simple-mode Agent decision', collect, [])
  .action(async (files: string[], options: { set: string[]; autoSet: string[] }) => {
    const result = await resolveRequirements(files, options.set, options.autoSet);
    assertRequirementsReady(result, (await readModeConfiguration()).mode);
    writeSuccess(outputContext, result);
  });

const pcb = program.command('pcb');
pcb.command('inspect <gerber.zip>').action(async (file: string, _options, command) => {
  writeSuccess(outputContext, await inspectGerberZip(file, { render: false, outputDir: globals(command).output }));
});
pcb.command('preview <gerber.zip>').action(async (file: string, _options, command) => {
  writeSuccess(outputContext, await inspectGerberZip(file, { render: true, outputDir: globals(command).output }));
});
pcb.command('options').action(async (_options, command) => writeSuccess(outputContext, await readCurrentOptions(browserOptions(command))));
pcb.command('quote <gerber.zip>')
  .option('-r, --requirements <file>', 'requirement file; repeat for multiple files', collect, [])
  .option('--set <key=value>', 'resolve a parameter explicitly', collect, [])
  .option('--auto-set <key=value>', 'fill a missing parameter as a simple-mode Agent decision', collect, [])
  .action(async (file: string, options: { requirements: string[]; set: string[]; autoSet: string[] }, command: Command) => {
    if (options.requirements.length === 0 && options.set.length === 0 && options.autoSet.length === 0) {
      throw new JlcError('INVALID_ARGUMENT', 'Provide --requirements and/or explicit --set/--auto-set evidence for the PCB parameters.');
    }
    writeSuccess(outputContext, await createQuote(file, {
      ...browserOptions(command),
      requirementFiles: options.requirements,
      overrides: options.set,
      autoSelections: options.autoSet,
      outputDir: globals(command).output
    }));
  });

const approval = pcb.command('approval');
approval.command('create').requiredOption('--quote <id>').action(async (options: { quote: string }) => writeSuccess(outputContext, await approveQuote(options.quote)));

const order = pcb.command('order');
order.command('create')
  .requiredOption('--quote <id>')
  .requiredOption('--approval <file>')
  .action(async (options: { quote: string; approval: string }, command: Command) => {
    writeSuccess(outputContext, await createOrder({
      ...browserOptions(command),
      quoteId: options.quote,
      approvalFile: options.approval,
      requestId: outputContext.requestId,
      outputDir: globals(command).output
    }));
  });

const orders = program.command('orders');
orders.command('list').option('--limit <n>', 'maximum visible rows', '50').action(async (options: { limit: string }, command: Command) => {
  writeSuccess(outputContext, await listOrders({ ...browserOptions(command), limit: positiveInteger(options.limit, '--limit') }));
});
orders.command('show <order-id>').action(async (id: string, _options, command) => writeSuccess(outputContext, await showOrder(id, browserOptions(command))));
orders.command('audit <order-id>').description('read the visible PCB file-review result').action(async (id: string, _options, command) => {
  writeSuccess(outputContext, await auditOrder(id, browserOptions(command)));
});
orders.command('watch <order-id>').option('--interval <ms>', 'poll interval', '30000').action(async (id: string, options: { interval: string }, command: Command) => {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    await watchOrder(id, {
      ...browserOptions(command),
      intervalMs: positiveInteger(options.interval, '--interval'),
      signal: controller.signal,
      onChange: (snapshot) => writeSuccess(outputContext, snapshot)
    });
  } finally {
    process.off('SIGINT', stop);
  }
});

const payment = orders.command('payment').alias('pay').description('prepare, approve, and execute a guarded balance payment');
payment.command('prepare <order-id>').action(async (id: string, _options, command) => {
  writeSuccess(outputContext, await preparePayment(id, { ...browserOptions(command), outputDir: globals(command).output }));
});
const paymentApproval = payment.command('approval');
paymentApproval.command('create').requiredOption('--payment <id>').action(async (options: { payment: string }) => {
  writeSuccess(outputContext, await approvePayment(options.payment));
});
payment.command('execute')
  .requiredOption('--payment <id>')
  .requiredOption('--approval <file>')
  .action(async (options: { payment: string; approval: string }, command: Command) => {
    writeSuccess(outputContext, await executePayment({
      ...browserOptions(command),
      paymentId: options.payment,
      approvalFile: options.approval,
      requestId: outputContext.requestId,
      outputDir: globals(command).output
    }));
  });

// ---- orders <action>: the 18 "更多操作" commands. Confirmation semantics and
// site behavior live in src/workflows/order-action-registry.ts / order-actions.ts.
interface OrderActionCliOptions {
  confirm?: string;
  memo?: string;
  text?: string;
  label?: string;
  addressId?: string;
  template?: string;
  file?: string;
}

function runOrderActionCommand(action: OrderActionId) {
  return async (orderId: string, options: OrderActionCliOptions, command: Command) => {
    writeSuccess(outputContext, await runOrderAction(orderId, action, {
      ...browserOptions(command),
      confirm: options.confirm,
      memo: options.memo ?? options.text,
      label: options.label,
      addressId: options.addressId,
      template: options.template,
      text: options.text,
      file: options.file,
      outputDir: globals(command).output
    }));
  };
}

function confirmOption(command: Command): Command {
  return command.option('--confirm <order-id>', 'confirm the action by repeating the exact order ID');
}

orders.command('actions <order-id>').description('list which of the 18 order operations are visible for this order').action(async (id: string, _options, command: Command) => {
  writeSuccess(outputContext, await listOrderActions(id, browserOptions(command)));
});
confirmOption(orders.command('memo <order-id>').description('edit the order memo (编辑备忘录)')
  .option('--memo <text>', 'memo content')
  .option('--text <text>', 'alias of --memo'))
  .action(runOrderActionCommand('edit_memo'));
confirmOption(orders.command('delete <order-id>').description('delete the order (删除订单)'))
  .action(runOrderActionCommand('delete_order'));
confirmOption(orders.command('follow <order-id>').description('follow the order (关注订单)'))
  .action(runOrderActionCommand('follow'));
confirmOption(orders.command('unfollow <order-id>').description('unfollow the order (取消关注订单)'))
  .action(runOrderActionCommand('unfollow'));
confirmOption(orders.command('block-reorder <order-id>').description('mark the order as no-reorder (标记禁止返单)'))
  .action(runOrderActionCommand('block_reorder'));
confirmOption(orders.command('shipping <order-id>').description('change the shipping info (修改收货信息)')
  .requiredOption('--address-id <id>', 'visible address entry to select in the shipping dialog'))
  .action(runOrderActionCommand('change_shipping'));
orders.command('certificate <order-id>').description('download the quality assurance certificate (下载质量保证书)')
  .action(runOrderActionCommand('download_qa_certificate'));
confirmOption(orders.command('pause <order-id>').description('pause production (暂停生产)'))
  .action(runOrderActionCommand('pause_production'));
confirmOption(orders.command('share <order-id>').description('share the order to 硬创社 (分享到硬创社)'))
  .action(runOrderActionCommand('share_to_yingchuang'));
const template = orders.command('template').description('order template operations');
confirmOption(template.command('reselect <order-id>').description('reselect the order template (重选模板)')
  .option('--template <name>', 'visible template name to select'))
  .action(runOrderActionCommand('reselect_template'));
confirmOption(template.command('modify <order-id>').description('modify the template content (修改模板内容)')
  .option('--text <content>', 'new template content'))
  .action(runOrderActionCommand('modify_template'));
const label = orders.command('label').description('order label operations');
confirmOption(label.command('add <order-id>').description('add a label (添加标签)')
  .requiredOption('--label <label>', 'label to add'))
  .action(runOrderActionCommand('add_label'));
confirmOption(label.command('remove <order-id>').description('clear ALL labels of the order (移除标签, site semantics)')
  .option('--label <label>', 'accepted for symmetry; the site clears every label'))
  .action(runOrderActionCommand('remove_label'));
const urge = orders.command('urge').description('urge the order along');
confirmOption(urge.command('review <order-id>').description('urge file review (催审单)'))
  .action(runOrderActionCommand('urge_review'));
confirmOption(urge.command('ship <order-id>').description('urge shipment (催发货)'))
  .action(runOrderActionCommand('urge_shipment'));
orders.command('contract <order-id>').description('print/export the order contract (打印合同)')
  .action(runOrderActionCommand('print_contract'));
orders.command('delivery-note <order-id>').description('download the electronic delivery note and receipt (电子送货单及收据)')
  .action(runOrderActionCommand('delivery_note'));
confirmOption(orders.command('reorder <order-id>').description('re-upload files and reorder; never auto-submits (重新上传文件下单)')
  .requiredOption('--file <gerber.zip>', 'new Gerber ZIP to upload'))
  .action(runOrderActionCommand('reorder'));

const messages = program.command('messages').description('read platform and inbox messages from the visible test-site panel');
messages.command('list').option('--limit <n>', 'maximum messages', '20').action(async (options: { limit: string }, command: Command) => {
  writeSuccess(outputContext, await listPlatformMessages({ ...browserOptions(command), limit: positiveInteger(options.limit, '--limit') }));
});

const xiaozhi = program.command('xiaozhi').description('通过页面右下角的嘉小智对话');
xiaozhi.command('question <question...>').action(async (question: string[], _options, command) => {
  writeSuccess(outputContext, await askXiaoZhi(question.join(' '), browserOptions(command)));
});

program.command('schema <command>').action((name: string) => writeSuccess(outputContext, schemaFor(name)));

async function main(): Promise<void> {
  try {
    if (rawArgs.length === 0) {
      await startTui();
      return;
    }
    if (!disclaimerExempt(rawArgs) && (await disclaimerStatus()).required) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new JlcError('APPROVAL_REQUIRED', '首次使用必须由用户在交互式终端阅读并确认第三方工具警告。Agent 请先将警告原文转述给用户。请运行 `jlc-cli disclaimer accept`。', {
          details: {
            notice: DISCLAIMER_NOTICE,
            agentRelay: AGENT_RELAY_NOTICE
          }
        });
      }
      if (!await runDisclaimerPrompt()) {
        throw new JlcError('APPROVAL_REQUIRED', '未接受第三方工具警告，已取消运行。');
      }
    }
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')) return;
    const value = error instanceof CommanderError
      ? new JlcError('INVALID_ARGUMENT', error.message)
      : error;
    process.exitCode = writeError(outputContext, value);
  }
}

function disclaimerExempt(args: string[]): boolean {
  return args.includes('--help')
    || args.includes('-h')
    || args.includes('--version')
    || args.includes('-V')
    || args.includes('help')
    || args.includes('disclaimer')
    || args.includes('schema')
    || (args.includes('browser') && (args.includes('doctor') || args.includes('install')));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new JlcError('INVALID_ARGUMENT', `${name} must be a positive integer.`);
  return parsed;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new JlcError('INVALID_ARGUMENT', `${name} must be a nonnegative integer.`);
  return parsed;
}

await main();
