import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultStateHome, State } from "../src/state.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jlc-cli-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("state continuity after the jlc-cli rename", () => {
  it("uses the new default for a fresh installation", () => {
    expect(defaultStateHome({}, home)).toBe(join(home, ".jlc-cli"));
  });

  it("reuses legacy tasks and consent in place without creating another profile", async () => {
    const legacy = join(home, ".fabrelay");
    const profile = join(legacy, "profiles", "default");
    await mkdir(join(profile, "tasks"), { recursive: true });
    const config = {
      version: 1,
      browser: { engine: "chrome", endpoint: "http://127.0.0.1:9222" },
      consent: { at: "2026-09-21T00:00:00Z", confirmedBy: "test", version: 1 },
    };
    await writeFile(join(profile, "config.json"), JSON.stringify(config));
    await writeFile(
      join(profile, "tasks", "retained.json"),
      JSON.stringify({
        id: "retained",
        targetId: "original-target",
        status: "needs_input",
      }),
    );
    const state = new State(defaultStateHome({}, home));
    expect(state.directory).toBe(profile);
    expect(await state.requireConsent()).toEqual(config);
    expect((await state.task("retained")).targetId).toBe("original-target");
    expect(existsSync(join(home, ".jlc-cli"))).toBe(false);
  });

  it("prefers the new directory when both exist without modifying the old one", async () => {
    await mkdir(join(home, ".jlc-cli"));
    await mkdir(join(home, ".fabrelay"));
    expect(defaultStateHome({}, home)).toBe(join(home, ".jlc-cli"));
    expect(existsSync(join(home, ".fabrelay"))).toBe(true);
  });

  it("honors the new environment variable ahead of legacy configuration", () => {
    const current = join(home, "current");
    const legacy = join(home, "legacy");
    expect(
      defaultStateHome({ JLC_HOME: current, FABRELAY_HOME: legacy }, home),
    ).toBe(current);
    expect(defaultStateHome({ FABRELAY_HOME: legacy }, home)).toBe(legacy);
    expect(new State(join(home, "explicit")).directory).toBe(
      join(home, "explicit", "profiles", "default"),
    );
  });
});
