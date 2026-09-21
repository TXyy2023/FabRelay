#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { readFile, cp, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  State,
  CliError,
  redact,
  now,
  type Task,
  type Approval,
} from "./state.js";
import { Engine } from "./engine.js";
import {
  browserProvider,
  stopOwnedBrowser,
  validateEndpoint,
} from "./browser.js";
import { siteAdapter } from "./site.js";
import { deliverCallback } from "./callback.js";
import type { Operation, Status } from "./contracts.js";

const program = new Command();
program
  .name("jlc-cli")
  .version("1.0.0-dev.1")
  .description(
    "jlc.com business CLI. default mode never selects unconfirmed manufacturing parameters.",
  )
  .option("--json", "machine-readable result")
  .option("--home <path>", "state root; defaults to JLC_HOME or ~/.jlc-cli")
  .option("--profile <name>", "isolated account profile", "default")
  .option("--timeout <ms>", "bounded browser step timeout", "30000")
  .showHelpAfterError()
  .exitOverride();
const exitCodes: Record<string, number> = {
  succeeded: 0,
  needs_input: 2,
  needs_login: 3,
  needs_confirmation: 4,
  handoff: 5,
  unknown: 6,
  failed: 1,
  running: 5,
};
function local() {
  const opts = program.opts();
  const state = new State(opts.home, opts.profile);
  return { state, engine: new Engine(state, browserProvider, siteAdapter) };
}
function integer(value: unknown, min: number, max: number): number {
  const v = Number(value);
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new CliError(
      "INVALID_ARGUMENT",
      `Expected an integer between ${min} and ${max}.`,
    );
  return v;
}
function output(
  operation: string,
  data: unknown,
  status = "succeeded",
  taskId?: string,
  error?: unknown,
  next?: unknown,
) {
  const value = {
    schemaVersion: 1,
    operation,
    taskId: taskId ?? null,
    status,
    data: redact(data),
    ...(error ? { error } : {}),
    ...(next ? { next } : {}),
  };
  if (program.opts().json) process.stdout.write(JSON.stringify(value) + "\n");
  else {
    process.stdout.write(
      `${operation}: ${status}${taskId ? ` [${taskId}]` : ""}\n` +
        JSON.stringify(redact(data), null, 2) +
        "\n",
    );
    if (error) process.stdout.write(JSON.stringify(error) + "\n");
    if (next) process.stdout.write(JSON.stringify(next) + "\n");
  }
  process.exitCode = exitCodes[status] ?? 1;
}
function taskOutput(task: Task, events = false) {
  const data = {
    ...task.data,
    ...(task.endpoint
      ? { cdp: { endpoint: task.endpoint, targetId: task.targetId } }
      : {}),
    ...(task.lease ? { lease: task.lease } : {}),
    ...(task.delivery
      ? {
          callback: {
            eventId: task.delivery.eventId,
            delivered: task.delivery.delivered,
            attempts: task.delivery.attempts,
            error: task.delivery.error,
          },
        }
      : {}),
  };
  if (events) {
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        eventId: `${task.id}:${task.revision}`,
        operation: task.operation,
        taskId: task.id,
        status: task.status,
        data: redact(data),
        error: task.error,
        next: task.next,
      }) + "\n",
    );
    process.exitCode = exitCodes[task.status];
  } else
    output(task.operation, data, task.status, task.id, task.error, task.next);
}
function workflow(command: Command): Command {
  return command
    .option("--draft <taskId>", "previous PCB workflow result")
    .option("--wait [seconds]", "watch verified recovery, default 300 seconds")
    .option("--events", "emit progress as JSONL")
    .option(
      "--callback <url>",
      "POST status to explicit HTTPS or loopback HTTP receiver",
    )
    .option(
      "--callback-secret-env <name>",
      "environment variable containing HMAC secret",
    );
}
async function run(
  operation: Operation,
  input: Record<string, unknown>,
  opts: Record<string, any> = {},
) {
  const { engine } = local();
  const timeout = integer(program.opts().timeout, 100, 600000);
  let task = await engine.run(operation, input, {
    draft: opts.draft,
    approvalId: opts.approval,
    timeoutMs: timeout,
    callback: opts.callback
      ? { url: opts.callback, secretEnv: opts.callbackSecretEnv }
      : undefined,
  });
  if (opts.events) taskOutput(task, true);
  if (opts.wait !== undefined) {
    const seconds = opts.wait === true ? 300 : integer(opts.wait, 1, 86400);
    const deadline = Date.now() + seconds * 1000;
    let last = "";
    while (
      Date.now() < deadline &&
      ["handoff", "unknown", "running"].includes(task.status)
    ) {
      await delay(Math.min(1500, Math.max(1, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      task = await engine.reconcile(
        task.id,
        Math.min(timeout, Math.max(100, deadline - Date.now())),
      );
      const signature = JSON.stringify({
        status: task.status,
        data: task.data,
        error: task.error,
      });
      if (opts.events && signature !== last) {
        taskOutput(task, true);
        last = signature;
      }
    }
  }
  if (!opts.events) taskOutput(task);
}
function env(name: unknown): string | undefined {
  if (!name) return undefined;
  const value = process.env[String(name)];
  if (!value)
    throw new CliError(
      "ENV_MISSING",
      `Set ${name} in this process environment.`,
    );
  return value;
}
async function jsonInput(value: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      value.startsWith("@")
        ? await readFile(resolve(value.slice(1)), "utf8")
        : value,
    );
  } catch {
    throw new CliError(
      "INVALID_JSON",
      "Pass a JSON object or @path/to/file.json.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("INVALID_JSON", "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

program
  .command("init")
  .description(
    "Authorize local sessions and routine reads; every balance payment still requires specific human confirmation.",
  )
  .option("--accept", "explicitly accept the displayed scope")
  .option("--confirmed-by <name>", "human who authorized this profile")
  .action(async (opts) => {
    const scope =
      "jlc-cli uses jlc.com, stores browser sessions locally, uploads files you select, and executes explicit business commands. Initialization does not authorize balance payment. Each payment requires confirmation of the account, order and amount. default mode does not choose unconfirmed parameters.";
    let accepted = opts.accept;
    let confirmedBy = opts.confirmedBy;
    if (!accepted && process.stdin.isTTY) {
      process.stderr.write(scope + "\n");
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        accepted =
          (await rl.question("Type ACCEPT to authorize: ")) === "ACCEPT";
        if (accepted) confirmedBy = "interactive-human";
      } finally {
        rl.close();
      }
    }
    if (!accepted || !confirmedBy) {
      output(
        "init",
        { scope, command: "jlc-cli init --accept --confirmed-by HUMAN" },
        "needs_confirmation",
      );
      return;
    }
    const { state } = local();
    await state.lock(async () => {
      const config = await state.config();
      config.consent = {
        version: 1,
        at: now(),
        confirmedBy: String(confirmedBy),
      };
      await state.write("config", config);
    });
    output("init", {
      authorized: true,
      scope,
      stateDirectory: state.directory,
    });
  });
const browser = program
  .command("browser")
  .description(
    "Configure and inspect Obscura or explicitly selected Chrome CDP",
  );
browser
  .command("configure")
  .option("--engine <name>", "obscura or chrome")
  .option("--endpoint <url>", "loopback CDP endpoint")
  .option(
    "--clear-endpoint",
    "use an owned browser instead of the configured external endpoint",
  )
  .option("--executable <path>", "engine executable")
  .option("--port <number>", "loopback launch port")
  .action(async (opts) => {
    const { state } = local();
    await state.lock(async () => {
      const config = await state.config();
      if (opts.endpoint && opts.clearEndpoint)
        throw new CliError(
          "INVALID_ARGUMENT",
          "Use --endpoint or --clear-endpoint, not both.",
        );
      if (opts.endpoint) opts.endpoint = validateEndpoint(opts.endpoint);
      if (opts.clearEndpoint) delete config.browser.endpoint;
      if (opts.engine && !["chrome", "obscura"].includes(opts.engine))
        throw new CliError("INVALID_ENGINE", "Engine is obscura or chrome.");
      config.browser = {
        ...config.browser,
        ...(opts.engine ? { engine: opts.engine } : {}),
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        ...(opts.executable ? { executable: resolve(opts.executable) } : {}),
        ...(opts.port ? { port: integer(opts.port, 1024, 65535) } : {}),
      };
      await state.write("config", config);
      output("browser.configure", { browser: config.browser });
    });
  });
browser.command("stop").action(async () => {
  const { state } = local();
  await state.lock(async () =>
    output("browser.stop", {
      stopped: await stopOwnedBrowser(join(state.directory, "browser")),
    }),
  );
});
browser.command("doctor").action(async () => {
  const { state } = local();
  output(
    "browser.doctor",
    await browserProvider.doctor((await state.config()).browser),
  );
});
program.command("doctor").action(async () => {
  const { state } = local();
  output("doctor", {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    stateDirectory: state.directory,
    initialized: !!(await state.config()).consent,
    browser: await browserProvider.doctor((await state.config()).browser),
  });
});
const auth = program
  .command("auth")
  .description(
    "Login and verify identity; credentials are never persisted in task records",
  );
workflow(
  auth
    .command("login")
    .option(
      "--method <method>",
      "password, sms, qr, wechat or manual",
      "manual",
    )
    .option("--username <value>", "customer/account identifier")
    .option("--phone <value>", "phone for site-supported SMS login")
    .option("--password-env <name>", "read password from environment")
    .option("--code-env <name>", "read verification code from environment"),
).action(async (opts) => {
  if (!["password", "sms", "qr", "wechat", "manual"].includes(opts.method))
    throw new CliError(
      "INVALID_LOGIN_METHOD",
      "Use password, sms, qr, wechat, or manual.",
    );
  await run(
    "auth.login",
    {
      method: opts.method,
      username: opts.username,
      phone: opts.phone,
      password: env(opts.passwordEnv),
      smsCode: env(opts.codeEnv),
    },
    opts,
  );
});
auth
  .command("logout")
  .description(
    "Clear only this CLI profile session; an external browser keeps its own sign-in.",
  )
  .action(async () => {
    const { state } = local();
    await state.lock(async () => {
      const externalSessionUnchanged = !!(await state.config()).browser
        .endpoint;
      await stopOwnedBrowser(join(state.directory, "browser"));
      await rm(join(state.directory, "browser"), {
        recursive: true,
        force: true,
      });
      output("auth.logout", {
        localSessionCleared: true,
        externalSessionUnchanged,
      });
    });
  });
auth.command("status").action(() => run("auth.status", {}));
const account = program.command("account");
account.command("show").action(() => run("account.show", {}));
const pcb = program
  .command("pcb")
  .description(
    "Use --draft with the most recent task ID to keep file, parameters and quote linked",
  );
workflow(pcb.command("upload <file>")).action(async (file, opts) => {
  const path = resolve(file);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile())
    throw new CliError(
      "FILE_NOT_FOUND",
      "Input must be a readable regular file.",
    );
  if (info.size > 100 * 1024 * 1024)
    throw new CliError(
      "FILE_TOO_LARGE",
      "The observed website accepts files up to 100 MiB; inspect current website limits.",
    );
  const hash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  await run("pcb.upload", { file: path, sha256: hash, size: info.size }, opts);
});
for (const action of [
  "options",
  "preview",
  "quote",
  "check",
  "submit",
] as const) {
  workflow(pcb.command(action)).action(async (opts) => {
    if (action !== "options" && !opts.draft)
      throw new CliError(
        "DRAFT_REQUIRED",
        "Supply --draft with the current PCB task ID.",
      );
    await run(`pcb.${action}`, {}, opts);
  });
}
workflow(
  pcb
    .command("set")
    .requiredOption("--params <json>", "explicit field/value JSON or @file")
    .option(
      "--mode <mode>",
      "default or auto; auto requires user intent in the calling Agent",
      "default",
    ),
).action(async (opts) => {
  if (!["default", "auto"].includes(opts.mode))
    throw new CliError("INVALID_MODE", "Use default or auto.");
  if (!opts.draft)
    throw new CliError(
      "DRAFT_REQUIRED",
      "Supply --draft with the current PCB task ID.",
    );
  await run(
    "pcb.set",
    { params: await jsonInput(opts.params), mode: opts.mode },
    opts,
  );
});
const orders = program.command("orders");
orders
  .command("list")
  .option("--status <text>")
  .option("--page <n>", "page number", "1")
  .action((opts) =>
    run("orders.list", {
      status: opts.status,
      ...(integer(opts.page, 1, 10000) !== 1
        ? { page: integer(opts.page, 1, 10000) }
        : {}),
    }),
  );
for (const action of ["show", "progress"] as const)
  orders
    .command(`${action} <orderId>`)
    .action((orderId) => run(`orders.${action}`, { orderId }));
const payment = program
  .command("payment")
  .description(
    "Balance only; prepare → exact human confirmation → execute → verify.",
  );
payment
  .command("prepare <orderId>")
  .action((orderId) => run("payment.prepare", { orderId }));
payment
  .command("confirm <taskId>")
  .requiredOption("--order <orderId>")
  .requiredOption("--amount <amount>")
  .option(
    "--human-confirmed",
    "assert the human explicitly approved this exact prepared payment",
  )
  .action(async (id, opts) => {
    const { engine } = local();
    const approval = await engine.confirm(
      id,
      opts.humanConfirmed === true,
      opts.order,
      opts.amount,
    );
    output("payment.confirm", {
      approvalId: approval.id,
      binding: approval.binding,
      expiresAt: new Date(approval.expiresAt).toISOString(),
    });
  });
workflow(
  payment.command("execute <orderId>").requiredOption("--approval <id>"),
).action((orderId, opts) => run("payment.execute", { orderId }, opts));
workflow(
  program
    .command("xiaozhi")
    .description(
      "Send one prompt to 嘉小智; replies never authorize manufacturing choices or payment",
    )
    .command("ask <message>"),
).action((message, opts) => run("xiaozhi.ask", { message }, opts));
const task = program.command("task");
task.command("list").action(async () =>
  output("task.list", {
    tasks: (await local().state.tasks()).map(
      ({ id, operation, status, createdAt, updatedAt }) => ({
        id,
        operation,
        status,
        createdAt,
        updatedAt,
      }),
    ),
  }),
);
task
  .command("show <id>")
  .action(async (id) => taskOutput(await local().state.task(id)));
task
  .command("watch <id>")
  .option("--wait [seconds]", "bounded reconciliation", "300")
  .option("--events", "JSONL events")
  .action(async (id, opts) => {
    const { engine, state } = local();
    const seconds = opts.wait === true ? 300 : integer(opts.wait, 1, 86400);
    const deadline = Date.now() + seconds * 1000;
    let value = await state.task(id);
    do {
      value = await engine.reconcile(
        id,
        Math.min(
          integer(program.opts().timeout, 100, 600000),
          Math.max(100, deadline - Date.now()),
        ),
      );
      if (opts.events) taskOutput(value, true);
      if (!["handoff", "unknown", "running"].includes(value.status)) break;
      if (Date.now() < deadline)
        await delay(Math.min(1500, deadline - Date.now()));
    } while (Date.now() < deadline);
    if (!opts.events) taskOutput(value);
  });
task.command("callback-retry <id>").action(async (id) => {
  const { state } = local();
  await state.lock(async () => {
    const value = await state.task(id);
    await deliverCallback(state, value, true);
    taskOutput(value);
  });
});
const handoff = program.command("handoff");
handoff
  .command("acquire <id>")
  .option("--owner <name>", "lease owner", "agent")
  .option("--seconds <n>", "lease lifetime", "600")
  .action(async (id, opts) =>
    taskOutput(
      await local().engine.handoff(
        id,
        opts.owner,
        integer(opts.seconds, 1, 3600),
      ),
    ),
  );
handoff
  .command("release <id>")
  .requiredOption("--lease <id>")
  .action(async (id, opts) =>
    taskOutput(await local().engine.release(id, opts.lease)),
  );
const skill = program.command("skill");
const skillPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/jlc-cli",
);
skill
  .command("path")
  .action(() => output("skill.path", { path: join(skillPath, "SKILL.md") }));
skill
  .command("install")
  .requiredOption(
    "--to <directory>",
    "explicit skills root; installs jlc-cli child",
  )
  .action(async (opts) => {
    const destination = resolve(opts.to, "jlc-cli");
    if (await stat(destination).catch(() => undefined))
      throw new CliError(
        "DESTINATION_EXISTS",
        "Existing skill preserved. Choose a new skills directory or review it manually.",
      );
    await mkdir(resolve(opts.to), { recursive: true });
    await cp(skillPath, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    output("skill.install", { path: destination });
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0)
    process.exitCode = 0;
  else if (error instanceof CommanderError)
    output("cli", {}, "failed", undefined, {
      code: "INVALID_ARGUMENT",
      message: error.message,
    });
  else
    output(
      "cli",
      error instanceof CliError ? error.data : {},
      "failed",
      undefined,
      {
        code: error instanceof CliError ? error.code : "INTERNAL_ERROR",
        message: redact(error instanceof Error ? error.message : String(error)),
      },
    );
}
