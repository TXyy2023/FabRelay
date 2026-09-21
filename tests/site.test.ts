import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverParameters, siteAdapter } from "../src/site.js";
import type { AdapterContext } from "../src/contracts.js";
let browser: Browser;
let browserContext: BrowserContext;
let page: Page;
let artifactDir: string;
let effects: { kind: string; binding: Record<string, unknown> }[];
// These fixtures verify business outcomes, not sub-second browser performance.
// Keep the action budget bounded but allow shared CI runners to become ready.
const browserStepTimeout = 5000;
const suiteName = "JLC DOM adapter local fixtures (not real-site acceptance)";
function context(
  input: Record<string, unknown> = {},
  previous?: Record<string, unknown>,
): AdapterContext {
  return {
    taskId: "fixture-task",
    timeoutMs: browserStepTimeout,
    artifactDir,
    input,
    previous,
    beforeEffect: async (kind, binding) => {
      effects.push({ kind, binding });
    },
  };
}
async function fixture(html: string) {
  await page.route("https://www.jlc.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto("https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder");
}
const account = "<header>客编 TEST123A</header>";
const upload = {
  taskId: "upload-fixture",
  fileName: "board.zip",
  uploadName: "fabrelay-upload-fixture-board.zip",
  sha256: "1234",
  size: 20,
  uploadedAt: "2026-01-01T00:00:00Z",
  formPageIdentity: "https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder",
};
const binding = {
  account: "TEST123A",
  orderId: "Y1234",
  amount: "12.30",
  currency: "CNY",
  method: "balance",
};
beforeAll(async () => {
  const chrome =
    process.env.FABRELAY_TEST_BROWSER === "chromium"
      ? chromium.executablePath()
      : (process.env.FABRELAY_TEST_CHROME ??
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined));
  browser = await chromium.launch({
    headless: true,
    ...(chrome && existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  artifactDir = await mkdtemp(join(tmpdir(), "jlc-site-tests-"));
}, 30000);
beforeEach(async () => {
  if (browserContext) await browserContext.close();
  browserContext = await browser.newContext();
  await browserContext.route("https://member.jlc.com/**", (r) =>
    r.fulfill({ contentType: "text/html; charset=utf-8", body: account }),
  );
  page = await browserContext.newPage();
  effects = [];
});
afterAll(async () => {
  await browser?.close();
  await rm(artifactDir, { recursive: true, force: true });
});
// Login includes several separate bounded reads, so its total deadline must
// exceed one browser action. No retry can turn a failed assertion into a pass.
describe(suiteName, { timeout: 20000, retry: 0 }, () => {
  it("discovers native controls, JLC named choices and currently disabled options", async () => {
    await fixture(
      `<main id="leftcontent"><div><label>板子层数</label><button name="板子层数" class="checked">2</button><button name="板子层数">4</button><button name="板子层数" disabled>8</button></div><div><label for="quantity">数量</label><input id="quantity" type="number" required min="5" value="5"></div><div><label for="finish">喷镀</label><select id="finish"><option value="hasl">有铅喷锡</option><option value="enig">沉金</option></select></div></main>`,
    );
    const params = await discoverParameters(page);
    expect(params.map((p) => p.key)).toEqual(["板子层数", "数量", "喷镀"]);
    expect(params[0].value).toBe("2");
    expect(params[0].choices[2].disabled).toBe(true);
    expect(params[1].constraints.min).toBe("5");
    expect(params[1].required).toBe(true);
    expect(params[2].choices[1].value).toBe("enig");
  });
  it("sets exact requested choices and discovers conditional fields", async () => {
    await fixture(
      `<div id="leftcontent"><div><label>层数</label><button name="层数" class="checked">2</button><button name="层数" onclick="this.previousElementSibling.classList.remove('checked');this.classList.add('checked');document.getElementById('conditional').hidden=false">4</button></div><div id="conditional" hidden><label for="stack">叠层</label><select id="stack"><option>标准</option><option>自定义</option></select></div></div>`,
    );
    const result = await siteAdapter.run(
      "pcb.set",
      page,
      context({ params: { 层数: "4" } }),
    );
    expect(result.status, JSON.stringify(result)).toBe("succeeded");
    expect(result.data.conditionalFields).toEqual(["叠层"]);
    expect(result.data.quote).toBe(null);
    expect(effects).toEqual([]);
  });
  it("waits for a delayed parameter control and applies the choice exactly once", async () => {
    await fixture(
      `<div id="leftcontent"><label>层数</label><button name="层数" class="checked">2</button><button name="层数" onclick="window.clicks=(window.clicks||0)+1;this.previousElementSibling.classList.remove('checked');this.classList.add('checked')">4</button></div><div id="loading" style="position:fixed;inset:0;z-index:9999"></div>`,
    );
    // Start the delay after navigation, with the hit target still blocked.
    await page.locator("#loading").evaluate((overlay) => {
      setTimeout(() => overlay.remove(), 1500);
    });
    const result = await siteAdapter.run(
      "pcb.set",
      page,
      context({ params: { 层数: "4" } }),
    );
    expect(result.status, JSON.stringify(result)).toBe("succeeded");
    expect((result.data.decisions as any)["层数"].value).toBe("4");
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
    expect(effects).toEqual([]);
  });
  it("hands off a permanently blocked parameter control without clicking it", async () => {
    await fixture(
      `<div id="leftcontent"><label>层数</label><button name="层数" class="checked">2</button><button name="层数" onclick="window.clicks=(window.clicks||0)+1;this.classList.add('checked')">4</button></div><div style="position:fixed;inset:0;z-index:9999"></div>`,
    );
    const result = await siteAdapter.run("pcb.set", page, {
      ...context({ params: { 层数: "4" } }),
      timeoutMs: 100,
    });
    expect(result).toMatchObject({
      status: "handoff",
      error: { code: "PAGE_OPERATION_INTERRUPTED" },
      data: { cause: "TimeoutError" },
    });
    expect(await page.evaluate(() => (window as any).clicks ?? 0)).toBe(0);
    expect((await discoverParameters(page))[0].value).toBe("2");
    expect(effects).toEqual([]);
  });
  it("reports dependencies that silently reset previously confirmed selections", async () => {
    await fixture(
      `<div id="leftcontent"><div><label>层数</label><button name="层数" class="checked">2</button><button name="层数" onclick="this.previousElementSibling.classList.remove('checked');this.classList.add('checked');document.querySelector('#color').value='绿'">4</button></div><label for="color">颜色</label><select id="color"><option>绿</option><option selected>蓝</option></select></div>`,
    );
    const result = await siteAdapter.run(
      "pcb.set",
      page,
      context(
        { params: { 层数: "4" } },
        { decisions: { 颜色: { value: "蓝", source: "user" } } },
      ),
    );
    expect(result.status).toBe("needs_input");
    expect(result.error?.code).toBe("PARAMETER_CONFLICT");
  });
  it("does not treat site defaults as user decisions or quote without file binding", async () => {
    await fixture(
      `<div id="leftcontent"><label for="quantity">数量</label><input id="quantity" value="5"></div><aside id="rightcontent">总价 ￥12.30</aside>`,
    );
    const result = await siteAdapter.run(
      "pcb.quote",
      page,
      context({}, { upload }),
    );
    expect(result.error?.code).toBe("PARAMETER_DECISIONS_REQUIRED");
    expect(effects).toEqual([]);
  });
  it("rejects automatic debit before order submission", async () => {
    await fixture(
      `${account}<div id="leftcontent"><div><label>确认订单方式</label><button name="确认订单方式" class="checked">系统自动扣款并确认</button><button name="确认订单方式">手动确认订单</button></div></div><aside id="rightcontent">总价 ￥12.30</aside><button id="submitBtn" onclick="window.submitted=true">提交订单</button>`,
    );
    const result = await siteAdapter.run(
      "pcb.submit",
      page,
      context(
        {},
        {
          upload,
          decisions: { 确认订单方式: { value: "系统自动扣款并确认" } },
        },
      ),
    );
    expect(result.error?.code).toBe("AUTOMATIC_DEBIT_NOT_ALLOWED");
    expect(await page.evaluate(() => Boolean((window as any).submitted))).toBe(
      false,
    );
    expect(effects).toEqual([]);
  });
  it("prepares a binding only from one explicit order, amount and selected balance method", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.30</p><label><input type="radio" checked>余额支付</label><button>确认支付</button></div>`,
    );
    const result = await siteAdapter.run(
      "payment.prepare",
      page,
      context({ orderId: "Y1234" }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.binding).toEqual(binding);
    expect(effects).toEqual([]);
  });
  it("rejects a changed confirmed amount without invoking payment callback", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.31</p><label><input type="radio" checked>余额支付</label><button onclick="window.paid=true">确认支付</button></div>`,
    );
    const result = await siteAdapter.run(
      "payment.execute",
      page,
      context({ orderId: "Y1234" }, { binding }),
    );
    expect(result.error?.code).toBe("PAYMENT_BINDING_CHANGED");
    expect(await page.evaluate(() => Boolean((window as any).paid))).toBe(
      false,
    );
    expect(effects).toEqual([]);
  });
  it("records payment intent before clicking and verifies exact order success", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.30</p><label><input type="radio" checked>余额支付</label><button onclick="this.parentElement.innerHTML='订单编号：Y1234 <p role=status>支付成功</p> 余额支付 ￥12.30'">确认支付</button></div>`,
    );
    const ctx = context({ orderId: "Y1234" }, { binding });
    ctx.beforeEffect = async (kind, b) => {
      expect(await page.getByRole("button", { name: "确认支付" }).count()).toBe(
        1,
      );
      effects.push({ kind, binding: b });
    };
    const result = await siteAdapter.run("payment.execute", page, ctx);
    expect(effects).toEqual([{ kind: "pay", binding }]);
    expect(result.status).toBe("succeeded");
    expect(result.data.paymentStatus).toBe("paid");
    expect(result.data.orderId).toBe("Y1234");
  });
  it("never counts unrelated payment success and reconcile never clicks again", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y9999 支付成功 余额支付 ￥12.30</div><button onclick="window.paid=true">确认支付</button>`,
    );
    const result = await siteAdapter.reconcile(
      "payment.execute",
      page,
      context({ orderId: "Y1234" }, { binding }),
    );
    expect(result.status).toBe("unknown");
    expect(await page.evaluate(() => Boolean((window as any).paid))).toBe(
      false,
    );
    expect(effects).toEqual([]);
  });
  it("returns unknown after a payment closes without success evidence", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.30</p><label><input type="radio" checked>余额支付</label><button onclick="this.parentElement.remove()">确认支付</button></div>`,
    );
    const result = await siteAdapter.run(
      "payment.execute",
      page,
      context({ orderId: "Y1234" }, { binding }),
    );
    expect(result.status).toBe("unknown");
    expect(effects).toHaveLength(1);
  });
  it.each([
    "支付成功后开始审核",
    "付款成功后开始审核",
    "支付成功<br>后开始审核",
    "未付款 应付金额：￥12.30 余额支付 支付成功后开始审核",
  ])(
    "does not treat future payment instructions as a paid result before any effect: %s",
    async (description) => {
      await fixture(
        `${account}<div role="dialog">订单编号：Y1234 <p>${description}</p></div><button onclick="window.paid=true">确认支付</button>`,
      );
      const result = await siteAdapter.reconcile("payment.execute", page, {
        ...context({ orderId: "Y1234" }, { binding }),
        effectStarted: false,
      });
      expect(result.status).toBe("unknown");
      expect(result.data.paymentStatus).toBe("unknown");
      expect(result.resume).toBeUndefined();
      expect(await page.evaluate(() => Boolean((window as any).paid))).toBe(
        false,
      );
      expect(effects).toEqual([]);
    },
  );
  it.each(["未付款", "支付失败", "付款失败"])(
    "rejects a same-order success state contradicted by %s",
    async (negative) => {
      await fixture(
        `${account}<div role="dialog">订单编号：Y1234 <p role="status">支付成功</p><p>${negative}</p><p>余额支付 ￥12.30</p></div>`,
      );
      const result = await siteAdapter.reconcile("payment.execute", page, {
        ...context({ orderId: "Y1234" }, { binding }),
        effectStarted: false,
      });
      expect(result.status).toBe("unknown");
      expect(result.resume).toBeUndefined();
      expect(effects).toEqual([]);
    },
  );
  it("rejects a paid row when the current same-order dialog still says unpaid", async () => {
    await fixture(
      `${account}<div class="tableListBox">订单编号：Y1234<p>已支付</p><p>￥12.30</p></div><div role="dialog">订单编号：Y1234<p>未付款</p><p>应付金额：￥12.30</p></div>`,
    );
    const result = await siteAdapter.reconcile("payment.execute", page, {
      ...context({ orderId: "Y1234" }, { binding }),
      effectStarted: false,
    });
    expect(result.status).toBe("unknown");
    expect(result.resume).toBeUndefined();
    expect(effects).toEqual([]);
  });
  it.each(["支付成功", "付款状态：已付款"])(
    "accepts an independent bound payment status without replaying: %s",
    async (status) => {
      await fixture(
        `${account}<div role="dialog">订单编号：Y1234 <p role="status">${status}</p><p>余额支付 ￥12.30</p></div>`,
      );
      const result = await siteAdapter.reconcile("payment.execute", page, {
        ...context({ orderId: "Y1234" }, { binding }),
        effectStarted: false,
      });
      expect(result.status).toBe("succeeded");
      expect(result.data.paymentStatus).toBe("paid");
      expect(result.data.orderId).toBe(binding.orderId);
      expect(result.data.amount).toBe(binding.amount);
      expect(result.resume).toBeUndefined();
      expect(effects).toEqual([]);
    },
  );
  it("reads passport iframe methods and does not mislabel missing QR as a QR artifact", async () => {
    await page.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<p>客编 未设置归属</p><iframe src="https://passport.jlc.com/window/login"></iframe>',
      }),
    );
    await page.route("https://passport.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<button>扫码登录</button><button>账号登录</button><button>手机号登录</button><input type="checkbox">下次自动登录',
      }),
    );
    await page.goto("https://member.jlc.com/");
    const result = await siteAdapter.run(
      "auth.login",
      page,
      context({ method: "qr" }),
    );
    expect(result.error?.code).toBe("QR_UNAVAILABLE");
    expect(result.data.qr).toBe(null);
    expect(result.data.availableMethods).toEqual(["qr", "password", "sms"]);
  });
  it("reconcile of submit cannot click a submit button or assume a previous order is this task", async () => {
    await fixture(
      `${account}<div class="tableListBox">订单编号：Y1234 未支付 另一个文件 ￥12.30</div><button id="submitBtn" onclick="window.submitted=true">提交订单</button>`,
    );
    const result = await siteAdapter.reconcile(
      "pcb.submit",
      page,
      context({}, { upload }),
    );
    expect(result.status).toBe("unknown");
    expect(await page.evaluate(() => Boolean((window as any).submitted))).toBe(
      false,
    );
    expect(effects).toEqual([]);
  });
  it("requires parse success in the exact upload row, not just an order button", async () => {
    await fixture(
      `${account}<table><tr><td>fabrelay-upload-fixture-board</td><td><i title="处理失败"></i></td><td>立即下单</td></tr></table>`,
    );
    const result = await siteAdapter.reconcile(
      "pcb.upload",
      page,
      context({}, { upload }),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("FILE_PARSE_FAILED");
  });
  it("keeps login reconciliation pending without a confirmed account", async () => {
    await fixture("<p>客户中心</p><button>扫码登录</button>");
    const result = await siteAdapter.reconcile("auth.login", page, context());
    expect(result.status).toBe("handoff");
    expect(result.data.authenticated).toBe(false);
  });
  it("rejects unsupported order pagination instead of silently ignoring it", async () => {
    await fixture(account);
    const result = await siteAdapter.run(
      "orders.list",
      page,
      context({ page: 3, status: "待付款" }),
    );
    expect(result.error?.code).toBe("ORDER_FILTER_NOT_SUPPORTED");
  });

  it("rejects a stale account header when the login iframe is visible", async () => {
    await page.route("https://passport.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<button>账号登录</button><input type="password">',
      }),
    );
    await fixture(
      `${account}<iframe src="https://passport.jlc.com/window/login"></iframe>`,
    );
    const result = await siteAdapter.reconcile("auth.login", page, context());
    expect(result.status).toBe("handoff");
    expect(result.data.authenticated).toBe(false);
  });

  it("invalidates file context when a different form navigation is visible", async () => {
    await fixture(
      '<div id="leftcontent"><label for="quantity">数量</label><input id="quantity" value="5"></div>',
    );
    const result = await siteAdapter.run(
      "pcb.quote",
      page,
      context(
        {},
        {
          upload: {
            ...upload,
            formPageIdentity:
              "https://www.jlc.com/newOrder/?radomId=0.123#/pcb/pcbPlaceOrder",
          },
        },
      ),
    );
    expect(result.error?.code).toBe("FILE_CONTEXT_CHANGED");
    expect(result.data.quote).toBe(null);
  });

  it("resumes pre-effect payment only when every confirmed binding field still matches", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.30</p><label><input type="radio" checked>余额支付</label><button onclick="window.paid=true">确认支付</button></div>`,
    );
    const ctx = {
      ...context({ orderId: "Y1234" }, { binding }),
      effectStarted: false,
    };
    const result = await siteAdapter.reconcile("payment.execute", page, ctx);
    expect(result.resume).toBe(true);
    expect(effects).toEqual([]);
    expect(await page.evaluate(() => Boolean((window as any).paid))).toBe(
      false,
    );
    await page
      .locator("p")
      .evaluate((p) => (p.textContent = "应付金额：￥12.31"));
    const changed = await siteAdapter.reconcile("payment.execute", page, ctx);
    expect(changed.resume).toBeUndefined();
    expect(changed.error?.code).toBe("PAYMENT_BINDING_CHANGED");
  });

  it("never resumes payment after the side-effect boundary has started", async () => {
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.30</p><label><input type="radio" checked>余额支付</label><button onclick="window.paid=true">确认支付</button></div>`,
    );
    const result = await siteAdapter.reconcile("payment.execute", page, {
      ...context({ orderId: "Y1234" }, { binding }),
      effectStarted: true,
    });
    expect(result.resume).toBeUndefined();
    expect(result.status).toBe("unknown");
    expect(effects).toEqual([]);
    expect(await page.evaluate(() => Boolean((window as any).paid))).toBe(
      false,
    );
  });

  it("rejects account changes even when the payment task page still shows the old header", async () => {
    await browserContext.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "客编 OTHER456",
      }),
    );
    await fixture(
      `${account}<div role="dialog">订单编号：Y1234 <p>应付金额：￥12.30</p><label><input type="radio" checked>余额支付</label><button>确认支付</button></div>`,
    );
    const result = await siteAdapter.reconcile("payment.execute", page, {
      ...context({ orderId: "Y1234" }, { binding }),
      effectStarted: false,
    });
    expect(result.error?.code).toBe("PAYMENT_BINDING_CHANGED");
    expect(result.resume).toBeUndefined();
    expect(effects).toEqual([]);
  });

  it("resumes a pre-effect submit only with the same account, file, explicit choices and original quote", async () => {
    await fixture(
      `${account}<div id="leftcontent"><div><label>确认订单方式</label><button name="确认订单方式" class="checked">手动确认订单</button><button name="确认订单方式">系统自动扣款并确认</button></div></div><aside id="rightcontent">总价 ￥12.30</aside><button id="submitBtn" onclick="window.submitted=true">提交订单</button>`,
    );
    const quoted = await siteAdapter.run(
      "pcb.quote",
      page,
      context(
        {},
        {
          account: "TEST123A",
          upload,
          decisions: { 确认订单方式: { value: "手动确认订单" } },
        },
      ),
    );
    expect(quoted.status).toBe("succeeded");
    const ctx = {
      ...context({}, { ...quoted.data, account: "TEST123A" }),
      effectStarted: false,
    };
    const result = await siteAdapter.reconcile("pcb.submit", page, ctx);
    expect(result.resume).toBe(true);
    expect(effects).toEqual([]);
    expect(await page.evaluate(() => Boolean((window as any).submitted))).toBe(
      false,
    );
    await page
      .locator("#rightcontent")
      .evaluate((p) => (p.textContent = "总价 ￥12.31"));
    const changed = await siteAdapter.reconcile("pcb.submit", page, ctx);
    expect(changed.error?.code).toBe("QUOTE_CHANGED");
    expect(changed.resume).toBeUndefined();
    expect(changed.data.quote).toBe(null);
    const started = await siteAdapter.reconcile("pcb.submit", page, {
      ...ctx,
      effectStarted: true,
    });
    expect(started.status).toBe("unknown");
    expect(started.resume).toBeUndefined();
  });

  it("reuses the order-check drawer and commits only through its enabled confirmation button", async () => {
    await fixture(
      `${account}<div id="leftcontent"><label>确认订单方式<button name="确认订单方式" class="checked">手动确认订单</button></label></div><aside id="rightcontent">总价 ￥12.30</aside><button onclick="window.checkClicks=(window.checkClicks||0)+1;document.querySelector('#review').hidden=false">检查订单</button><button id="submitBtn" onclick="window.wrongButton=true">提交订单</button><div id="review" class="el-drawer" hidden style="position:fixed;inset:0;background:white;z-index:100"><h2>订单检查</h2><button id="confirm" onclick="window.confirmed=(window.confirmed||0)+1">确认并提交</button></div>`,
    );
    // Quote verification requires one full second of stable pricing. Give this
    // multi-step browser fixture headroom for slower hosted Windows runners.
    const flowContext = (previous: Record<string, unknown>) => ({
      ...context({}, previous),
      timeoutMs: 5000,
    });
    const checked = await siteAdapter.run(
      "pcb.check",
      page,
      flowContext({
        upload,
        decisions: { 确认订单方式: { value: "手动确认订单" } },
      }),
    );
    expect(checked, JSON.stringify(checked)).toMatchObject({
      status: "succeeded",
    });
    await page
      .locator("#confirm")
      .evaluate((button) => ((button as HTMLButtonElement).disabled = true));
    const paused = await siteAdapter.reconcile("pcb.submit", page, {
      ...flowContext(checked.data),
      effectStarted: false,
    });
    expect(paused.error?.code).toBe("SUBMIT_UNAVAILABLE");
    expect(effects).toEqual([]);
    await page
      .locator("#confirm")
      .evaluate((button) => ((button as HTMLButtonElement).disabled = false));
    const submitted = await siteAdapter.run(
      "pcb.submit",
      page,
      flowContext(checked.data),
    );
    // The fixture intentionally supplies no backend order receipt.
    expect(submitted.status).toBe("unknown");
    expect(effects).toHaveLength(1);
    expect(effects[0].kind).toBe("submit");
    expect(
      await page.evaluate(() => ({
        checked: (window as any).checkClicks,
        confirmed: (window as any).confirmed,
        wrong: !!(window as any).wrongButton,
      })),
    ).toEqual({ checked: 1, confirmed: 1, wrong: false });
  }, 30000);

  it("does not resume submit from an identical-looking form with a different file identity", async () => {
    await fixture(
      `${account}<div id="leftcontent">参数页面</div><button id="submitBtn">提交订单</button>`,
    );
    const result = await siteAdapter.reconcile("pcb.submit", page, {
      ...context(
        {},
        {
          account: "TEST123A",
          upload: {
            ...upload,
            formPageIdentity:
              "https://www.jlc.com/newOrder/?radomId=another#/pcb/pcbPlaceOrder",
          },
        },
      ),
      effectStarted: false,
    });
    expect(result.error?.code).toBe("FILE_CONTEXT_CHANGED");
    expect(result.resume).toBeUndefined();
    expect(effects).toEqual([]);
  });

  it("requests resuming original explicit parameter changes without applying them in reconcile", async () => {
    await fixture(
      `${account}<div id="leftcontent"><label for="layers">层数</label><select id="layers"><option>2</option><option>4</option></select><label for="color">颜色</label><select id="color"><option>绿</option><option>蓝</option></select></div>`,
    );
    const ctx = {
      ...context(
        { params: { 层数: "4" } },
        { upload, account: "TEST123A", decisions: { 颜色: { value: "绿" } } },
      ),
      effectStarted: false,
    };
    const result = await siteAdapter.reconcile("pcb.set", page, ctx);
    expect(result.resume).toBe(true);
    expect(await page.locator("#layers").inputValue()).toBe("2");
    expect(effects).toEqual([]);
    await page.locator("#color").selectOption("蓝");
    const changed = await siteAdapter.reconcile("pcb.set", page, ctx);
    expect(changed.error?.code).toBe("PARAMETER_CONFLICT");
    expect(changed.resume).toBeUndefined();
  });

  it.each(["fabrelay", "jlc-cli"])(
    "reconstructs a prior %s upload without sending again",
    async (prefix) => {
      const file = join(artifactDir, "original.zip");
      const bytes = Buffer.from("fixture file bytes");
      await writeFile(file, bytes);
      await fixture(
        `${account}<input type="file" onchange="window.uploaded=true"><table><tr><td>${prefix}-fixture-task-original</td><td><i title="处理成功"></i></td><td><button>立即下单</button></td></tr></table>`,
      );
      const result = await siteAdapter.reconcile("pcb.upload", page, {
        ...context({ file }),
        effectStarted: false,
      });
      expect(result.status).toBe("succeeded");
      expect(result.data.upload).toMatchObject({
        taskId: "fixture-task",
        uploadName: `${prefix}-fixture-task-original.zip`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(await page.evaluate(() => Boolean((window as any).uploaded))).toBe(
        false,
      );
      expect(effects).toEqual([]);
    },
  );

  it("keeps ambiguous renamed upload candidates unresolved and recovers when one remains", async () => {
    const file = join(artifactDir, "original.zip");
    await writeFile(file, "fixture file bytes");
    const row = (prefix: string) =>
      `<tr><td>${prefix}-fixture-task-original</td><td><i title="处理成功"></i><button>立即下单</button></td></tr>`;
    await fixture(
      `${account}<input type="file" onchange="window.uploaded=true"><table>${row("fabrelay")}${row("jlc-cli")}</table>`,
    );
    const ambiguous = await siteAdapter.reconcile(
      "pcb.upload",
      page,
      context({ file }),
    );
    expect(ambiguous.status).toBe("handoff");
    expect(ambiguous.data.upload).toBeUndefined();
    expect(ambiguous.data.candidateUploadNames).toHaveLength(2);
    await page
      .locator("tr")
      .filter({ hasText: "fabrelay-fixture-task" })
      .evaluate((row) => row.remove());
    const recovered = await siteAdapter.reconcile(
      "pcb.upload",
      page,
      context({ file }, ambiguous.data),
    );
    expect(recovered.status).toBe("succeeded");
    expect(recovered.data.upload).toMatchObject({
      uploadName: "jlc-cli-fixture-task-original.zip",
    });
    expect(await page.evaluate(() => Boolean((window as any).uploaded))).toBe(
      false,
    );
    expect(effects).toEqual([]);
  });

  it("switches an official blank-URL WeChat child from quick login to QR without hidden-template collisions", async () => {
    await page.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<iframe src="https://passport.jlc.com/window/login"></iframe>',
      }),
    );
    await page.route("https://passport.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<button>扫码登录</button><button>账号登录</button><button>手机号登录</button><iframe srcdoc="<div hidden><button>使用其他头像、昵称或账号</button></div><button onclick=&quot;document.querySelector('canvas').hidden=false;this.remove()&quot;>使用其他头像、昵称或账号</button><canvas hidden aria-label='登录二维码' width='120' height='120'></canvas>"></iframe>`,
      }),
    );
    await page.goto("https://member.jlc.com/");
    const result = await siteAdapter.run(
      "auth.login",
      page,
      context({ method: "qr" }),
    );
    expect(result.error?.code).toBe("LOGIN_QR_SCAN_REQUIRED");
    expect(result.data.qr).toMatchObject({ source: "official-login-frame" });
    expect(effects).toEqual([]);
  });

  it("does not press a lookalike WeChat switch in a frame outside passport ancestry", async () => {
    await page.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<iframe srcdoc="<button onclick=&quot;document.body.dataset.clicked='yes'&quot;>使用其他头像、昵称或账号</button>"></iframe>`,
      }),
    );
    await page.goto("https://member.jlc.com/");
    const result = await siteAdapter.run(
      "auth.login",
      page,
      context({ method: "qr" }),
    );
    expect(result.error?.code).toBe("QR_UNAVAILABLE");
    const child = page.frames().find((f) => f !== page.mainFrame())!;
    expect(await child.locator("body").getAttribute("data-clicked")).toBe(null);
  });

  it("completes explicit WeChat quick login only after the customer identity appears", async () => {
    await page.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<script>window.addEventListener('message',e=>{if(e.origin==='https://passport.jlc.com'&&e.data==='logged-in')document.body.innerHTML='客编 TEST123A'})</script><iframe src="https://passport.jlc.com/window/login"></iframe>`,
      }),
    );
    await page.route("https://passport.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<button>扫码登录</button><button onclick="parent.postMessage('logged-in','https://member.jlc.com')">微信快捷登录</button>`,
      }),
    );
    await page.goto("https://member.jlc.com/");
    const result = await siteAdapter.run(
      "auth.login",
      page,
      context({ method: "wechat" }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.authenticated).toBe(true);
    expect(result.data.account).toBe("TEST123A");
  });

  it.each([0, 1500])(
    "requires an identity decision after quick login with a %i ms overlay",
    async (delayMs) => {
      await page.route("https://member.jlc.com/**", (r) =>
        r.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<iframe src="https://passport.jlc.com/window/login"></iframe>',
        }),
      );
      await page.route("https://passport.jlc.com/**", (r) =>
        r.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<button onclick="const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:9999';document.body.append(overlay);setTimeout(()=>overlay.remove(),${delayMs})">扫码登录</button><button onclick="window.quickClicks=(window.quickClicks||0)+1;document.body.innerHTML='<h1>绑定手机号</h1><input><button>注册并登录</button>'">微信快捷登录</button>`,
        }),
      );
      await page.goto("https://member.jlc.com/");
      const result = await siteAdapter.run(
        "auth.login",
        page,
        context({ method: "wechat" }),
      );
      expect(result.error?.code, JSON.stringify(result)).toBe(
        "LOGIN_IDENTITY_BINDING_REQUIRED",
      );
      expect(result.status).toBe("needs_input");
      expect(result.data.authenticated).toBe(false);
      const passport = page
        .frames()
        .find((frame) => frame.url().includes("passport.jlc.com"))!;
      expect(await passport.evaluate(() => (window as any).quickClicks)).toBe(
        1,
      );
      expect(effects).toEqual([]);
    },
  );

  it("accepts the CLI default page one instead of treating it as an unsupported filter", async () => {
    await fixture(
      `${account}<div class="tableListBox">订单编号：Y1234 待付款 ￥12.30</div>`,
    );
    const result = await siteAdapter.run(
      "orders.list",
      page,
      context({ page: 1 }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.orders).toHaveLength(1);
  });

  it("keeps the quantity key stable across empty labels and the sample-order caption", async () => {
    await fixture(
      '<div id="leftcontent"><div id="pcbNumber"><label>板子数量</label><div><label></label><div id="pcbNumber"><input readonly placeholder="数量" value="5"></div></div></div></div>',
    );
    let params = await discoverParameters(page);
    expect(params[0].key).toBe("板子数量");
    await page
      .locator("label")
      .nth(1)
      .evaluate((e) => (e.textContent = "样板"));
    params = await discoverParameters(page);
    expect(params[0].key).toBe("板子数量");
    expect(params[0].value).toBe("5");
  });

  it("groups all custom delivery radio choices under one field instead of separate required values", async () => {
    await fixture(
      '<div id="leftcontent"><div id="achieveWrap"><div><label><span class="radioIconNew checked"></span>48小时</label></div><div><label><span class="radioIconNew"></span>24小时</label></div></div><ul class="expressUl"><li><div><span class="radioIconNew checked"></span></div>顺丰 ￥0</li><li><div><span class="radioIconNew"></span></div>京东 ￥5</li></ul></div>',
    );
    const params = await discoverParameters(page);
    expect(params.map((p) => p.key)).toEqual(["交期", "快递"]);
    expect(params[0].choices).toHaveLength(2);
    expect(params[1].value).toBe("顺丰 ￥0");
  });

  it("never returns a ZIP file-type icon as a PCB preview", async () => {
    await fixture(
      `<div id="leftcontent">文件参数</div><aside id="rightcontent">${upload.uploadName.replace(".zip", "")}<img alt="zip" width="44" height="44"></aside>`,
    );
    const result = await siteAdapter.run(
      "pcb.preview",
      page,
      context({}, { upload }),
    );
    expect(result.error?.code).toBe("PREVIEW_UNAVAILABLE");
    expect(result.data.preview).toBeUndefined();
  });

  it("recovers a rendered form only when its unique upload filename matches", async () => {
    const unbound = { ...upload, formPageIdentity: undefined };
    await fixture(
      `<div id="leftcontent"><label>数量<input name="数量" value="5"></label></div><aside id="rightcontent">${upload.uploadName.replace(".zip", "")}</aside>`,
    );
    const result = await siteAdapter.run(
      "pcb.options",
      page,
      context({}, { upload: unbound }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.upload).toMatchObject({
      formPageIdentity: upload.formPageIdentity,
    });
    expect(effects).toEqual([]);
  });

  it("does not bind an unrelated open form to an upload without a form identity", async () => {
    await fixture(
      `<div id="leftcontent"><label>数量<input name="数量" value="5"></label></div><aside id="rightcontent">fabrelay-other-board</aside>`,
    );
    const result = await siteAdapter.run(
      "pcb.options",
      page,
      context({}, { upload: { ...upload, formPageIdentity: undefined } }),
    );
    expect(result.status).toBe("handoff");
    expect(result.error?.code).toBe("UPLOAD_NOT_FOUND");
  });

  it("exports only the bound official renderer canvas when actual colored pixels exist", async () => {
    await fixture(
      `<div id="leftcontent">文件参数</div><aside id="rightcontent">${upload.uploadName.replace(".zip", "")}<canvas id="smt-engine-canvas" style="display:block" width="150" height="150"></canvas></aside><script>const ctx=document.querySelector('canvas').getContext('2d');const g=ctx.createLinearGradient(0,0,150,0);g.addColorStop(0,'green');g.addColorStop(1,'gold');ctx.fillStyle=g;ctx.fillRect(10,10,120,120);</script>`,
    );
    const result = await siteAdapter.run(
      "pcb.preview",
      page,
      context({}, { upload }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.preview).toMatchObject({
      source: "jlc.com",
      fileSha256: upload.sha256,
      width: 150,
      height: 150,
    });
    expect(effects).toEqual([]);
  });

  it("captures a composited WebGL preview with a non-preserved drawing buffer", async () => {
    await fixture(
      `<div id="leftcontent">文件参数</div><aside id="rightcontent">${upload.uploadName.replace(".zip", "")}<canvas id="smt-engine-canvas" style="display:block" width="150" height="150"></canvas></aside><script>
      const gl=document.querySelector('canvas').getContext('webgl',{preserveDrawingBuffer:false});
      const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);return s};
      const program=gl.createProgram();
      gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec2 p; varying vec2 uv; void main(){uv=p;gl_Position=vec4(p,0.,1.);}'));
      gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float; varying vec2 uv; void main(){gl_FragColor=vec4((uv.x+1.)*.35,.65,(uv.y+1.)*.15,1.);}'));
      gl.linkProgram(program);gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,0,1]),gl.STATIC_DRAW);
      const p=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0);
      function draw(){gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);requestAnimationFrame(draw)}draw();
      </script>`,
    );
    expect(
      await page
        .locator("canvas")
        .evaluate(
          (canvas) =>
            (canvas as HTMLCanvasElement)
              .getContext("webgl")
              ?.getContextAttributes()?.preserveDrawingBuffer,
        ),
    ).toBe(false);
    const result = await siteAdapter.run(
      "pcb.preview",
      page,
      context({}, { upload }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.preview).toMatchObject({
      width: 150,
      height: 150,
      fileSha256: upload.sha256,
    });
    expect(effects).toEqual([]);
  });

  it("rejects a blank official canvas even when it is screenshot-able", async () => {
    await fixture(
      `<div id="leftcontent">文件参数</div><aside id="rightcontent">${upload.uploadName.replace(".zip", "")}<canvas id="smt-engine-canvas" style="display:block" width="150" height="150"></canvas></aside>`,
    );
    const result = await siteAdapter.run(
      "pcb.preview",
      page,
      context({}, { upload }),
    );
    expect(result.error?.code).toBe("PREVIEW_NOT_READY");
    expect(result.data.preview).toBeUndefined();
  });

  it("does not reopen a file or click upload rows while reconciling a missing preview", async () => {
    await fixture(
      `<table><tr><td>${upload.uploadName.replace(".zip", "")}</td><td><button onclick="window.opened=true">立即下单</button></td></tr></table>`,
    );
    const result = await siteAdapter.reconcile(
      "pcb.preview",
      page,
      context({}, { upload }),
    );
    expect(result.error?.code).toBe("PREVIEW_FILE_NOT_VERIFIED");
    expect(await page.evaluate(() => Boolean((window as any).opened))).toBe(
      false,
    );
    expect(effects).toEqual([]);
  });

  it("waits for the requested order ID after the read-only details shell appears", async () => {
    await fixture(
      `${account}<div class="tableListBox">订单编号：Y1234 待付款 <button onclick="document.querySelector('#detail').hidden=false;setTimeout(()=>document.querySelector('#detail').append(' 订单编号：Y1234 生产中'),150)">订单详情</button></div><div id="detail" class="el-dialog pcb-order-details-modal" hidden>PCB订单详情</div>`,
    );
    const result = await siteAdapter.run(
      "orders.show",
      page,
      context({ orderId: "Y1234" }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.data.orderId).toBe("Y1234");
    expect(String(result.data.detail)).toContain("生产中");
  });

  it("uses unambiguous selectors when JLC duplicates an ID on a wrapper and button", async () => {
    await fixture(
      '<div id="leftcontent"><label>标志</label><div id="mark"><button name="标志" id="mark" onclick="this.classList.add(\'checked\')">不加标志</button></div></div>',
    );
    const params = await discoverParameters(page);
    expect(params[0].choices[0].selector).toBe("button#mark");
    const result = await siteAdapter.run(
      "pcb.set",
      page,
      context({ params: { 标志: "不加标志" } }),
    );
    expect(result.status).toBe("succeeded");
  });

  it("confirms only the explicitly requested no-SMT option in its secondary dialog", async () => {
    await fixture(
      '<div id="leftcontent"><label>是否SMT贴片</label><button name="是否SMT贴片" id="no-smt" onclick="document.querySelector(\'.el-dialog\').hidden=false">不需要</button><button name="是否SMT贴片">需要</button></div><div class="el-dialog" hidden>请选择本单是否需要SMT贴片<button onclick="document.querySelector(\'#no-smt\').classList.add(\'checked\');this.parentElement.hidden=true">确定，不需要SMT</button><button>需要SMT</button></div>',
    );
    const result = await siteAdapter.run(
      "pcb.set",
      page,
      context({ params: { 是否SMT贴片: "不需要" } }),
    );
    expect(result.status).toBe("succeeded");
    expect((result.data.decisions as any)["是否SMT贴片"].value).toBe("不需要");
    expect(effects).toEqual([]);
  });

  it("waits for the website price loading state and stable replacement amount", async () => {
    await fixture(
      '<div id="leftcontent"><label for="qty">数量</label><input id="qty" value="5"></div><aside id="rightcontent"><p>总价 ￥12.30</p><div class="el-loading-mask">计价中</div></aside><script>setTimeout(()=>{document.querySelector("#rightcontent p").textContent="总价 ￥27.00";document.querySelector(".el-loading-mask").remove()},300)</script>',
    );
    const result = await siteAdapter.run("pcb.quote", page, {
      ...context({}, { upload, decisions: { 数量: { value: "5" } } }),
      timeoutMs: 3000,
    });
    expect(result.status).toBe("succeeded");
    expect((result.data.quote as any).amount).toBe("27.00");
  });

  it("never presents an initially expired official QR as scannable", async () => {
    await page.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<iframe src="https://passport.jlc.com/window/login"></iframe>',
      }),
    );
    await page.route("https://passport.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<button>扫码登录</button><p>二维码已过期</p><canvas aria-label="二维码" width="120" height="120"></canvas>',
      }),
    );
    await page.goto("https://member.jlc.com/");
    const result = await siteAdapter.run(
      "auth.login",
      page,
      context({ method: "qr" }),
    );
    expect(result.error?.code).toBe("LOGIN_QR_EXPIRED");
    expect(result.data.qr).toBe(null);
  });

  it("refreshes the QR fingerprint and ignores a QR inside a hidden parent iframe", async () => {
    await page.route("https://member.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<iframe src="https://passport.jlc.com/window/login"></iframe>',
      }),
    );
    await page.route("https://passport.jlc.com/**", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<button>扫码登录</button><canvas aria-label="二维码" width="120" height="120"></canvas>',
      }),
    );
    await page.goto("https://member.jlc.com/");
    const first = await siteAdapter.run(
      "auth.login",
      page,
      context({ method: "qr" }),
    );
    expect(first.data.qr).toMatchObject({
      source: "official-login-frame",
      observedAt: expect.any(String),
      sha256: expect.any(String),
    });
    const frame = page
      .frames()
      .find((f) => f.url().includes("passport.jlc.com"))!;
    await frame.locator("canvas").evaluate((e: any) => {
      const c = e.getContext("2d");
      c.fillStyle = "black";
      c.fillRect(0, 0, 60, 60);
    });
    const updated = await siteAdapter.reconcile(
      "auth.login",
      page,
      context({ method: "qr" }, first.data),
    );
    expect((updated.data.qr as any).sha256).not.toBe(
      (first.data.qr as any).sha256,
    );
    await page.locator("iframe").evaluate((e) => (e.style.display = "none"));
    const hidden = await siteAdapter.reconcile(
      "auth.login",
      page,
      context({ method: "qr" }, updated.data),
    );
    expect(hidden.data.qr).toBe(null);
    expect(hidden.status).toBe("handoff");
  });
});
