import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  unlink,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import type { BrowserConfig, BusinessResult, Operation } from "./contracts.js";

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const digest = (value: unknown): string =>
  createHash("sha256").update(stable(value)).digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const secretKey =
  /password|passwd|secret|token|cookie|authorization|smsCode|verificationCode/i;
export function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !secretKey.test(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  if (typeof value === "string")
    return value.replace(
      /((?:password|token|secret|cookie|authorization)\s*[=:]\s*)[^\s&]+/gi,
      "$1[redacted]",
    );
  return value;
}
export interface Config {
  version: 1;
  browser: BrowserConfig;
  consent?: { at: string; confirmedBy: string; version: 1 };
}
export interface CallbackSpec {
  url: string;
  secretEnv?: string;
}
export interface Task {
  id: string;
  operation: Operation;
  status: BusinessResult["status"] | "running";
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown>;
  data: Record<string, unknown>;
  targetId?: string;
  endpoint?: string;
  draft?: string;
  error?: BusinessResult["error"];
  next?: string[];
  effect?: {
    kind: "submit" | "pay";
    binding: Record<string, unknown>;
    at: string;
  };
  approvalId?: string;
  revision: number;
  callback?: CallbackSpec;
  delivery?: {
    eventId: string;
    delivered: boolean;
    attempts: number;
    error?: string;
    payload: Record<string, unknown>;
  };
  lease?: { id: string; owner: string; expiresAt: number };
}
export interface Approval {
  id: string;
  taskId: string;
  bindingHash: string;
  binding: Record<string, unknown>;
  expiresAt: number;
  consumedAt?: string;
  confirmedAt: string;
}
/** Reuse legacy profiles in place so retained browsers, tasks and approvals survive a rename. */
export function defaultStateHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  if (env.JLC_HOME) return env.JLC_HOME;
  if (env.FABRELAY_HOME) return env.FABRELAY_HOME;
  const current = join(userHome, ".jlc-cli");
  const legacy = join(userHome, ".fabrelay");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
export class State {
  readonly directory: string;
  constructor(home = defaultStateHome(), profile = "default") {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile))
      throw new CliError(
        "INVALID_PROFILE",
        "Profile must contain 1–64 letters, digits, underscores or hyphens.",
      );
    this.directory = resolve(home, "profiles", profile);
  }
  async init(): Promise<void> {
    for (const part of ["", "tasks", "approvals", "artifacts", "browser"]) {
      const dir = join(this.directory, part);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
    }
  }
  path(area: string, id?: string): string {
    if (id !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new CliError("INVALID_ID", "Invalid local identifier.");
    return id
      ? join(this.directory, area, id + ".json")
      : join(this.directory, area + ".json");
  }
  async read<T>(area: string, id?: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(area, id), "utf8")) as T;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CliError(
        "STATE_CORRUPT",
        `Cannot read ${area} state; preserve the file and inspect it.`,
      );
    }
  }
  async write(area: string, value: unknown, id?: string): Promise<void> {
    await this.init();
    const destination = this.path(area, id);
    const tmp = destination + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(tmp, destination);
    await chmod(destination, 0o600).catch(() => {});
  }
  async task(id: string): Promise<Task> {
    const task = await this.read<Task>("tasks", id);
    if (!task) throw new CliError("TASK_NOT_FOUND", `No task ${id}.`);
    return task;
  }
  async save(task: Task): Promise<void> {
    task.updatedAt = now();
    await this.write("tasks", task, task.id);
  }
  async tasks(): Promise<Task[]> {
    await this.init();
    return Promise.all(
      (await readdir(join(this.directory, "tasks")))
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.task(f.slice(0, -5))),
    );
  }
  async config(): Promise<Config> {
    return (
      (await this.read<Config>("config")) || {
        version: 1,
        browser: { engine: "obscura" },
      }
    );
  }
  async requireConsent(): Promise<Config> {
    const c = await this.config();
    if (!c.consent)
      throw new CliError(
        "CONSENT_REQUIRED",
        "Run jlc-cli init and explicitly accept the displayed authorization.",
      );
    return c;
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    await this.init();
    const file = join(this.directory, "operation.lock");
    const nonce = randomUUID();
    const record = () => ({ pid: process.pid, nonce, at: now() });
    const claim = () =>
      writeFile(file, JSON.stringify(record()), { flag: "wx", mode: 0o600 });
    type Owner = { pid: number; nonce: string };
    const dead = (owner: Owner) => {
      if (
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        typeof owner.nonce !== "string"
      )
        throw new CliError(
          "PROFILE_LOCKED",
          "Unrecognized lock owner; preserve its record for inspection.",
        );
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    try {
      await claim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observed: Owner;
      try {
        observed = JSON.parse(await readFile(file, "utf8"));
      } catch {
        throw new CliError(
          "PROFILE_LOCKED",
          "Profile lock changed while it was being inspected; retry.",
        );
      }
      if (!dead(observed))
        throw new CliError(
          "PROFILE_LOCKED",
          "Another CLI process controls this profile.",
        );
      // Immutable recovery claims are keyed by the previous owner. A dead recovery owner gets a new claim;
      // no contender can delete a newer process's recovery lock after inspecting an older one.
      const journal = join(this.directory, "lock-recovery");
      await mkdir(journal, { recursive: true, mode: 0o700 });
      let owner = observed;
      let elected = false;
      for (let depth = 0; depth < 64; depth++) {
        const recovery = join(journal, digest(owner.nonce) + ".json");
        try {
          await writeFile(recovery, JSON.stringify(record()), {
            flag: "wx",
            mode: 0o600,
          });
          elected = true;
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        try {
          owner = JSON.parse(await readFile(recovery, "utf8"));
        } catch {
          throw new CliError(
            "PROFILE_LOCKED",
            "Another process is recording a recovery claim; retry.",
          );
        }
        if (!dead(owner))
          throw new CliError(
            "PROFILE_LOCKED",
            "Another process is recovering this profile.",
          );
      }
      if (!elected)
        throw new CliError(
          "PROFILE_LOCKED",
          "Recovery journal requires inspection.",
        );
      let current: Owner | undefined;
      try {
        current = JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (current) {
        if (current.nonce !== observed.nonce || !dead(current))
          throw new CliError(
            "PROFILE_LOCKED",
            "Profile ownership changed; retry.",
          );
        await unlink(file);
      }
      try {
        await claim();
      } catch {
        throw new CliError(
          "PROFILE_LOCKED",
          "Another CLI process acquired this profile.",
        );
      }
    }
    try {
      return await fn();
    } finally {
      const owner = JSON.parse(
        await readFile(file, "utf8").catch(() => '{"nonce":null}'),
      );
      if (owner.nonce === nonce) await unlink(file).catch(() => {});
    }
  }
}
