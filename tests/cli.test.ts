import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const execFile = promisify(execFileCallback);
const cli = join(process.cwd(), "dist", "cli.js");
let home: string;
beforeAll(async () => {
  await execFile(process.execPath, [
    join(process.cwd(), "node_modules/typescript/bin/tsc"),
  ]);
}, 30000);
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fabrelay-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
async function run(...args: string[]) {
  try {
    const result = await execFile(process.execPath, [
      cli,
      "--json",
      "--home",
      home,
      ...args,
    ]);
    return { code: 0, value: JSON.parse(result.stdout), raw: result.stdout };
  } catch (error) {
    const e = error as any;
    return { code: e.code, value: JSON.parse(e.stdout), raw: e.stdout };
  }
}
describe("installed-command contract", () => {
  it("exposes the renamed command and the packaged version", async () => {
    const help = await execFile(process.execPath, [cli, "--help"]);
    expect(help.stdout).toContain("Usage: fabrelay");
    const version = await execFile(process.execPath, [cli, "--version"]);
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    );
    expect(version.stdout.trim()).toBe(pkg.version);
    expect(pkg.name).toBe("fabrelay");
    expect(pkg.bin).toEqual({ fabrelay: "dist/cli.js" });
  });
  it("does not authorize initialization from a noninteractive process without explicit consent", async () => {
    const result = await run("init");
    expect(result.code).toBe(4);
    expect(result.value.status).toBe("needs_confirmation");
    expect(result.value.data.scope).toContain("每笔付款都须由人类确认");
  });
  it("rejects endpoint credentials before writing a config or printing them", async () => {
    const result = await run(
      "browser",
      "configure",
      "--endpoint",
      "http://example-user:example-secret@127.0.0.1:9222",
    );
    expect(result.code).toBe(1);
    expect(result.raw).not.toContain("example-secret");
    expect(result.raw).not.toContain("example-user");
    await expect(
      readFile(join(home, "profiles/default/config.json")),
    ).rejects.toThrow();
  });
  it("can clear an external endpoint to return to an owned browser", async () => {
    expect(
      (
        await run(
          "browser",
          "configure",
          "--engine",
          "chrome",
          "--endpoint",
          "http://127.0.0.1:9222",
        )
      ).code,
    ).toBe(0);
    const changed = await run(
      "browser",
      "configure",
      "--engine",
      "obscura",
      "--clear-endpoint",
    );
    expect(changed.code).toBe(0);
    expect(changed.value.data.browser.endpoint).toBeUndefined();
  });
  it("refuses missing files before connecting to the browser", async () => {
    const result = await run("pcb", "upload", join(home, "missing.zip"));
    expect(result.code).toBe(1);
    expect(result.value.error.code).toBe("FILE_NOT_FOUND");
  });
  it("installs the packaged Skill and preserves an existing destination", async () => {
    const destination = join(home, "skills");
    expect((await run("skill", "install", "--to", destination)).code).toBe(0);
    expect(
      await readFile(join(destination, "fabrelay/SKILL.md"), "utf8"),
    ).toContain("name: fabrelay");
    const repeat = await run("skill", "install", "--to", destination);
    expect(repeat.code).toBe(1);
    expect(repeat.value.error.code).toBe("DESTINATION_EXISTS");
  });
});
