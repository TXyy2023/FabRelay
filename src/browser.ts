import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { spawn, execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  BrowserConfig,
  BrowserConnection,
  BrowserProvider,
} from "./contracts.js";

type Engine = BrowserConfig["engine"];
interface RuntimeRecord {
  version: 1;
  engine: Engine;
  endpoint: string;
  token: string;
  pid: number;
  executable: string;
  restored?: boolean;
  targetId?: string;
}
interface SavedState {
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
  origins: {
    origin: string;
    localStorage: { name: string; value: string }[];
  }[];
}
const defaultTimeout = 20_000;
const moduleFile = fileURLToPath(import.meta.url);
const runtimeName = "browser-runtime.json";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BrowserRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserRuntimeError";
    this.code = code;
  }
}

/** Remote hosts, credentials, query tokens and redirects are deliberately unsupported. */
export function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserRuntimeError(
      "INVALID_CDP_ENDPOINT",
      "CDP endpoint must be an absolute loopback HTTP or WebSocket URL.",
    );
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BrowserRuntimeError(
      "UNSAFE_CDP_ENDPOINT",
      "CDP endpoint must use loopback without URL credentials, query parameters or fragments.",
    );
  }
  // Pin localhost rather than trusting DNS configuration.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString().replace(/\/$/, "");
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ws:", "wss:", "about:"].includes(url.protocol))
      return `${url.protocol}[redacted]`;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[unavailable]";
  }
}

/** Only a bounded startup excerpt is persisted; never retain live browser logs. */
export function sanitizeStartupStderr(value: string): string {
  return value
    .slice(0, 16_384)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (match) => sanitizeUrl(match))
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi,
      "[credential header redacted]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /\b(password|passwd|(?:access[_-]?|refresh[_-]?)?token|secret|session(?:id)?|api[_-]?key|access[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .trim()
    .slice(0, 4096);
}

