import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { browserProvider } from "../src/browser.js";

const config = {
  engine: "chrome" as const,
  endpoint: "ws://127.0.0.1:9222/devtools/browser",
  timeoutMs: 2000,
};
let directory: string;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function browserFixture(
  targetId: string,
  navigate: (url: string) => Promise<null>,
  existing = false,
) {
  const goto = vi.fn(navigate);
  const waitForLoadState = vi.fn();
  const session = {
    send: vi.fn(async () => ({ targetInfo: { targetId } })),
    detach: vi.fn(async () => {}),
  };
  const page = {
    goto,
    waitForLoadState,
    context: () => context,
  } as unknown as Page;
  const newPage = vi.fn(async () => page);
  const context = {
    pages: () => (existing ? [page] : []),
    newPage,
    newCDPSession: vi.fn(async () => session),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  } as unknown as BrowserContext;
  const close = vi.fn(async () => {});
  const browser = {
    contexts: () => [context],
    close,
  } as unknown as Browser;
  return { browser, page, goto, waitForLoadState, newPage, close };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jlc-browser-readiness-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("CDP page readiness contracts", () => {
  it("returns a new page only after its inert document loads, ready for one business navigation", async () => {
    const initializationStarted = deferred();
    const initialLoad = deferred();
    let ready = false;
    const fixture = browserFixture("new-target", async (url) => {
      if (url.startsWith("data:text/html,")) {
        initializationStarted.resolve();
        await initialLoad.promise;
        ready = true;
      } else if (!ready) {
        throw new Error(
          "Business navigation interrupted by startup navigation",
        );
      }
      return null;
    });
    vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(fixture.browser);
    let returned = false;
    const pending = browserProvider
      .connect(config, directory)
      .then((result) => {
        returned = true;
        return result;
      });
    try {
      const first = await Promise.race([
        initializationStarted.promise.then(() => "initializing"),
        pending.then(() => "returned"),
      ]);
      expect(first).toBe("initializing");
      expect(returned).toBe(false);
      expect(ready).toBe(false);
      expect(fixture.goto).toHaveBeenCalledExactlyOnceWith(
        "data:text/html,<title>jlc-cli ready</title>",
        {
          waitUntil: "load",
          timeout: config.timeoutMs,
        },
      );

      initialLoad.resolve();
      const connection = await pending;
      expect(connection.page).toBe(fixture.page);
      expect(connection.targetId).toBe("new-target");
      expect(fixture.newPage).toHaveBeenCalledTimes(1);
      await connection.page.goto("https://business-fixture.invalid/");
      expect(fixture.goto.mock.calls.map(([url]) => url)).toEqual([
        "data:text/html,<title>jlc-cli ready</title>",
        "about:blank",
        "https://business-fixture.invalid/",
      ]);
    } finally {
      initialLoad.resolve();
      const connection = await pending.catch(() => undefined);
      await connection?.disconnect();
    }
  });

  it("preserves an existing target without navigating it or waiting for its ongoing load", async () => {
    const fixture = browserFixture(
      "retained-target",
      async () => {
        throw new Error("The retained document must remain untouched");
      },
      true,
    );
    // An unrelated ongoing load must not delay reconnection to a retained task.
    fixture.waitForLoadState.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(fixture.browser);
    const connection = await browserProvider.connect(
      config,
      directory,
      "retained-target",
    );
    try {
      expect(connection.page).toBe(fixture.page);
      expect(connection.targetId).toBe("retained-target");
      expect(fixture.newPage).not.toHaveBeenCalled();
      expect(fixture.goto).not.toHaveBeenCalled();
      expect(fixture.waitForLoadState).not.toHaveBeenCalled();
    } finally {
      await connection.disconnect();
    }
  });

  it("closes CDP and releases the profile lock when a new page cannot initialize", async () => {
    const failure = new Error("Initial document did not finish loading");
    failure.name = "TimeoutError";
    const fixture = browserFixture("unready-target", async () => {
      throw failure;
    });
    const connect = vi
      .spyOn(chromium, "connectOverCDP")
      .mockResolvedValue(fixture.browser);
    await expect(browserProvider.connect(config, directory)).rejects.toBe(
      failure,
    );
    expect(fixture.goto).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, "browser-connect.lock"))).toBe(false);

    const fresh = browserFixture("replacement-target", async () => null);
    connect.mockResolvedValue(fresh.browser);
    const replacement = await browserProvider.connect(config, directory);
    try {
      expect(replacement.page).toBe(fresh.page);
      expect(replacement.targetId).toBe("replacement-target");
    } finally {
      await replacement.disconnect();
    }
  });

  it("preserves the initialization error and releases the lock after a stalled CDP close reaches its deadline", async () => {
    const failure = new Error("Initial document did not finish loading");
    failure.name = "TimeoutError";
    const closeStarted = deferred();
    const fixture = browserFixture("unready-target", async () => {
      throw failure;
    });
    fixture.close.mockImplementation(async () => {
      closeStarted.resolve();
      await new Promise<void>(() => {});
    });
    vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(fixture.browser);
    vi.useFakeTimers();
    let settled = false;
    const outcome = browserProvider.connect(config, directory).then(
      (connection) => {
        settled = true;
        return { connection };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );

    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    expect(existsSync(join(directory, "browser-connect.lock"))).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ error: failure });
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, "browser-connect.lock"))).toBe(false);
  });
});