export function chromeLaunchArguments(
  profile: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string[] {
  return [
    ...(env.JLC_CHROME_HEADLESS === "0" ? [] : ["--headless=new"]),
    // Never weaken production sandboxing automatically. This opt-in is used
    // only by the isolated Linux CI fixtures in the checked-in workflow.
    ...(platform === "linux" && env.JLC_CHROME_NO_SANDBOX === "1"
      ? ["--no-sandbox"]
      : []),
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

export function executableCandidates(
  engine: Engine,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const explicit =
    engine === "obscura"
      ? env.JLC_OBSCURA_EXECUTABLE
      : env.JLC_CHROME_EXECUTABLE;
  const names =
    engine === "obscura"
      ? [platform === "win32" ? "obscura.exe" : "obscura"]
      : platform === "win32"
        ? ["chrome.exe", "msedge.exe"]
        : [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
          ];
  const paths = (env.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)
    .flatMap((p) => names.map((n) => join(p, n)));
  const known =
    engine === "obscura"
      ? [
          join(home, ".local", "bin", names[0]),
          join(home, "Library", "Caches", "jlc-cli", "obscura", names[0]),
          join(
            env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
            "jlc-cli",
            "obscura",
            names[0],
          ),
          join(home, ".cache", "jlc-cli", "obscura", names[0]),
          "/opt/homebrew/bin/obscura",
          "/usr/local/bin/obscura",
        ]
      : platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            join(
              home,
              "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ),
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : platform === "win32"
          ? [
              join(
                env.PROGRAMFILES ?? "C:\\Program Files",
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
              join(
                env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
              join(
                env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
            ]
          : [
              "/usr/bin/google-chrome",
              "/usr/bin/chromium",
              "/usr/bin/chromium-browser",
              "/snap/bin/chromium",
            ];
  return [...new Set([...(explicit ? [explicit] : []), ...paths, ...known])];
}

async function executable(config: BrowserConfig): Promise<string> {
  for (const candidate of config.executable
    ? [config.executable]
    : executableCandidates(config.engine)) {
    try {
      await access(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return resolve(candidate);
    } catch {
      /* next */
    }
  }
  throw new BrowserRuntimeError(
    "BROWSER_NOT_INSTALLED",
    `${config.engine} executable was not found. Install the official browser or configure its executable path. Chrome requires explicit engine=chrome selection.`,
  );
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
async function privateJson(file: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(file));
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BrowserRuntimeError(
      "BROWSER_STATE_INVALID",
      "Saved browser state is unreadable; it has been preserved for inspection.",
    );
  }
}
async function bounded<T>(
  operation: Promise<T>,
  timeout: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserRuntimeError(
                code,
                `Browser operation exceeded ${timeout} ms.`,
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function timeoutOf(config: BrowserConfig): number {
  return Number.isFinite(config.timeoutMs) && config.timeoutMs! > 0
    ? Math.min(config.timeoutMs!, 120_000)
    : defaultTimeout;
}
async function jsonFetch(
  url: string,
  timeout: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  if (!response.ok)
    throw new BrowserRuntimeError(
      "CDP_UNAVAILABLE",
      `CDP discovery returned HTTP ${response.status}.`,
    );
  return (await response.json()) as Record<string, unknown>;
}
async function discover(
  endpoint: string,
  timeout: number,
): Promise<{ websocket: string; version: Record<string, unknown> }> {
  const validated = validateEndpoint(endpoint);
  if (validated.startsWith("ws")) return { websocket: validated, version: {} };
  const version = await jsonFetch(`${validated}/json/version`, timeout);
  if (typeof version.webSocketDebuggerUrl !== "string")
    throw new BrowserRuntimeError(
      "CDP_UNAVAILABLE",
      "Browser did not return a CDP WebSocket endpoint.",
    );
  return { websocket: validateEndpoint(version.webSocketDebuggerUrl), version };
}
async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}
async function relayRecordAlive(
  record: RuntimeRecord,
  requireReady = true,
): Promise<boolean> {
  try {
    const data = await jsonFetch(
      `${validateEndpoint(record.endpoint)}/jlc/status`,
      1500,
    );
    return (
      data.instance === record.token && (!requireReady || data.ready === true)
    );
  } catch {
    return false;
  }
}

async function ownedRuntime(
  config: BrowserConfig,
  directory: string,
): Promise<{ record: RuntimeRecord; fresh: boolean }> {
  const file = join(directory, runtimeName);
  const existing = await readJson<RuntimeRecord>(file);
  if (existing && (await relayRecordAlive(existing))) {
    if (
      existing.engine !== config.engine ||
      (config.executable && resolve(config.executable) !== existing.executable)
    )
      throw new BrowserRuntimeError(
        "BROWSER_CONFIG_CHANGED",
        "A retained browser uses another engine or executable. Stop the owned session explicitly before switching.",
      );
    return { record: existing, fresh: !existing.restored };
  }
  const binary = await executable(config);
  const token = randomBytes(24).toString("hex");
  const launchFile = join(directory, `browser-launch-${token}.json`);
  await privateJson(launchFile, {
    config: { ...config, executable: binary },
    directory,
    token,
  });
  const args = [
    ...(moduleFile.endsWith(".ts") ? ["--experimental-strip-types"] : []),
    moduleFile,
    "--jlc-cdp-broker",
    launchFile,
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  let launchError = false;
  child.once("error", () => {
    launchError = true;
  });
  child.unref();
  const deadline = Date.now() + timeoutOf(config);
  try {
    while (Date.now() < deadline && !launchError) {
      const record = await readJson<RuntimeRecord>(file);
      if (record?.token === token && (await relayRecordAlive(record)))
        return { record, fresh: true };
      const error = await readJson<{ code: string; message: string }>(
        `${launchFile}.error`,
      );
      if (error) throw new BrowserRuntimeError(error.code, error.message);
      await wait(100);
    }
    throw new BrowserRuntimeError(
      "BROWSER_START_TIMEOUT",
      "Browser did not expose a usable loopback CDP session before the startup deadline.",
    );
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  } finally {
    await rm(launchFile, { force: true });
    await rm(`${launchFile}.error`, { force: true });
  }
}

async function pageId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Target.getTargetInfo");
    return result.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}
async function restoreState(
  context: BrowserContext,
  state: SavedState,
  engine: Engine,
): Promise<void> {
  if (state.cookies?.length) await context.addCookies(state.cookies);
  if (engine !== "chrome" || !state.origins?.length) return;
  // Restore the explicit snapshot even if an abrupt stop lost Chrome's native
  // LevelDB writes. A temporary intercepted document runs no website scripts
  // and leaves no permanent script that could undo a subsequent logout.
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    await session.send("Network.setBypassServiceWorker", { bypass: true });
    await page.route("**/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        // Browser-initiated favicon requests can bypass page routing. Keep the
        // temporary document entirely local, including its browser UI assets.
        body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>',
      }),
    );
    for (const record of state.origins) {
      let origin: URL;
      try {
        origin = new URL(record.origin);
      } catch {
        continue;
      }
      if (
        !["https:", "http:"].includes(origin.protocol) ||
        origin.origin !== record.origin
      )
        continue;
      await page.goto(record.origin, { waitUntil: "domcontentloaded" });
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const entry of entries)
          localStorage.setItem(entry.name, entry.value);
      }, record.localStorage);
    }
  } finally {
    await session.detach().catch(() => {});
    await page.close().catch(() => {});
  }
}
async function collectState(context: BrowserContext): Promise<SavedState> {
  const origins = new Map<string, SavedState["origins"][number]>();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      try {
        const state = await bounded(
          frame.evaluate(() => ({
            origin: location.origin,
            localStorage: Array.from(
              { length: localStorage.length },
              (_, index) => localStorage.key(index),
            )
              .filter((name): name is string => name !== null)
              .map((name) => ({ name, value: localStorage.getItem(name)! })),
          })),
          3000,
          "STORAGE_READ_TIMEOUT",
        );
        if (/^https?:\/\//.test(state.origin)) origins.set(state.origin, state);
      } catch {
        /* Cross-origin/destroyed documents have no readable storage. */
      }
    }
  }
  return {
    cookies: await bounded(context.cookies(), 5000, "COOKIE_READ_TIMEOUT"),
    origins: [...origins.values()],
  };
}

async function acquireConnectLock(lock: string): Promise<void> {
  const nonce = randomBytes(24).toString("hex");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readJson<{ pid: number; nonce?: string }>(
      join(lock, "owner.json"),
    );
    let exited = false;
    if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
      } catch (probe) {
        exited = (probe as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    if (!exited || !owner?.nonce || !/^[a-f0-9]{48}$/.test(owner.nonce))
      throw new BrowserRuntimeError(
        "BROWSER_BUSY",
        "Browser initialization is locked. An owner without recovery metadata requires inspection before its lock can be removed.",
      );
    // Keep this per-owner election permanently. A contender paused after reading
    // this old owner must never remove a newer owner's lock (the ABA race).
    const recovery = `${lock}.recovery`;
    await privateDirectory(recovery);
    try {
      await mkdir(join(recovery, owner.nonce), { mode: 0o700 });
    } catch (election) {
      if ((election as NodeJS.ErrnoException).code !== "EEXIST") throw election;
      throw new BrowserRuntimeError(
        "BROWSER_BUSY",
        "Another process is recovering this browser initialization lock.",
      );
    }
    const current = await readJson<{ nonce?: string }>(
      join(lock, "owner.json"),
    );
    if (current?.nonce !== owner.nonce)
      throw new BrowserRuntimeError(
        "BROWSER_BUSY",
        "Browser initialization lock ownership changed.",
      );
    await rm(lock, { recursive: true, force: true });
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new BrowserRuntimeError(
        "BROWSER_BUSY",
        "Another browser connection acquired this profile.",
      );
    }
  }
  await privateJson(join(lock, "owner.json"), { pid: process.pid, nonce });
}

function trustedLocalRequest(
  request: IncomingMessage,
  address: string,
): boolean {
  // Empty/opaque Origins count as browser origins too. Host checking also
  // rejects DNS-rebinding names even for requests that omit Origin.
  return (
    request.headers.origin === undefined &&
    request.headers["sec-fetch-site"] === undefined &&
    request.headers.host === new URL(address).host
  );
}

async function connect(
  config: BrowserConfig,
  directory: string,
  targetId?: string,
): Promise<BrowserConnection> {
  directory = resolve(directory);
  await privateDirectory(directory);
  const timeout = timeoutOf(config);
  const lock = join(directory, "browser-connect.lock");
  await acquireConnectLock(lock);
  let browser: Browser | undefined;
  try {
    const owned = config.endpoint
      ? undefined
      : await ownedRuntime(config, directory);
    const endpoint = config.endpoint
      ? validateEndpoint(config.endpoint)
      : owned!.record.endpoint;
    if (config.endpoint && config.engine === "obscura") {
      const relay = await jsonFetch(`${endpoint}/jlc/status`, 1500).catch(
        () => undefined,
      );
      if (!relay || typeof relay.instance !== "string")
        throw new BrowserRuntimeError(
          "OBSCURA_RELAY_REQUIRED",
          "Direct Obscura CDP destroys targets when a client disconnects. Use the retained jlc-cli relay endpoint or let jlc-cli launch Obscura.",
        );
    }
    const { websocket } = await discover(endpoint, timeout);
    try {
      browser = await chromium.connectOverCDP(websocket, { timeout });
    } catch {
      throw new BrowserRuntimeError(
        "CDP_CONNECT_FAILED",
        "Could not acquire the browser CDP connection. A handoff client may still own this session, or the browser has stopped.",
      );
    }
    const context =
      browser.contexts()[0] ??
      (await bounded(browser.newContext(), timeout, "CONTEXT_CREATE_TIMEOUT"));
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    if (owned?.fresh) {
      const state = await readJson<SavedState>(
        join(directory, "browser-storage.json"),
      );
      if (state)
        await bounded(
          restoreState(context, state, config.engine),
          timeout,
          "STORAGE_RESTORE_TIMEOUT",
        );
    }
    let page: Page | undefined;
    const desired = targetId ?? owned?.record.targetId;
    if (desired)
      for (const candidate of context.pages()) {
        if (
          (await bounded(
            pageId(candidate),
            timeout,
            "TARGET_LOOKUP_TIMEOUT",
          )) === desired
        ) {
          page = candidate;
          break;
        }
      }
    if (!page && targetId)
      throw new BrowserRuntimeError(
        "BROWSER_TARGET_GONE",
        "The retained task page no longer exists. Reconcile the business state before creating or repeating operations.",
      );
    page ??=
      context.pages().find((p) => p.url() === "about:blank") ??
      (await bounded(context.newPage(), timeout, "PAGE_CREATE_TIMEOUT"));
    const id = await bounded(pageId(page), timeout, "TARGET_LOOKUP_TIMEOUT");
    if (owned)
      await privateJson(join(directory, runtimeName), {
        ...owned.record,
        restored: true,
        targetId: id,
      });
    const connectedBrowser = browser;
    let disconnected = false;
    return {
      page,
      endpoint,
      targetId: id,
      async save() {
        if (disconnected)
          throw new BrowserRuntimeError(
            "BROWSER_DISCONNECTED",
            "The CDP client is disconnected.",
          );
        const state = await bounded(
          collectState(context),
          timeout,
          "STORAGE_SAVE_TIMEOUT",
        );
        await privateJson(join(directory, "browser-storage.json"), state);
      },
      async disconnect() {
        if (!disconnected) {
          disconnected = true; // connectOverCDP close disconnects its transport, never sends Browser.close.
          await bounded(
            connectedBrowser.close(),
            5000,
            "CDP_DISCONNECT_TIMEOUT",
          );
        }
      },
      async diagnostic(destination) {
        await privateDirectory(destination);
        const result: Record<string, unknown> = {
          endpoint,
          targetId: id,
          url: sanitizeUrl(page!.url()),
          capturedAt: new Date().toISOString(),
          connected: connectedBrowser.isConnected(),
          pageClosed: page!.isClosed(),
        };
        try {
          // A structural snapshot deliberately excludes values, text, hrefs, scripts and page storage.
          const outline = await bounded(
            page!.evaluate(() =>
              Array.from(
                document.querySelectorAll(
                  "main,form,button,input,select,textarea,iframe,dialog,[role]",
                ),
              )
                .slice(0, 300)
                .map((element) => ({
                  tag: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  type:
                    element.tagName === "INPUT"
                      ? element.getAttribute("type")
                      : undefined,
                  disabled: element.hasAttribute("disabled"),
                })),
            ),
            5000,
            "DIAGNOSTIC_TIMEOUT",
          );
          const snapshot = join(
            destination,
            `browser-${randomBytes(5).toString("hex")}.json`,
          );
          await privateJson(snapshot, { ...result, outline });
          result.snapshot = snapshot;
        } catch {
          result.snapshotUnavailable =
            "The live browser did not provide a structural snapshot.";
        }
        result.screenshotUnavailable =
          "Generic diagnostics omit screenshots because pages may contain credentials. Login QR artifacts are captured by the login adapter.";
        return result;
      },
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Stops only a jlc-cli broker proven by its per-instance token; never kills a PID from disk. */
export async function stopOwnedBrowser(directory: string): Promise<boolean> {
  const record = await readJson<RuntimeRecord>(join(directory, runtimeName));
  if (!record || !(await relayRecordAlive(record))) return false;
  const response = await fetch(
    `${validateEndpoint(record.endpoint)}/jlc/stop`,
    {
      method: "POST",
      headers: { "x-jlc-instance": record.token },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new BrowserRuntimeError(
      "BROWSER_STOP_FAILED",
      "The owned browser did not accept the shutdown request.",
    );
  for (let i = 0; i < 50 && (await relayRecordAlive(record, false)); i++)
    await wait(100);
  if (await relayRecordAlive(record, false))
    throw new BrowserRuntimeError(
      "BROWSER_STOP_TIMEOUT",
      "The owned browser has not finished stopping.",
    );
  return true;
}

export const browserProvider: BrowserProvider = {
  connect,
  async doctor(config) {
    const timeout = timeoutOf(config);
    try {
      if (config.endpoint) {
        const endpoint = validateEndpoint(config.endpoint);
        const discovery = await discover(endpoint, timeout);
        return {
          available: true,
          engine: config.engine,
          endpoint,
          protocol: "CDP",
          browser: discovery.version.Browser ?? "unknown",
          scope: "discovery only; business compatibility is not established",
        };
      }
      const path = await executable(config);
      const version = await new Promise<string>((resolveVersion, reject) =>
        execFile(
          path,
          ["--version"],
          { timeout: 5000, maxBuffer: 8192, windowsHide: true },
          (error, stdout) =>
            error ? reject(error) : resolveVersion(stdout.trim().slice(0, 300)),
        ),
      );
      return {
        available: true,
        engine: config.engine,
        executable: path,
        version,
        platform: process.platform,
        arch: process.arch,
        scope: "executable only; business compatibility is not established",
        handoff:
          "Single CDP client; relay preserves the upstream connection across client exits.",
      };
    } catch (error) {
      return {
        available: false,
        engine: config.engine,
        code:
          error instanceof BrowserRuntimeError
            ? error.code
            : "BROWSER_UNAVAILABLE",
        message:
          error instanceof BrowserRuntimeError
            ? error.message
            : "Browser executable or endpoint is not usable.",
      };
    }
  },
};

/** A detached broker owns one upstream connection. Obscura otherwise destroys pages on disconnect. */
async function broker(launchFile: string): Promise<void> {
  const settings = await readJson<{
    config: BrowserConfig;
    directory: string;
    token: string;
  }>(launchFile);
  if (!settings) return;
  const { config, directory, token } = settings;
  let child: ReturnType<typeof spawn> | undefined;
  let upstream: WebSocket | undefined;
  let shuttingDown = false;
  let startupStderr = "";
  let startupBytes = 0;
  let captureStartup = true;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: string | undefined;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const running = () =>
      child?.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null;
    const finish = () =>
      setTimeout(() => process.exit(0), captureStartup ? 1500 : 50).unref();
    if (!running()) {
      upstream?.close();
      finish();
      return;
    }
    child!.once("exit", finish);
    // Only this broker's owned Chrome receives Browser.close. On Windows a
    // SIGTERM is an abrupt termination and cannot flush the native profile.
    if (config.engine === "chrome" && upstream?.readyState === WebSocket.OPEN)
      upstream.send(JSON.stringify({ id: -1, method: "Browser.close" }));
    else {
      upstream?.close();
      child!.kill("SIGTERM");
    }
    setTimeout(() => {
      if (running()) child!.kill("SIGTERM");
    }, 3000).unref();
    setTimeout(() => {
      if (running()) child!.kill("SIGKILL");
      process.exit(0);
    }, 4000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  try {
    const port = await freePort();
    const profile = join(directory, `${config.engine}-profile`);
    await privateDirectory(profile);
    const args =
      config.engine === "obscura"
        ? [
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--storage-dir",
            profile,
            "--quiet",
          ]
        : chromeLaunchArguments(profile, port);
    child = spawn(config.executable!, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        RUST_LOG: "off",
        OBSCURA_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (captureStartup) {
        startupBytes += chunk.length;
        if (startupStderr.length < 16_384)
          startupStderr += chunk
            .toString("utf8")
            .slice(0, 16_384 - startupStderr.length);
      }
    });
    let childFailed = false;
    child.on("error", (error) => {
      childFailed = true;
      spawnError = (error as NodeJS.ErrnoException).code;
    });
    child.on("exit", (code, signal) => {
      childFailed = true;
      exitCode = code;
      exitSignal = signal;
      shutdown();
    });
    const deadline = Date.now() + timeoutOf(config);
    let discovery: Awaited<ReturnType<typeof discover>> | undefined;
    while (Date.now() < deadline && !childFailed) {
      try {
        discovery = await discover(`http://127.0.0.1:${port}`, 1500);
        break;
      } catch {
        await wait(100);
      }
    }
    if (!discovery) {
      const stderr = sanitizeStartupStderr(startupStderr);
      const diagnostic = {
        capturedAt: new Date().toISOString(),
        engine: config.engine,
        platform: process.platform,
        exitCode,
        exitSignal,
        spawnError,
        stderr,
        truncated: startupBytes > 16_384,
        sandboxDisabled: args.includes("--no-sandbox"),
      };
      await privateJson(join(directory, "browser-startup.json"), diagnostic);
      throw new BrowserRuntimeError(
        "BROWSER_START_FAILED",
        `Browser failed to start or expose CDP (exit=${exitCode ?? "unknown"}${exitSignal ? `, signal=${exitSignal}` : ""}${spawnError ? `, spawn=${spawnError}` : ""}).${stderr ? ` Startup stderr: ${stderr}` : " No startup stderr was captured."}`,
      );
    }
    captureStartup = false;
    startupStderr = "";
    upstream = new WebSocket(discovery.websocket, {
      handshakeTimeout: timeoutOf(config),
      maxPayload: 64 * 1024 * 1024,
    });
    const socket = upstream;
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    socket.on("error", shutdown);
    socket.on("close", shutdown);
    let client: WebSocket | undefined;
    let nextId = 1;
    const pending = new Map<
      number,
      { client: WebSocket; original: number; method: string }
    >();
    const sessions = new Map<string, string>();
    const internalPending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    const targets = new Map<string, Record<string, unknown>>();
    const restoreScripts = new Map<string, string>();
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const command = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolveCommand, reject) => {
        const id = nextId++;
        internalPending.set(id, { resolve: resolveCommand, reject });
        send({ id, method, params });
        setTimeout(() => {
          if (internalPending.delete(id))
            reject(new Error("CDP relay command timeout"));
        }, 10_000).unref();
      });
    socket.on("message", (raw) => {
      let message: Record<string, any>;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const internal = internalPending.get(message.id);
        if (internal) {
          internalPending.delete(message.id);
          message.error
            ? internal.reject(new Error("Upstream CDP command failed"))
            : internal.resolve(message.result);
          return;
        }
        const destination = pending.get(message.id);
        pending.delete(message.id);
        if (
          destination &&
          destination.client === client &&
          client.readyState === WebSocket.OPEN
        ) {
          message.id = destination.original;
          client.send(JSON.stringify(message));
        }
        return;
      }
      if (message.method === "Page.frameNavigated") {
        try {
          const origin = new URL(message.params.frame.url).origin;
          const identifier = restoreScripts.get(origin);
          if (identifier) {
            restoreScripts.delete(origin);
            void command("Page.removeScriptToEvaluateOnNewDocument", {
              identifier,
            }).catch(() => {});
          }
        } catch {
          /* Non-web frame. */
        }
      }
      if (message.method === "Target.attachedToTarget") {
        sessions.set(
          message.params.sessionId,
          message.params.targetInfo?.targetId,
        );
        if (message.params.targetInfo)
          targets.set(
            message.params.targetInfo.targetId,
            message.params.targetInfo,
          );
      }
      if (
        message.method === "Target.targetCreated" ||
        message.method === "Target.targetInfoChanged"
      )
        targets.set(
          message.params.targetInfo.targetId,
          message.params.targetInfo,
        );
      if (message.method === "Target.targetDestroyed")
        targets.delete(message.params.targetId);
      if (client?.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(message));
    });
    if (config.engine === "obscura") {
      const saved = await readJson<SavedState>(
        join(directory, "browser-storage.json"),
      );
      for (const origin of saved?.origins ?? []) {
        if (!/^https?:\/\//.test(origin.origin)) continue;
        const source = `(() => { if (location.origin === ${JSON.stringify(origin.origin)}) { for (const entry of ${JSON.stringify(origin.localStorage)}) localStorage.setItem(entry.name, entry.value); } })()`;
        const result = await command("Page.addScriptToEvaluateOnNewDocument", {
          source,
        });
        restoreScripts.set(origin.origin, result.identifier);
      }
    }
    let address = "";
    const http = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (!trustedLocalRequest(request, address)) {
        response.writeHead(403).end("{}");
        return;
      }
      if (request.url === "/jlc/status") {
        response.end(
          JSON.stringify({
            ready: socket.readyState === WebSocket.OPEN,
            instance: token,
            busy: Boolean(client),
          }),
        );
        return;
      }
      if (request.url === "/jlc/stop") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          response.writeHead(405).end("{}");
          return;
        }
        if (request.headers["x-jlc-instance"] !== token) {
          response.writeHead(403).end("{}");
          return;
        }
        response.end("{}");
        shutdown();
        return;
      }
      if (request.url === "/json/version" || request.url === "/json/version/") {
        response.end(
          JSON.stringify({
            ...discovery!.version,
            webSocketDebuggerUrl: `${address.replace("http:", "ws:")}/devtools/browser`,
          }),
        );
        return;
      }
      if (request.url === "/json" || request.url === "/json/list") {
        response.end(
          JSON.stringify(
            [...targets.values()].map((target) => ({
              id: target.targetId,
              type: target.type,
              title: "",
              url: sanitizeUrl(String(target.url ?? "")),
              webSocketDebuggerUrl: `${address.replace("http:", "ws:")}/devtools/browser`,
            })),
          ),
        );
        return;
      }
      response.writeHead(404).end("{}");
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024 * 1024,
    });
    http.on("upgrade", (request, connection, head) => {
      if (!trustedLocalRequest(request, address)) {
        connection.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (
        client ||
        socket.readyState !== WebSocket.OPEN ||
        request.url !== "/devtools/browser"
      ) {
        connection.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, connection, head, (frontend) => {
        client = frontend;
        const autoAttached = new Set<string>();
        frontend.on("error", () => {});
        frontend.on("message", async (raw) => {
          let message: Record<string, any>;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            frontend.close(1007, "Invalid JSON");
            return;
          }
          if (
            typeof message.id !== "number" ||
            typeof message.method !== "string"
          )
            return;
          // Obscura acknowledges autoAttach without attaching existing targets.
          // Supply the missing lifecycle handshake so Playwright can reconnect.
          if (
            config.engine === "obscura" &&
            message.method === "Target.setAutoAttach" &&
            !message.sessionId
          ) {
            try {
              if (message.params?.autoAttach) {
                const result = await command("Target.getTargets");
                for (const target of result.targetInfos ?? [])
                  if (
                    target.type === "page" &&
                    !autoAttached.has(target.targetId)
                  ) {
                    autoAttached.add(target.targetId);
                    await command("Target.attachToTarget", {
                      targetId: target.targetId,
                      flatten: true,
                    });
                  }
              }
              if (frontend.readyState === WebSocket.OPEN)
                frontend.send(JSON.stringify({ id: message.id, result: {} }));
            } catch {
              if (frontend.readyState === WebSocket.OPEN)
                frontend.send(
                  JSON.stringify({
                    id: message.id,
                    error: {
                      code: -32000,
                      message: "Could not restore retained target attachments.",
                    },
                  }),
                );
            }
            return;
          }
          if (message.method === "Browser.close") {
            frontend.send(JSON.stringify({ id: message.id, result: {} }));
            frontend.close();
            return;
          }
          // Obscura getTargetInfo does not infer its target from a flattened session.
          if (
            config.engine === "obscura" &&
            message.method === "Target.getTargetInfo" &&
            message.sessionId &&
            !message.params?.targetId &&
            sessions.has(message.sessionId)
          )
            message.params = {
              ...message.params,
              targetId: sessions.get(message.sessionId),
            };
          const id = nextId++;
          pending.set(id, {
            client: frontend,
            original: message.id,
            method: message.method,
          });
          message.id = id;
          send(message);
        });
        frontend.on("close", () => {
          if (client !== frontend) return;
          client = undefined;
          for (const [id, item] of pending)
            if (item.client === frontend) pending.delete(id);
          // Detach client sessions, preserving targets and the upstream V8 process.
          send({
            id: nextId++,
            method: "Target.setAutoAttach",
            params: {
              autoAttach: false,
              waitForDebuggerOnStart: false,
              flatten: true,
            },
          });
          for (const sessionId of sessions.keys())
            send({
              id: nextId++,
              method: "Target.detachFromTarget",
              params: { sessionId },
            });
          sessions.clear();
        });
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      http.once("error", reject);
      http.listen(config.port ?? 0, "127.0.0.1", resolveListen);
    });
    const relayPort = (http.address() as { port: number }).port;
    address = `http://127.0.0.1:${relayPort}`;
    await privateJson(join(directory, runtimeName), {
      version: 1,
      engine: config.engine,
      endpoint: address,
      token,
      pid: process.pid,
      executable: config.executable!,
    } satisfies RuntimeRecord);
  } catch (error) {
    await privateJson(`${launchFile}.error`, {
      code:
        error instanceof BrowserRuntimeError
          ? error.code
          : "BROWSER_START_FAILED",
      message:
        error instanceof BrowserRuntimeError
          ? error.message
          : "Owned browser broker failed to start.",
    }).catch(() => {});
    shutdown();
  }
}

if (process.argv[2] === "--jlc-cdp-broker" && process.argv[3])
  void broker(process.argv[3]);
