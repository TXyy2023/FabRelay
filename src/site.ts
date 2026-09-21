import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Frame, Locator, Page } from "playwright";
import type {
  AdapterContext,
  BusinessResult,
  Operation,
  SiteAdapter,
} from "./contracts.js";

/** jlc.com DOM adapter. Selectors are based on the live China site; see docs/site-evidence.md. */
const URLS = {
  member: "https://member.jlc.com/",
  account: "https://member.jlc.com/integrated/accountInfo/userAccountInfo",
  upload: "https://www.jlc.com/newOrder/#/pcb/newOnlinePlaceOrder",
  options: "https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder",
  orders: "https://www.jlc.com/newOrder/#/pcb/pcbOrderList",
};
type Json = Record<string, unknown>;
type Surface = Page | Frame;
interface Choice {
  value: string;
  label: string;
  selector: string;
  disabled: boolean;
}
export interface Parameter {
  key: string;
  label: string;
  kind: "choice" | "text" | "number" | "select" | "checkbox" | "custom";
  value: string | boolean | string[];
  choices: Choice[];
  selector: string;
  required: boolean;
  disabled: boolean;
  unit: string | null;
  constraints: Record<string, string | null>;
  source: "website";
  help: string;
  dependsOn: string[];
}
interface Upload {
  taskId: string;
  fileName: string;
  uploadName: string;
  sha256: string;
  size: number;
  uploadedAt: string;
  pageUrl?: string;
  rowText?: string;
  formPageIdentity?: string;
  formParametersHash?: string;
  account?: string;
}
const ok = (data: Json): BusinessResult => ({ status: "succeeded", data });
const problem = (
  status: BusinessResult["status"],
  code: string,
  message: string,
  data: Json = {},
  next: string[] = [],
): BusinessResult => ({ status, data, error: { code, message }, next });
const handoff = (
  code: string,
  message: string,
  data: Json = {},
): BusinessResult =>
  problem("handoff", code, message, data, [
    "在保留的浏览器会话中处理页面；释放接管控制权后 CLI 将核实并继续。",
  ]);
const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const norm = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const rx = (text: string): RegExp =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const css = (text: string): string =>
  '"' +
  text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\n\r]/g, "") +
  '"';
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function cleanUrl(value: string): string {
  try {
    const u = new URL(value);
    return u.origin + u.pathname + u.hash.split("?")[0];
  } catch {
    return "";
  }
}
function trusted(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      (u.hostname === "jlc.com" || u.hostname.endsWith(".jlc.com"))
    );
  } catch {
    return false;
  }
}
async function visible(locator: Locator): Promise<Locator | null> {
  for (const item of await locator.all())
    if (await item.isVisible()) return item;
  return null;
}
async function body(page: Surface): Promise<string> {
  return page
    .locator("body")
    .innerText({ timeout: 3000 })
    .catch(() => "");
}
async function waitUntil<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let result = await read();
  while (!accepts(result) && Date.now() < deadline) {
    await new Promise((r) =>
      setTimeout(r, Math.min(350, Math.max(1, deadline - Date.now()))),
    );
    result = await read();
  }
  return result;
}
async function navigate(
  page: Page,
  url: string,
  timeout: number,
): Promise<void> {
  if (cleanUrl(page.url()) !== cleanUrl(url))
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
}
async function clickText(
  page: Surface,
  name: string | RegExp,
): Promise<boolean> {
  const button = await visible(
    page.getByRole("button", { name, exact: typeof name === "string" }),
  );
  const target =
    button ??
    (await visible(page.getByText(name, { exact: typeof name === "string" })));
  if (!target) return false;
  await target.click({ timeout: 5000 });
  return true;
}
async function blockers(page: Surface): Promise<string[]> {
  return page
    .locator(
      '.el-form-item__error,.el-message--error,.el-message-box__message,[role="alert"],.el-notification--error',
    )
    .allTextContents()
    .then((v) => v.map(norm).filter(Boolean));
}
async function dismissMarketing(page: Page): Promise<void> {
  const introduction = await visible(
    page
      .locator(".el-dialog.new-feature")
      .filter({ hasText: "新版PCB下单上线啦" }),
  );
  if (introduction) {
    const start = await visible(
      introduction.getByRole("button", { name: "开始体验", exact: true }),
    );
    if (start) await start.click();
  }
  const promotion = await visible(
    page
      .locator(".el-dialog")
      .filter({ hasText: /恭喜您获得现金[劵券]|不需要现金[劵券]理由/ }),
  );
  if (!promotion) return;
  const close = await visible(
    promotion.locator('.close_icon,button[aria-label="Close"]'),
  );
  if (close) await close.click();
}

/** Enumerate actual native controls plus JLC's named/checked button groups, without choosing defaults. */
export async function discoverParameters(page: Page): Promise<Parameter[]> {
  return page.evaluate(() => {
    const visible = (e: Element): boolean => {
      const h = e as HTMLElement;
      const s = getComputedStyle(h);
      return (
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length)
      );
    };
    const text = (e: Element | null): string =>
      (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    const directText = (e: Element): string =>
      Array.from(e.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    const path = (e: Element): string => {
      if (e.id) {
        const id = "#" + CSS.escape(e.id);
        if (document.querySelectorAll(id).length === 1) return id;
        const typed = e.tagName.toLowerCase() + id;
        if (document.querySelectorAll(typed).length === 1) return typed;
      }
      const parent = e.parentElement;
      if (!parent) return e.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === e.tagName,
      );
      return (
        path(parent) +
        " > " +
        e.tagName.toLowerCase() +
        (siblings.length > 1
          ? ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")"
          : "")
      );
    };
    const disabled = (e: Element): boolean =>
      e.hasAttribute("disabled") ||
      e.getAttribute("aria-disabled") === "true" ||
      /(?:^|\s)(?:disabled|btnDisabled|is-disabled)(?:\s|$)/.test(e.className);
    const selected = (e: Element): boolean =>
      e.matches(":checked") ||
      e.getAttribute("aria-checked") === "true" ||
      e.getAttribute("aria-pressed") === "true" ||
      e.getAttribute("aria-selected") === "true" ||
      /(?:^|\s)(?:checked|is-checked|selected|is-selected)(?:\s|$)/.test(
        e.className,
      );
    const root =
      document.querySelector("#leftcontent") ??
      document.querySelector("main form,form") ??
      document.body;
    const labelFor = (e: Element): string => {
      const named = e.getAttribute("name");
      if (e.tagName === "BUTTON" && named) return named;
      if (e.getAttribute("aria-label")) return e.getAttribute("aria-label")!;
      if (e.id) {
        const label = document.querySelector(
          'label[for="' + CSS.escape(e.id) + '"]',
        );
        if (label) return text(label);
      }
      let p: Element | null = e.parentElement;
      for (let i = 0; p && p !== root && i < 9; i++, p = p.parentElement) {
        const label = Array.from(p.children).find(
          (c) => c.tagName === "LABEL" && !c.matches(".el-checkbox,.el-radio"),
        );
        if (label) {
          const value = directText(label) || text(label);
          if (value) return value;
        }
        if (
          p.matches('fieldset,[role="group"],[role="radiogroup"],.el-form-item')
        )
          return (
            text(p.querySelector("legend,.el-form-item__label")) ||
            p.getAttribute("aria-label") ||
            ""
          );
      }
      return named || e.getAttribute("placeholder") || e.id;
    };
    const out: Parameter[] = [];
    const seen = new Set<Element>();
    const groups = new Map<string, Element[]>();
    for (const e of root.querySelectorAll(
      '.radioIconNew,button[name],button,[role="radio"],[role="option"],[role="checkbox"],input[type="radio"],.el-radio',
    )) {
      if (!visible(e) || e.closest('.el-dialog,.el-popover,[role="tooltip"]'))
        continue;
      const label = e.matches(".radioIconNew")
        ? e.closest(".impedanceTableChoose1")
          ? "板材选项"
          : e.closest("#achieveWrap")
            ? "交期"
            : e.closest(".expressUl")
              ? "快递"
              : labelFor(e)
        : labelFor(e);
      if (!label || /提交|检查|修改|取消|新增|选择开票|调整金额/.test(text(e)))
        continue;
      if (
        e.matches("button") &&
        !e.hasAttribute("name") &&
        !e.querySelector("svg.i") &&
        !/(?:checked|jlc-btn|plateTypeButton|radius2)/.test(e.className)
      )
        continue;
      const groupKey = label;
      const group = groups.get(groupKey) ?? [];
      group.push(e);
      groups.set(groupKey, group);
    }
    for (const [label, elements] of groups) {
      const unique = elements.filter(
        (e) => !elements.some((parent) => parent !== e && parent.contains(e)),
      );
      const optionText = (e: Element): string =>
        e.matches(".radioIconNew")
          ? text(e.closest("tr,li,label") ?? e.parentElement)
          : text(e);
      const choices = unique.map((e) => ({
        value: e.getAttribute("value") || optionText(e),
        label: optionText(e),
        selector: path(e),
        disabled: disabled(e) || e.classList.contains("disabledIcon"),
      }));
      if (!choices.length || choices.some((c) => !c.label)) continue;
      unique.forEach((e) => {
        seen.add(e);
        e.querySelectorAll("input").forEach((n) => seen.add(n));
      });
      const chosen = unique
        .filter(selected)
        .map((e) => e.getAttribute("value") || optionText(e));
      out.push({
        key: label,
        label,
        kind: "choice",
        value: chosen.length > 1 ? chosen : (chosen[0] ?? ""),
        choices,
        selector: path(unique[0].parentElement!),
        required: true,
        disabled: choices.every((c) => c.disabled),
        unit: null,
        constraints: {},
        source: "website",
        help: text(
          unique[0].closest(".line30,.el-form-item,fieldset") ??
            unique[0].parentElement,
        ).slice(0, 1200),
        dependsOn: [],
      });
    }
    for (const e of root.querySelectorAll(
      'input,select,textarea,[role="combobox"],[contenteditable="true"]',
    )) {
      if (
        seen.has(e) ||
        !visible(e) ||
        e.closest('.el-dialog,.el-popover,[role="tooltip"]')
      )
        continue;
      const input = e as HTMLInputElement;
      const type = input.type;
      if (
        ["file", "password", "hidden", "submit", "button", "radio"].includes(
          type,
        ) ||
        /search/i.test(e.id) ||
        /搜索/.test(e.getAttribute("placeholder") || "")
      )
        continue;
      const label = e.matches(".radioIconNew")
        ? e.closest(".impedanceTableChoose1")
          ? "板材选项"
          : e.closest("#achieveWrap")
            ? "交期"
            : e.closest(".expressUl")
              ? "快递"
              : labelFor(e)
        : labelFor(e);
      if (!label || /免责声明|我已知悉/.test(label)) continue;
      let key = label;
      if (e.id === "pcbLengthInput") key = "板子长度";
      if (e.id === "pcbWidthInput") key = "板子宽度";
      if (e.closest("#pcbNumber")) key = "板子数量";
      if (out.some((p) => p.key === key))
        key += ":" + (e.getAttribute("placeholder") || e.id || out.length);
      const select = e as HTMLSelectElement;
      const choices =
        e.tagName === "SELECT"
          ? Array.from(select.options).map((o) => ({
              value: o.value,
              label: o.text,
              selector: path(o),
              disabled: o.disabled,
            }))
          : e.closest("#pcbNumber")
            ? Array.from(
                e.closest("#pcbNumber")!.querySelectorAll("li.numItem"),
              ).map((o) => ({
                value: text(o),
                label: text(o),
                selector: path(o),
                disabled: disabled(o),
              }))
            : [];
      out.push({
        key,
        label,
        kind:
          e.tagName === "SELECT"
            ? "select"
            : type === "checkbox"
              ? "checkbox"
              : input.readOnly || e.getAttribute("role") === "combobox"
                ? "custom"
                : type === "number" || e.getAttribute("role") === "spinbutton"
                  ? "number"
                  : "text",
        value: type === "checkbox" ? input.checked : (input.value ?? text(e)),
        choices,
        selector: path(e),
        required:
          input.required ||
          e.getAttribute("aria-required") === "true" ||
          !!e.closest(".is-required"),
        disabled: disabled(e),
        unit: /尺寸|长度|宽度/.test(key) ? "cm" : null,
        constraints: {
          min: e.getAttribute("min"),
          max: e.getAttribute("max"),
          step: e.getAttribute("step"),
          pattern: e.getAttribute("pattern"),
        },
        source: "website",
        help: text(
          e.closest(".line30,.el-form-item,fieldset") ?? e.parentElement,
        ).slice(0, 1200),
        dependsOn: [],
      });
    }
    return out;
  });
}
function paramsHash(parameters: Parameter[]): string {
  return hash(
    parameters
      .map((p) => [p.key, p.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
async function accountOn(page: Surface): Promise<string | null> {
  if (await visible(page.locator('iframe[src*="passport.jlc.com"]')))
    return null;
  const text = await body(page);
  return text.match(/客编\s*[:：]?\s*([A-Za-z0-9]{4,})\b/)?.[1] ?? null;
}
async function account(page: Page, fresh = false): Promise<string | null> {
  const direct = await accountOn(page);
  if (direct && !fresh) return direct;
  const probe = await page.context().newPage();
  try {
    await probe.goto(URLS.member, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    return await waitUntil(
      () => accountOn(probe),
      (v) => !!v,
      5000,
    );
  } finally {
    await probe.close();
  }
}
async function loginStatus(page: Page): Promise<BusinessResult> {
  const id = await accountOn(page);
  if (id)
    return ok({
      authenticated: true,
      loggedIn: true,
      account: id,
      evidence: "页面客编",
      pageUrl: cleanUrl(page.url()),
    });
  return problem(
    "needs_login",
    "LOGIN_REQUIRED",
    "尚未读取到有效的登录账号；请在保留的浏览器中完成登录。",
    { authenticated: false, loggedIn: false, pageUrl: cleanUrl(page.url()) },
    ["fabrelay auth login"],
  );
}
/** WeChat embeds sometimes expose an empty URL; only trust descendants of the official passport frame. */
function loginFrames(page: Page): Frame[] {
  const passport = (frame: Frame): boolean => {
    try {
      return new URL(frame.url()).hostname === "passport.jlc.com";
    } catch {
      return false;
    }
  };
  return page.frames().filter((frame) => {
    let parent: Frame | null = frame;
    while (parent) {
      if (passport(parent)) return true;
      parent = parent.parentFrame();
    }
    return false;
  });
}
async function frameVisible(frame: Frame): Promise<boolean> {
  try {
    let current: Frame | null = frame;
    while (current?.parentFrame()) {
      if (!(await (await current.frameElement()).isVisible())) return false;
      current = current.parentFrame();
    }
    return true;
  } catch {
    return false;
  }
}
async function activeLoginFrames(page: Page): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const frame of loginFrames(page))
    if (await frameVisible(frame)) frames.push(frame);
  return frames;
}
async function loginButton(page: Page, name: string): Promise<Locator | null> {
  for (const frame of await activeLoginFrames(page)) {
    const button = await visible(
      frame.getByRole("button", { name, exact: true }),
    );
    if (button) return button;
  }
  return null;
}
async function availableLoginMethods(page: Page): Promise<string[]> {
  const methods: string[] = [];
  for (const [method, label] of [
    ["qr", "扫码登录"],
    ["password", "账号登录"],
    ["sms", "手机号登录"],
    ["wechat", "微信快捷登录"],
  ])
    if (await loginButton(page, label)) methods.push(method);
  return methods;
}
async function currentQr(
  page: Page,
  context: AdapterContext,
): Promise<{ expired: boolean; qr: Json | null }> {
  const frames = await activeLoginFrames(page);
  const text = (await Promise.all(frames.map(body))).join("\n");
  if (/二维码已失效|二维码已过期|二维码过期/.test(text))
    return { expired: true, qr: null };
  for (const frame of frames) {
    const picture = await visible(
      frame.locator(
        'img.qrcode,#wechat-qr img,canvas[aria-label*="二维码"],img[alt*="二维码"]',
      ),
    );
    if (!picture) continue;
    if (
      !(await picture.evaluate(
        (e) =>
          e.tagName !== "IMG" ||
          ((e as HTMLImageElement).complete &&
            (e as HTMLImageElement).naturalWidth > 0),
      ))
    )
      continue;
    await mkdir(context.artifactDir, { recursive: true });
    const path = join(context.artifactDir, "login-qr.png");
    const bytes = await picture.screenshot({ path });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prior = obj(context.previous?.qr);
    return {
      expired: false,
      qr: {
        path,
        source: "official-login-frame",
        sha256,
        observedAt:
          prior.sha256 === sha256 && prior.observedAt
            ? prior.observedAt
            : new Date().toISOString(),
      },
    };
  }
  return { expired: false, qr: null };
}
async function login(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  await navigate(page, URLS.member, context.timeoutMs);
  const known = await waitUntil(
    () => accountOn(page),
    (v) => !!v,
    Math.min(3000, context.timeoutMs),
  );
  if (known)
    return ok({
      authenticated: true,
      loggedIn: true,
      account: known,
      evidence: "客户中心客编",
    });
  const loginSurface = (): Surface =>
    page.frames().find((f) => {
      try {
        return new URL(f.url()).hostname === "passport.jlc.com";
      } catch {
        return false;
      }
    }) ?? page;
  let surface = loginSurface();
  const input = context.input;
  const method = str(input.method) || "qr";
  if (method === "password")
    await clickText(surface, /^(账号登录|密码登录|账号密码登录)$/);
  else if (method === "sms")
    await clickText(
      surface,
      /^(手机号登录|短信登录|验证码登录|手机验证码登录)$/,
    );
  else if (method === "qr" || method === "wechat")
    await clickText(surface, /^(扫码登录|微信登录|微信扫码登录)$/);
  else if (method !== "manual")
    return problem(
      "needs_input",
      "LOGIN_METHOD_INVALID",
      "登录方式须为 manual、qr、wechat、password 或 sms。",
    );
  if (method === "qr") {
    const alternate = await waitUntil(
      () => loginButton(page, "使用其他头像、昵称或账号"),
      (v) => !!v,
      Math.min(context.timeoutMs, 2000),
    );
    if (alternate) await alternate.click();
  }
  if (method === "wechat") {
    const quick = await waitUntil(
      () => loginButton(page, "微信快捷登录"),
      (v) => !!v,
      Math.min(context.timeoutMs, 3000),
    );
    if (!quick)
      return handoff(
        "WECHAT_QUICK_LOGIN_UNAVAILABLE",
        "当前官方微信登录页面没有可用的快捷登录按钮，请选择 qr 扫码。",
        { method, availableMethods: await availableLoginMethods(page) },
      );
    await quick.click();
    const id = await waitUntil(
      () => accountOn(page),
      (v) => !!v,
      Math.min(context.timeoutMs, 10000),
    );
    if (id)
      return ok({
        authenticated: true,
        loggedIn: true,
        account: id,
        evidence: "微信快捷登录后读取客户中心客编",
      });
    const flowText = (await Promise.all(loginFrames(page).map(body))).join(
      "\n",
    );
    if (
      /绑定手机号码|绑定手机号|注册并登录|注册新账号|创建新账号|绑定已有账号/.test(
        flowText,
      )
    )
      return problem(
        "needs_input",
        "LOGIN_IDENTITY_BINDING_REQUIRED",
        "微信快捷登录要求注册或绑定身份；请由用户决定身份绑定后继续。",
        { method, authenticated: false, loggedIn: false },
      );
  }
  surface = loginSurface();
  const fields: [string, string][] =
    method === "password"
      ? [
          [
            'input[placeholder="请输入手机号码 / 客户编号 / 邮箱"],input[autocomplete="username"]',
            str(input.username),
          ],
          ['input[type="password"]', str(input.password)],
        ]
      : method === "sms"
        ? [
            [
              'input[type="tel"],input[placeholder*="手机号"]',
              str(input.phone),
            ],
            ['input[placeholder*="验证码"]', str(input.smsCode)],
          ]
        : [];
  for (const [selector, value] of fields)
    if (value) {
      const field = await visible(surface.locator(selector));
      if (!field)
        return handoff("LOGIN_LAYOUT_CHANGED", "登录字段与所选方式不匹配。", {
          method,
        });
      await field.fill(value);
    }
  if (
    (method === "password" && input.password && input.username) ||
    (method === "sms" && input.phone && input.smsCode)
  ) {
    // The live site's checkbox is “下次自动登录”, not a Terms acceptance checkbox.
    await clickText(surface, /^(登录|登 录|立即登录)$/);
    const id = await waitUntil(
      () => accountOn(page),
      (v) => !!v,
      Math.min(context.timeoutMs, 10000),
    );
    if (id)
      return ok({
        authenticated: true,
        loggedIn: true,
        account: id,
        evidence: "登录后读取客户中心客编",
      });
  }
  const text = await body(surface);
  const challenge = /滑块|安全验证|请完成验证/.test(text);
  await mkdir(context.artifactDir, { recursive: true });
  const screenshot = join(context.artifactDir, "login.png");
  await page.screenshot({ path: screenshot }).catch(() => {});
  const availableMethods = await availableLoginMethods(page);
  if (method === "qr" && !challenge) {
    const current = await currentQr(page, context);
    if (current.expired)
      return handoff(
        "LOGIN_QR_EXPIRED",
        "官方二维码已过期，请在页面刷新二维码。",
        {
          method,
          availableMethods,
          screenshot,
          qr: null,
          pageUrl: cleanUrl(page.url()),
        },
      );
    if (current.qr)
      return handoff(
        "LOGIN_QR_SCAN_REQUIRED",
        "请扫描当前网站登录二维码；CLI 读取客编后确认登录。",
        {
          method,
          availableMethods,
          screenshot,
          qr: current.qr,
          pageUrl: cleanUrl(page.url()),
        },
      );
    return handoff(
      "QR_UNAVAILABLE",
      "官方扫码登录面板已打开，但二维码尚未加载；检查微信二维码网络或选择账号/手机号登录。",
      {
        method,
        availableMethods,
        screenshot,
        qr: null,
        pageUrl: cleanUrl(page.url()),
      },
    );
  }
  return handoff(
    challenge ? "LOGIN_CHALLENGE" : "LOGIN_INTERACTION_REQUIRED",
    challenge ? "登录需要页面验证；保留会话等待完成。" : "请完成所选登录方式。",
    { method, availableMethods, screenshot, pageUrl: cleanUrl(page.url()) },
  );
}
async function reconcileLogin(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const state = await loginStatus(page);
  if (state.status === "succeeded") return state;
  const surface =
    page.frames().find((f) => {
      try {
        return new URL(f.url()).hostname === "passport.jlc.com";
      } catch {
        return false;
      }
    }) ?? page;
  const text = await body(surface);
  const challenge = /滑块|安全验证|请完成验证/.test(text);
  const { expired, qr } = await currentQr(page, context);
  return handoff(
    challenge
      ? "LOGIN_CHALLENGE"
      : expired
        ? "LOGIN_QR_EXPIRED"
        : qr
          ? "LOGIN_QR_SCAN_REQUIRED"
          : "LOGIN_INTERACTION_REQUIRED",
    challenge
      ? "等待完成网站验证。"
      : expired
        ? "二维码已过期，请在页面刷新二维码。"
        : qr
          ? "官方二维码已加载，等待扫码登录。"
          : "等待完成登录；尚未读取到有效客编。",
    {
      ...context.previous,
      authenticated: false,
      loggedIn: false,
      qr: expired ? null : qr,
    },
  );
}
function getUpload(context: AdapterContext): Upload | null {
  const u = obj(context.input.upload ?? context.previous?.upload);
  return typeof u.sha256 === "string" && typeof u.uploadName === "string"
    ? (u as unknown as Upload)
    : null;
}
async function uploadRow(page: Page, upload: Upload): Promise<Locator | null> {
  const candidates = page
    .locator("tr")
    .filter({ hasText: upload.uploadName.replace(/\.(zip|rar)$/i, "") });
  const rows: Locator[] = [];
  for (const row of await candidates.all())
    if (await row.isVisible()) rows.push(row);
  return rows.length === 1 ? rows[0] : null;
}
async function readUpload(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const upload = getUpload(context);
  if (!upload)
    return problem(
      "needs_input",
      "UPLOAD_CONTEXT_REQUIRED",
      "缺少本次上传关联信息。",
    );
  const row = await uploadRow(page, upload);
  if (!row)
    return handoff(
      "UPLOAD_NOT_FOUND",
      "当前页面没有找到本次任务对应的上传记录。",
      { upload },
    );
  const text = await row.innerText();
  if (/解析失败|处理失败|上传失败|文件错误/.test(text))
    return problem("failed", "FILE_PARSE_FAILED", norm(text), {
      upload,
      parseStatus: "failed",
    });
  const ready = await visible(row.getByText("立即下单", { exact: true }));
  const parsed =
    (await row.locator('[title="处理成功"],[title="解析成功"]').count()) > 0;
  const failures = await row
    .locator('[title*="失败"],[title*="错误"]')
    .allTextContents();
  if (failures.length)
    return problem(
      "failed",
      "FILE_PARSE_FAILED",
      "网站标记本次文件解析失败。",
      { upload, parseStatus: "failed" },
    );
  if (!ready || !parsed)
    return handoff("FILE_PARSING", "文件已经发送，网站解析尚未完成。", {
      upload,
      parseStatus: "processing",
      evidence: norm(text),
    });
  return ok({
    upload: { ...upload, rowText: norm(text) },
    parseStatus: "parsed",
    evidence: "本次唯一上传文件行显示处理成功且出现立即下单",
  });
}
async function uploadFile(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const file = resolve(str(context.input.file));
  if (!str(context.input.file))
    return problem(
      "needs_input",
      "FILE_REQUIRED",
      "请提供原生支持的 PCB/Gerber 文件路径。",
    );
  let bytes: Buffer;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error();
    if (info.size > 100 * 1024 * 1024)
      return problem("failed", "FILE_TOO_LARGE", "页面要求文件不超过 100M。");
    bytes = await readFile(file);
  } catch {
    return problem(
      "failed",
      "FILE_UNREADABLE",
      "文件不存在、不是普通文件或不可读取。",
    );
  }
  await navigate(page, URLS.upload, context.timeoutMs);
  if (!(await accountOn(page))) {
    const state = await waitUntil(
      () => accountOn(page),
      (v) => !!v,
      3000,
    );
    if (!state) return loginStatus(page);
  }
  const fileInput = page.locator('input[type="file"]');
  await fileInput
    .first()
    .waitFor({ state: "attached", timeout: context.timeoutMs });
  const acceptance = await fileInput.first().getAttribute("accept");
  if (!/\.(zip|rar)$/i.test(file))
    return problem(
      "failed",
      "UNSUPPORTED_FILE",
      "当前页面说明接受 Gerber/PCB 源文件的 zip/rar 压缩包，不执行本地转换。",
      {
        accept: acceptance,
        pageSupport: "Gerber/PCB 源文件，zip/rar，不超过100M",
      },
    );
  const upload: Upload = {
    taskId: context.taskId,
    fileName: basename(file),
    uploadName: `fabrelay-${context.taskId.slice(0, 12)}-${basename(file)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    uploadedAt: new Date().toISOString(),
    pageUrl: URLS.upload,
    account: (await accountOn(page)) ?? undefined,
  };
  try {
    await fileInput.first().setInputFiles({
      name: upload.uploadName,
      mimeType: /\.zip$/i.test(file)
        ? "application/zip"
        : "application/vnd.rar",
      buffer: bytes,
    });
  } catch {
    return handoff(
      "UPLOAD_RESULT_UNKNOWN",
      "文件发送未得到明确结果；先核实本次唯一上传文件记录，勿盲目重复上传。",
      { upload, parseStatus: "unknown" },
    );
  }
  return waitUntil(
    () => readUpload(page, { ...context, input: { ...context.input, upload } }),
    (r) => r.status === "succeeded" || r.status === "failed",
    context.timeoutMs,
  );
}
function formIdentity(value: string): string {
  try {
    const u = new URL(value);
    const token = u.searchParams.get("radomId");
    return (
      u.origin +
      u.pathname +
      (token ? "?radomId=" + encodeURIComponent(token) : "") +
      u.hash.split("?")[0]
    );
  } catch {
    return "";
  }
}
async function waitForForm(
  page: Page,
  timeoutMs: number,
  verifyParsedDimensions = false,
): Promise<void> {
  await page
    .locator("#leftcontent")
    .waitFor({ state: "visible", timeout: timeoutMs });
  // The SPA renders an empty shell first. File dimensions and material controls arrive with its data.
  if (new URL(page.url()).searchParams.has("pcbFileId"))
    await page.waitForFunction(
      (verifyParsedDimensions) => {
        const query = new URL(location.href).searchParams;
        const length =
          document.querySelector<HTMLInputElement>("#pcbLengthInput");
        const width =
          document.querySelector<HTMLInputElement>("#pcbWidthInput");
        return (
          !!document
            .querySelector("#leftcontent")
            ?.textContent?.includes("板材类别") &&
          !!length?.value &&
          !!width?.value &&
          (!verifyParsedDimensions ||
            (Number(length.value) === Number(query.get("pcbLength")) &&
              Number(width.value) === Number(query.get("pcbWidth"))))
        );
      },
      verifyParsedDimensions,
      { timeout: timeoutMs },
    );
  await dismissMarketing(page);
}
async function openUploadedForm(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult | null> {
  const upload = getUpload(context);
  if (await page.locator("#leftcontent").count()) {
    if (!upload)
      return problem(
        "needs_input",
        "UPLOAD_CONTEXT_REQUIRED",
        "请先关联本次上传任务。",
      );
    if (upload.formPageIdentity === formIdentity(page.url())) {
      await waitForForm(page, context.timeoutMs);
      return null;
    }
    if (upload.formPageIdentity)
      return handoff(
        "FILE_CONTEXT_CHANGED",
        "当前参数页与本次文件打开时的页面标识不同；报价和确认已失效。",
        { upload, quote: null },
      );
    // A transfer can finish rendering after an earlier command timed out.
    // Rebind only when this exact, uniquely named upload is visible in the
    // official preview region; never accept an unrelated currently open form.
    const filename = upload.uploadName.replace(/\.(zip|rar)$/i, "");
    const shownFile = await page
      .locator("#rightcontent")
      .innerText()
      .catch(() => "");
    if (shownFile.includes(filename)) {
      await waitForForm(page, context.timeoutMs, true);
      upload.formPageIdentity = formIdentity(page.url());
      upload.formParametersHash = paramsHash(await discoverParameters(page));
      return null;
    }
  }
  if (!upload)
    return problem(
      "needs_input",
      "UPLOAD_CONTEXT_REQUIRED",
      "请先上传文件并传入对应任务上下文。",
    );
  if (!(await uploadRow(page, upload)))
    await navigate(page, URLS.upload, context.timeoutMs);
  await dismissMarketing(page);
  const row = await uploadRow(page, upload);
  if (!row)
    return handoff("UPLOAD_NOT_FOUND", "未找到本任务上传记录。", { upload });
  const ready = await visible(row.getByText("立即下单", { exact: true }));
  if (
    !ready ||
    (await row.locator('[title="处理成功"],[title="解析成功"]').count()) === 0
  )
    return readUpload(page, context);
  const popupPromise = page
    .waitForEvent("popup", { timeout: 5000 })
    .catch(() => null);
  await ready.click();
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded");
    if (!trusted(popup.url()))
      return handoff("UNEXPECTED_ORIGIN", "文件参数页面进入了未识别的站点。");
    await waitForForm(popup, context.timeoutMs, true);
    await page.goto(popup.url(), { waitUntil: "domcontentloaded" });
    await waitForForm(page, context.timeoutMs, true);
    const transfer = await waitUntil(
      async () => ({
        expected: await discoverParameters(popup),
        observed: await discoverParameters(page),
      }),
      ({ expected, observed }) => paramsHash(observed) === paramsHash(expected),
      Math.min(context.timeoutMs, 5000),
    );
    if (paramsHash(transfer.observed) !== paramsHash(transfer.expected))
      return handoff(
        "FORM_SESSION_TRANSFER_FAILED",
        "文件参数页面在复用会话时状态不一致；新窗口保留供接管。",
        { upload, newPageUrl: cleanUrl(popup.url()) },
      );
    await popup.close();
  }
  await waitForForm(page, context.timeoutMs);
  upload.formPageIdentity = formIdentity(page.url());
  upload.formParametersHash = paramsHash(await discoverParameters(page));
  return null;
}
async function options(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  if (getUpload(context) || !(await page.locator("#leftcontent").count())) {
    const opened = await openUploadedForm(page, context);
    if (opened) return opened;
  }
  const parameters = await discoverParameters(page);
  if (!parameters.length)
    return handoff("PARAMETERS_UNAVAILABLE", "页面没有识别到下单参数。");
  return ok({
    upload: getUpload(context),
    parameters,
    parametersHash: paramsHash(parameters),
    decisions: obj(context.previous?.decisions),
    coverage:
      "当前流程所有可见原生控件及 JLC 自定义选项；设置后重新发现条件字段",
    dependencies: "仅报告页面实际显现及变化，不推测隐藏组合",
  });
}
async function setParameters(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  if (getUpload(context) || !(await page.locator("#leftcontent").count())) {
    const opened = await openUploadedForm(page, context);
    if (opened) return opened;
  }
  const requested = obj(context.input.params);
  if (!Object.keys(requested).length)
    return problem(
      "needs_input",
      "PARAMETERS_REQUIRED",
      "请传入要设置的参数；使用 pcb options 获取实际 key 与候选值。",
    );
  const prior = await discoverParameters(page);
  const decisions = { ...obj(context.previous?.decisions) };
  const changes: Json[] = [];
  await dismissMarketing(page);
  for (const [key, value] of Object.entries(requested)) {
    const current = await discoverParameters(page);
    const p = current.find((p) => p.key === key);
    if (!p)
      return problem(
        "needs_input",
        "PARAMETER_NOT_AVAILABLE",
        `参数 ${key} 当前不可用；可能受其他参数影响。`,
        { parameters: current, changes },
      );
    if (p.disabled)
      return problem(
        "needs_input",
        "PARAMETER_DISABLED",
        `参数 ${key} 被网站禁用。`,
        { parameter: p, changes },
      );
    if (
      norm(p.value) === norm(value) &&
      (p.kind !== "checkbox" || typeof value === "boolean")
    ) {
      decisions[key] = {
        value: p.value,
        source: context.input.mode === "auto" ? "ai" : "user",
        at: new Date().toISOString(),
      };
      changes.push({ key, before: p.value, after: p.value });
      continue;
    }
    const target = page.locator(p.selector);
    if (p.kind === "choice") {
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const desired of values) {
        const choice = p.choices.find(
          (c) => c.value === desired || c.label === desired,
        );
        if (!choice || choice.disabled)
          return problem(
            "needs_input",
            "INVALID_PARAMETER_VALUE",
            `参数 ${key} 不接受该值。`,
            { parameter: p, requested: value, changes },
          );
        const guaranteeChoice = async (): Promise<Locator | null> =>
          key === "品质赔付服务" && desired.startsWith("按标准合同常规处理")
            ? visible(
                page
                  .locator(".el-dialog:visible")
                  .getByRole("button", { name: /^按标准合约常规处理/ }),
              )
            : key === "是否SMT贴片" && desired === "不需要"
              ? visible(
                  page
                    .locator(".el-dialog:visible")
                    .filter({ hasText: "请选择本单是否需要SMT贴片" })
                    .getByRole("button", {
                      name: "确定，不需要SMT",
                      exact: true,
                    }),
                )
              : null;
        const existingGuarantee = await guaranteeChoice();
        if (existingGuarantee) {
          await existingGuarantee.click();
          continue;
        }
        const plateModal =
          key === "板材类别"
            ? await visible(page.locator(".selectPlateTypeDialog"))
            : null;
        const modalChoice = plateModal
          ? await visible(
              plateModal.locator(".plateTypeBox").filter({
                has: page.locator(".name").filter({
                  hasText: new RegExp(
                    "^" + desired.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
                  ),
                }),
              }),
            )
          : null;
        if (modalChoice) await modalChoice.click();
        else await page.locator(choice.selector).click();
        if (
          (key === "品质赔付服务" &&
            desired.startsWith("按标准合同常规处理")) ||
          (key === "是否SMT贴片" && desired === "不需要")
        ) {
          const confirm = await waitUntil(guaranteeChoice, (v) => !!v, 1000);
          if (confirm) await confirm.click();
        }
      }
    } else if (p.kind === "select") {
      await target.selectOption(String(value));
    } else if (p.kind === "checkbox") {
      if (typeof value !== "boolean")
        return problem(
          "needs_input",
          "INVALID_PARAMETER_VALUE",
          `${key} 必须为布尔值。`,
        );
      await target.setChecked(value);
    } else if (p.kind === "custom") {
      const candidates = page
        .locator(
          '[role="option"],.el-select-dropdown__item,#pcbNumber li.numItem,.pcbNumberList li,.number-list li',
        )
        .filter({
          hasText: new RegExp(
            "^\\s*" +
              String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "\\s*$",
          ),
        });
      if (!(await visible(candidates))) await target.click();
      const candidate = await visible(candidates);
      if (!candidate)
        return handoff(
          "CUSTOM_OPTION_UNAVAILABLE",
          `自定义参数 ${key} 没有找到唯一候选项。`,
          { parameter: p, requested: value },
        );
      await candidate.click();
    } else {
      await target.fill(String(value));
      await target.press("Tab");
    }
    const after = await waitUntil(
      () => discoverParameters(page),
      (a) => norm(a.find((p) => p.key === key)?.value) === norm(value),
      Math.min(context.timeoutMs, 2500),
    );
    const actual = after.find((p) => p.key === key)?.value;
    if (norm(actual) !== norm(value))
      return problem(
        "needs_input",
        "PARAMETER_READBACK_MISMATCH",
        `网站没有保留参数 ${key} 的指定值。`,
        { key, requested: value, actual, parameters: after, changes },
      );
    decisions[key] = {
      value: actual,
      source: context.input.mode === "auto" ? "ai" : "user",
      at: new Date().toISOString(),
    };
    changes.push({ key, before: p.value, after: actual });
    // Allow dependent data requests to reveal their controls before accepting the next requested key.
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const parameters = await discoverParameters(page);
  const conflicts = Object.entries(decisions).flatMap(([key, d]) => {
    const actual = parameters.find((p) => p.key === key);
    return !actual || norm(actual.value) !== norm(obj(d).value)
      ? [{ key, expected: obj(d).value, actual: actual?.value ?? null }]
      : [];
  });
  const data = {
    upload: getUpload(context),
    parameters,
    parametersHash: paramsHash(parameters),
    decisions,
    changes,
    conditionalFields: parameters
      .filter((p) => !prior.some((old) => old.key === p.key))
      .map((p) => p.key),
    conflicts,
    quote: null,
  };
  return conflicts.length
    ? problem(
        "needs_input",
        "PARAMETER_CONFLICT",
        "参数联动改变了先前明确选择的值；需要重新决定。",
        data,
      )
    : ok(data);
}
async function quote(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const opened = await openUploadedForm(page, context);
  if (opened) return opened;
  const upload = getUpload(context);
  if (!upload)
    return problem(
      "needs_input",
      "UPLOAD_CONTEXT_REQUIRED",
      "报价需要对应已解析的上传任务。",
    );
  const parameters = await discoverParameters(page);
  const decisions = obj(context.previous?.decisions);
  const missing = parameters
    .filter(
      (p) =>
        !p.disabled &&
        !(
          p.kind === "text" &&
          !p.required &&
          /备注|选填/.test(p.label) &&
          norm(p.value) === ""
        ) &&
        !Object.hasOwn(decisions, p.key),
    )
    .map((p) => ({
      key: p.key,
      current: p.value,
      choices: p.choices.map((c) => ({ value: c.value, disabled: c.disabled })),
      required: p.required,
    }));
  if (missing.length)
    return problem(
      "needs_input",
      "PARAMETER_DECISIONS_REQUIRED",
      "页面默认值尚未视为用户决定；请显式传入所有影响下单的参数选择。",
      { upload, parameters, decisions, missing },
    );
  const conflicts = parameters.filter(
    (p) =>
      Object.hasOwn(decisions, p.key) &&
      norm(p.value) !== norm(obj(decisions[p.key]).value),
  );
  if (conflicts.length)
    return problem(
      "needs_input",
      "PARAMETER_CONFLICT",
      "页面生效值与已确定参数不同。",
      { conflicts, parameters, upload, decisions },
    );
  let previousPrice = "";
  let stableAt = Date.now();
  let settled = false;
  await waitUntil(
    async () => {
      const value = await page
        .locator("#rightcontent")
        .innerText()
        .catch(() => "");
      const loading =
        (await page
          .locator(
            '#rightcontent .el-loading-mask:visible,#rightcontent .el-loading-spinner:visible,#rightcontent [aria-busy="true"]',
          )
          .count()) > 0;
      if (value !== previousPrice || loading) {
        previousPrice = value;
        stableAt = Date.now();
      }
      settled = !!value && !loading && Date.now() - stableAt >= 1000;
      return settled;
    },
    (value) => value,
    Math.max(context.timeoutMs, 1500),
  );
  if (!settled)
    return handoff(
      "QUOTE_CALCULATING",
      "网站计价尚未稳定，暂不采用中间金额。",
      { upload, parameters, decisions },
    );
  const finalParameters = await discoverParameters(page);
  if (paramsHash(finalParameters) !== paramsHash(parameters))
    return problem(
      "needs_input",
      "PARAMETER_CONFLICT",
      "等待报价期间参数发生改变，请重新核对。",
      { upload, parameters: finalParameters, decisions, quote: null },
    );
  const price = previousPrice;
  const selected = await visible(
    page.locator("#rightcontent .multilayer-price-btn.checked"),
  );
  const text = selected ? await selected.innerText() : price;
  const amount =
    text.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/)?.[1]?.replace(/,/g, "") ??
    price
      .match(
        /(?:预估支付总价[^\n]*|总价)\s*[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/,
      )?.[1]
      ?.replace(/,/g, "");
  if (!amount || !Number.isFinite(Number(amount)))
    return handoff("QUOTE_UNAVAILABLE", "网站没有返回可核实的当前报价。", {
      upload,
      parameters,
      decisions,
    });
  const errors = await blockers(page);
  if (errors.length)
    return problem(
      "needs_input",
      "SITE_VALIDATION_FAILED",
      "网站提示当前参数需要处理。",
      { errors, upload, parameters, decisions },
    );
  return ok({
    upload,
    parameters,
    parametersHash: paramsHash(parameters),
    decisions,
    quote: {
      amount: Number(amount).toFixed(2),
      currency: "CNY",
      fileSha256: upload.sha256,
      parametersHash: paramsHash(parameters),
      quotedAt: new Date().toISOString(),
      breakdown: price,
      shippingKnown: !/不含运费|运费另算|运费待定/.test(price),
    },
    stage: "quoted",
    orderCreated: false,
  });
}
async function preview(
  page: Page,
  context: AdapterContext,
  open = true,
): Promise<BusinessResult> {
  const upload = getUpload(context);
  if (!upload)
    return problem(
      "needs_input",
      "UPLOAD_CONTEXT_REQUIRED",
      "预览需要上传任务的文件关联信息。",
    );
  if (open) {
    const opened = await openUploadedForm(page, context);
    if (opened) return opened;
  } else if (
    upload.formPageIdentity !== formIdentity(page.url()) ||
    !(await page.locator("#leftcontent").count())
  )
    return handoff(
      "PREVIEW_FILE_NOT_VERIFIED",
      "请先恢复本次文件参数页；预览核实不会重新打开上传或更改选择。",
      { upload },
    );
  const filename = upload.uploadName.replace(/\.(zip|rar)$/i, "");
  if (
    !(
      await page
        .locator("#rightcontent")
        .innerText()
        .catch(() => "")
    ).includes(filename)
  )
    return handoff(
      "PREVIEW_FILE_NOT_VERIFIED",
      "渲染区域没有显示本次唯一上传文件名。",
      { upload },
    );
  const canvas = await visible(
    page.locator("#rightcontent canvas#smt-engine-canvas"),
  );
  if (!canvas)
    return handoff(
      "PREVIEW_UNAVAILABLE",
      "本次文件没有可核实的官方 PCB 渲染画布；文件类型图标不作为预览。",
      { upload },
    );
  const rendered = await waitUntil(
    async () => {
      // A WebGL renderer may clear its drawing buffer after compositing.
      // Capture the visible canvas, then validate that bitmap, rather than
      // reading the cleared WebGL buffer through drawImage/toDataURL.
      const bitmap = await canvas
        .screenshot({ type: "png", scale: "css", timeout: context.timeoutMs })
        .catch(() => null);
      if (!bitmap) return null;
      return page
        .evaluate(
          async (data) => {
            const source = new Image();
            source.src = data;
            await source.decode();
            if (source.width < 100 || source.height < 100) return null;
            const probe = document.createElement("canvas");
            probe.width = source.width;
            probe.height = source.height;
            const context = probe.getContext("2d")!;
            context.drawImage(source, 0, 0);
            const pixels = context.getImageData(
              0,
              0,
              probe.width,
              probe.height,
            ).data;
            const colors = new Set<string>();
            let colored = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i + 3] === 0) continue;
              colors.add(pixels[i] + "," + pixels[i + 1] + "," + pixels[i + 2]);
              if (
                Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
                  Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >
                30
              )
                colored++;
            }
            return colors.size > 8 && colored > 100
              ? {
                  data,
                  width: source.width,
                  height: source.height,
                  coloredPixels: colored,
                }
              : null;
          },
          `data:image/png;base64,${bitmap.toString("base64")}`,
        )
        .catch(() => null);
    },
    (value) => !!value,
    Math.min(context.timeoutMs, 10000),
  );
  if (!rendered)
    return handoff(
      "PREVIEW_NOT_READY",
      "官方 PCB 画布尚未显示可核实的板图；没有导出空白画布或文件图标。",
      { upload },
    );
  await mkdir(context.artifactDir, { recursive: true });
  const path = join(context.artifactDir, "gerber-preview.png");
  await writeFile(path, Buffer.from(rendered.data.split(",")[1], "base64"));
  return ok({
    upload,
    preview: {
      source: "jlc.com",
      path,
      view: "官方 PCB 仿真画布",
      fileSha256: upload.sha256,
      width: rendered.width,
      height: rendered.height,
      renderedPixels: rendered.coloredPixels,
    },
    parseStatus: "parsed",
  });
}
async function orderCheckDrawer(page: Page): Promise<Locator | null> {
  return visible(
    page.locator(".el-drawer:visible").filter({ hasText: "订单检查" }),
  );
}
async function orderSubmitButton(page: Page): Promise<Locator | null> {
  const drawer = await orderCheckDrawer(page);
  return drawer
    ? visible(drawer.getByRole("button", { name: "确认并提交", exact: true }))
    : visible(page.locator("#submitBtn"));
}
async function check(
  page: Page,
  context: AdapterContext,
  click = true,
): Promise<BusinessResult> {
  const result = await quote(page, context);
  if (result.status !== "succeeded") return result;
  const parameters = result.data.parameters as Parameter[];
  const confirmation = parameters.find((p) => /确认订单方式/.test(p.label));
  if (
    !confirmation ||
    /自动扣款/.test(String(confirmation.value)) ||
    !/手动|自己确认/.test(String(confirmation.value))
  )
    return problem(
      "needs_input",
      "AUTOMATIC_DEBIT_NOT_ALLOWED",
      "提交未付款订单要求明确选择手动确认订单；自动扣款会绕过每次付款确认。",
      { ...result.data, confirmationMode: confirmation?.value ?? null },
    );
  const text = await body(page);
  if (/未检测到收货地址|未检测到联系人|请编辑开票资料/.test(text))
    return problem(
      "needs_input",
      "DELIVERY_INFORMATION_REQUIRED",
      "请明确填写收货地址、联系人或开票资料。",
      result.data,
    );
  if (click && !(await orderCheckDrawer(page))) {
    const button = await visible(
      page.getByRole("button", { name: "检查订单", exact: true }),
    );
    if (!button)
      return handoff(
        "CHECK_UNAVAILABLE",
        "当前页面没有检查订单按钮。",
        result.data,
      );
    await button.click();
  }
  const errors = await blockers(page);
  if (errors.length)
    return problem(
      "needs_input",
      "ORDER_CHECK_FAILED",
      "订单检查存在待解决问题。",
      { ...result.data, errors },
    );
  const data = {
    ...result.data,
    checkedAt: new Date().toISOString(),
    pageUrl: cleanUrl(page.url()),
    delivery: await page
      .locator("#addressAndLinkman,#invoiceType")
      .allTextContents(),
    checkEvidence: click ? "已触发页面检查并读取当前校验提示" : "只读重新核对",
    account: await account(page, true),
  };
  return ok(data);
}
interface OrderInfo {
  orderId: string;
  paymentStatus: "paid" | "unpaid" | "unknown";
  status: string | null;
  amount: string | null;
  text: string;
}
function parseOrder(text: string): OrderInfo | null {
  const orderId = text.match(
    /订单(?:编号|号)\s*[:：]?\s*([A-Za-z]+\d+|\d{6,})\b/,
  )?.[1];
  if (!orderId) return null;
  const unpaid = /未支付|未付款|待付款/.test(text);
  const paid =
    /(?:^|[\s：:])(?:已支付|已付款|付款成功|支付成功)(?:[\s。！]|$)/.test(text);
  return {
    orderId,
    paymentStatus:
      unpaid && paid
        ? "unknown"
        : unpaid
          ? "unpaid"
          : paid
            ? "paid"
            : "unknown",
    status:
      text.match(
        /待付款|待审核|文件审核有问题|生产中|待发货|已发货|已取消|客户确认中/,
      )?.[0] ?? null,
    amount:
      text.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/)?.[1]?.replace(/,/g, "") ??
      null,
    text,
  };
}
async function ordersVisible(page: Page): Promise<OrderInfo[]> {
  const rows = await page.locator(".tableListBox").all();
  const orders: OrderInfo[] = [];
  for (const row of rows)
    if (await row.isVisible()) {
      const parsed = parseOrder(await row.innerText());
      if (parsed) orders.push(parsed);
    }
  return orders;
}
async function findOrder(page: Page, id: string): Promise<Locator | null> {
  const idPattern = new RegExp(
    "订单(?:编号|号)\\s*[:：]?\\s*" +
      id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "(?![A-Za-z0-9])",
  );
  const candidates = page
    .locator(".tableListBox")
    .filter({ hasText: idPattern });
  if ((await candidates.count()) === 1 && (await candidates.isVisible()))
    return candidates;
  return null;
}
async function loadOrder(
  page: Page,
  context: AdapterContext,
): Promise<Locator | null> {
  const id =
    str(context.input.orderId) ||
    str(context.previous?.orderId) ||
    str(obj(context.previous?.binding).orderId);
  if (!id) return null;
  let row = await findOrder(page, id);
  if (row) return row;
  await navigate(page, URLS.orders, context.timeoutMs);
  const search = page.getByPlaceholder("文件名 / 订单编号 / 备忘", {
    exact: true,
  });
  await search.waitFor({ state: "visible", timeout: context.timeoutMs });
  await search.fill(id);
  await clickText(page, "查询");
  return waitUntil(
    () => findOrder(page, id),
    (r) => !!r,
    context.timeoutMs,
  );
}
async function orders(
  page: Page,
  context: AdapterContext,
  operation: Operation,
): Promise<BusinessResult> {
  for (const old of await page
    .locator(".pcb-order-details-modal:visible")
    .all()) {
    const close = await visible(
      old.getByRole("button", { name: "Close", exact: true }),
    );
    if (close) await close.click();
  }
  if (operation === "orders.list") {
    if (
      str(context.input.status).trim() ||
      (context.input.page !== undefined && Number(context.input.page) !== 1)
    )
      return problem(
        "needs_input",
        "ORDER_FILTER_NOT_SUPPORTED",
        "当前版本只读取网站当前列表页；status/page 尚未核实适配，请使用 orderId 精确查询或在页面选择后读取。",
        {
          supportedFilters: ["orderId"],
          requested: { status: context.input.status, page: context.input.page },
        },
      );
    await navigate(page, URLS.orders, context.timeoutMs);
    const list = await waitUntil(
      () => ordersVisible(page),
      (rows) => rows.length > 0,
      Math.min(context.timeoutMs, 5000),
    );
    const id = await accountOn(page);
    if (!id) return loginStatus(page);
    const text = await body(page);
    if (!list.length && !/暂无数据|暂无订单|共\s*0\s*条/.test(text))
      return handoff("ORDER_LIST_UNAVAILABLE", "未找到可核实的订单列表。");
    return ok({
      account: id,
      orders: list,
      page: await page
        .locator(".el-pager .active,.el-pager .is-active")
        .allTextContents(),
      total: Number(text.match(/共\s*(\d+)\s*条/)?.[1] ?? list.length),
      pagination: "当前页面；可传入 orderId 精确查询",
    });
  }
  const row = await loadOrder(page, context);
  if (!row)
    return problem(
      "needs_input",
      "ORDER_NOT_FOUND",
      "当前账号没有找到该订单；请核实订单号及筛选范围。",
    );
  const parsed = parseOrder(await row.innerText())!;
  const action = operation === "orders.progress" ? "进度跟踪" : "订单详情";
  await row.getByText(action, { exact: true }).click();
  const modal = await waitUntil(
    () =>
      visible(
        page.locator(".pcb-order-details-modal,.el-dialog").filter({
          hasText:
            operation === "orders.progress" ? /进度|跟踪/ : /PCB订单详情/,
        }),
      ),
    (v) => !!v,
    5000,
  );
  const orderPattern = new RegExp(
    "订单(?:编号|号)\\s*[:：]?\\s*" + parsed.orderId + "(?![A-Za-z0-9])",
  );
  const detail = modal
    ? await waitUntil(
        () => modal.innerText(),
        (text) =>
          operation === "orders.progress"
            ? text.trim().length > 20
            : orderPattern.test(text),
        context.timeoutMs,
      )
    : null;
  if (!detail)
    return handoff("ORDER_DETAIL_UNAVAILABLE", "订单详情或进度页面没有加载。", {
      ...parsed,
    });
  if (
    operation === "orders.show" &&
    !new RegExp(
      "订单(?:编号|号)\\s*[:：]?\\s*" + parsed.orderId + "(?![A-Za-z0-9])",
    ).test(detail)
  )
    return handoff("ORDER_ID_MISMATCH", "详情页面订单号与请求不一致。", {
      orderId: parsed.orderId,
    });
  return ok({
    ...parsed,
    account: await accountOn(page),
    detail,
    progress: operation === "orders.progress" ? detail : null,
    evidence: "已按列表中的精确订单号打开对应信息",
  });
}
async function submitResult(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const upload = getUpload(context);
  const text = await body(page);
  const id =
    str(context.previous?.orderId) ||
    text.match(
      /(?:订单提交成功|下单成功|提交成功)[\s\S]{0,200}?订单(?:编号|号)\s*[:：]?\s*([A-Za-z]+\d+|\d{6,})\b/,
    )?.[1];
  if (!id)
    return problem(
      "unknown",
      "SUBMIT_RESULT_UNKNOWN",
      "未核实到本次提交产生的订单号；禁止重复提交。",
      { upload, sideEffect: "submit", verificationRequired: true },
    );
  const probe = await page.context().newPage();
  try {
    const row = await loadOrder(probe, {
      ...context,
      input: { ...context.input, orderId: id },
    });
    if (!row)
      return problem(
        "unknown",
        "SUBMIT_ORDER_NOT_VERIFIED",
        "返回的订单号尚不能在订单列表核实。",
        { orderId: id, upload },
      );
    const text = await row.innerText();
    if (
      !upload ||
      !text.includes(upload.uploadName.replace(/\.(zip|rar)$/i, ""))
    )
      return problem(
        "unknown",
        "SUBMIT_FILE_NOT_VERIFIED",
        "订单号存在，但无法核实其与本次上传文件的关联。",
        { orderId: id, upload },
      );
    return ok({
      ...parseOrder(text),
      upload,
      stage: "ordered",
      evidence: "提交成功提示与可查询订单号、本次唯一上传文件名一致",
    });
  } finally {
    await probe.close();
  }
}
async function submit(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const checked = await check(page, context);
  if (checked.status !== "succeeded") return checked;
  const priorQuote = obj(context.previous?.quote);
  const currentQuote = obj(checked.data.quote);
  if (
    !priorQuote.amount ||
    priorQuote.amount !== currentQuote.amount ||
    priorQuote.parametersHash !== currentQuote.parametersHash ||
    priorQuote.fileSha256 !== currentQuote.fileSha256
  )
    return problem(
      "needs_input",
      "QUOTE_CHANGED",
      "提交内容与之前报价不同，请先重新报价并检查。",
      checked.data,
    );
  const button = await orderSubmitButton(page);
  if (!button)
    return handoff(
      "SUBMIT_UNAVAILABLE",
      "没有找到提交订单按钮。",
      checked.data,
    );
  if (!checked.data.account)
    return problem(
      "needs_login",
      "LOGIN_REQUIRED",
      "提交前未能核实当前账号，未发起订单提交。",
      checked.data,
    );
  const binding = {
    account: checked.data.account,
    fileSha256: currentQuote.fileSha256,
    parametersHash: currentQuote.parametersHash,
    amount: currentQuote.amount,
    currency: "CNY",
    paymentMode: "manual",
  };
  await context.beforeEffect("submit", binding);
  try {
    await button.click({ timeout: context.timeoutMs });
    return await waitUntil(
      () => submitResult(page, context),
      (r) => r.status === "succeeded",
      Math.min(context.timeoutMs, 15000),
    );
  } catch {
    return problem(
      "unknown",
      "SUBMIT_RESULT_UNKNOWN",
      "提交动作可能已经生效，必须先核实订单，禁止重复提交。",
      { ...checked.data, binding, sideEffect: "submit" },
    );
  }
}
interface PaymentBinding {
  account: string;
  orderId: string;
  amount: string;
  currency: "CNY";
  method: "balance";
}
async function readPayment(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const expected = obj(context.input.binding ?? context.previous?.binding);
  const id = str(context.input.orderId) || str(expected.orderId);
  if (!id)
    return problem("needs_input", "ORDER_ID_REQUIRED", "请提供唯一订单号。");
  const currentAccount = await accountOn(page);
  if (!currentAccount) return loginStatus(page);
  const modal = await visible(
    page
      .locator('.el-dialog,.el-message-box,[role="dialog"]')
      .filter({ hasText: /余额|账户支付|确认支付/ }),
  );
  if (!modal)
    return handoff(
      "PAYMENT_PANEL_REQUIRED",
      "请在指定订单打开余额支付面板；不会使用全局合并支付。",
      { orderId: id },
    );
  const text = await modal.innerText();
  const ids = [
    ...text.matchAll(
      /(?:订单(?:编号|号)|订单)\s*[:：]?\s*([A-Za-z]+\d+|\d{6,})\b/g,
    ),
  ].map((m) => m[1]);
  if (!ids.length || ids.some((v) => v !== id))
    return handoff(
      "PAYMENT_ORDER_NOT_BOUND",
      "支付面板必须明确显示且只包含指定订单号。",
      { orderId: id, observedOrderIds: ids },
    );
  const amount = text
    .match(
      /(?:应付(?:金额)?|支付金额|合计|总计|需支付)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d{1,2})?)/,
    )?.[1]
    ?.replace(/,/g, "");
  if (!amount)
    return handoff(
      "PAYMENT_AMOUNT_UNAVAILABLE",
      "无法从该订单支付面板确定实际应付金额。",
      { orderId: id },
    );
  const balanceSelected = await modal
    .locator(
      'input:checked,[aria-checked="true"],.checked,.is-checked,.selected,.is-active',
    )
    .allTextContents();
  const radios = await modal
    .locator('input[type="radio"]:checked')
    .evaluateAll((e) => e.map((n) => n.parentElement?.textContent ?? ""));
  if (![...balanceSelected, ...radios].some((t) => /余额|嘉立创账户/.test(t)))
    return problem(
      "needs_input",
      "BALANCE_METHOD_REQUIRED",
      "必须选择嘉立创余额支付方式。",
      { orderId: id, amount },
    );
  if (/余额不足/.test(text))
    return problem("failed", "INSUFFICIENT_BALANCE", "嘉立创余额不足。", {
      orderId: id,
      amount,
    });
  const binding: PaymentBinding = {
    account: currentAccount,
    orderId: id,
    amount: Number(amount).toFixed(2),
    currency: "CNY",
    method: "balance",
  };
  return ok({
    binding,
    orderId: id,
    paymentStatus: "unpaid",
    evidence: "唯一订单的余额支付面板",
    preparedAt: new Date().toISOString(),
  });
}
async function preparePayment(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const existing = await readPayment(page, context);
  if (
    existing.status === "succeeded" ||
    existing.error?.code === "INSUFFICIENT_BALANCE"
  )
    return existing;
  const row = await loadOrder(page, context);
  if (!row)
    return problem(
      "needs_input",
      "ORDER_NOT_FOUND",
      "没有找到指定未付款订单。",
    );
  const parsed = parseOrder(await row.innerText())!;
  if (parsed.paymentStatus === "paid")
    return problem(
      "needs_input",
      "ORDER_ALREADY_PAID",
      "该订单已经支付，不再发起付款。",
      { ...parsed },
    );
  if (parsed.paymentStatus !== "unpaid")
    return handoff("PAYMENT_STATE_UNKNOWN", "该订单付款状态不明确。", {
      ...parsed,
    });
  // Only a preparation action with explicit payment semantics is allowed here. JLC's bare “确认” is not assumed safe.
  const button = await visible(
    row.getByRole("button", { name: /^(去支付|立即支付|支付)$/ }),
  );
  if (button) await button.click();
  else {
    await row.getByText("订单详情", { exact: true }).click();
    const modal = await visible(page.locator(".pcb-order-details-modal"));
    if (
      !modal ||
      !new RegExp(
        "订单编号\\s*[:：]?\\s*" + parsed.orderId + "(?![A-Za-z0-9])",
      ).test(await modal.innerText())
    )
      return handoff("PAYMENT_ORDER_NOT_BOUND", "详情没有确认指定订单号。", {
        orderId: parsed.orderId,
      });
    const go = await visible(
      modal.getByRole("button", { name: "去支付", exact: true }),
    );
    if (!go)
      return handoff(
        "PAYMENT_PREPARATION_UNAVAILABLE",
        "订单没有可识别的支付入口。",
        { orderId: parsed.orderId },
      );
    await go.click();
  }
  const balance = await visible(
    page.getByRole("radio", { name: /嘉立创余额|余额支付|账户余额/ }),
  );
  if (balance) await balance.check();
  return readPayment(page, context);
}
async function paymentResult(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const expected = obj(context.input.binding ?? context.previous?.binding);
  const id = str(expected.orderId) || str(context.input.orderId);
  const row = await findOrder(page, id);
  const parsed = row ? parseOrder(await row.innerText()) : null;
  const accountId = await accountOn(page);
  if (!id || !expected.account || !accountId || accountId !== expected.account)
    return problem(
      "unknown",
      "PAYMENT_ACCOUNT_CHANGED",
      "核实页面账号与付款确认账号不同。",
      { orderId: id, paymentStatus: "unknown" },
    );
  const orderPattern = new RegExp(
    "订单(?:编号|号)\\s*[:：]?\\s*" + rx(id).source + "(?![A-Za-z0-9])",
  );
  const evidence: {
    text: string;
    amount: string | null;
    source: "row" | "dialog";
  }[] = [];
  if (
    row &&
    parsed &&
    (!parsed.amount || Number(parsed.amount) === Number(expected.amount))
  )
    evidence.push({
      text: await row.innerText(),
      amount: parsed.amount,
      source: "row",
    });
  const dialogs = await page
    .locator(
      '.el-dialog:visible,.el-message-box:visible,[role="dialog"]:visible',
    )
    .all();
  for (const dialog of dialogs) {
    const text = await dialog.innerText();
    const amount = text.match(/[¥￥]\s*([\d.]+)/)?.[1] ?? null;
    if (
      !orderPattern.test(text) ||
      (amount && Number(amount) !== Number(expected.amount))
    )
      continue;
    const orderIds = [
      ...text.matchAll(/订单(?:编号|号)\s*[:：]?\s*([A-Za-z]+\d+|\d{6,})\b/g),
    ].map((match) => match[1]);
    if (orderIds.some((orderId) => orderId !== id)) continue;
    evidence.push({ text, amount, source: "dialog" });
  }
  // A full status line is evidence; prose such as “支付成功后开始审核” is not.
  const paidStatus =
    /^(?:(?:支付|付款)(?:状态|结果)\s*[:：]?\s*)?(?:支付成功|付款成功|已支付|已付款)\s*[。！!]?$/;
  const paid = evidence.filter((item) =>
    item.text
      .split(/[\r\n]+/)
      .some(
        (line, index, lines) =>
          paidStatus.test(line.trim()) &&
          !/^(?:后|以后|之后|时|才可|才能|才会|方可|即可)/.test(
            lines[index + 1]?.trim() ?? "",
          ) &&
          !/(?:如果|若|一旦|当)\s*$/.test(lines[index - 1] ?? ""),
      ),
  );
  const negative = evidence.some((item) =>
    /未支付|未付款|待支付|待付款|支付失败|付款失败|扣款失败|支付未成功|付款未成功/.test(
      item.text,
    ),
  );
  const failed = evidence.some((item) =>
    /支付失败|付款失败|扣款失败|支付未成功|付款未成功/.test(item.text),
  );
  const successMention = evidence.some((item) =>
    /支付成功|付款成功|已支付|已付款/.test(item.text),
  );
  if (
    (paid.length > 0 && negative) ||
    failed ||
    (successMention && !paid.length)
  )
    return problem(
      "unknown",
      "PAYMENT_STATE_UNVERIFIED",
      "当前订单没有独立、无冲突的付款成功状态；说明文字不作为付款证据。",
      {
        taskId: context.taskId,
        orderId: id,
        paymentStatus: "unknown",
        binding: expected,
        verificationRequired: true,
      },
    );
  const confirmed = paid[0];
  if (confirmed)
    return ok({
      taskId: context.taskId,
      orderId: id,
      paymentStatus: "paid",
      account: accountId,
      amount: confirmed.amount,
      method:
        confirmed.source === "dialog" && /余额/.test(confirmed.text)
          ? "balance"
          : null,
      evidence:
        confirmed.source === "row"
          ? "指定订单行显示独立已付款状态，当前同单页面没有矛盾状态"
          : norm(confirmed.text),
    });
  return problem(
    "unknown",
    "PAYMENT_RESULT_UNKNOWN",
    "没有核实到指定订单的付款成功状态；不重复扣款。",
    {
      taskId: context.taskId,
      orderId: id,
      paymentStatus: "unknown",
      binding: expected,
      sideEffect: "pay",
      verificationRequired: true,
    },
  );
}
async function executePayment(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const prepared = await readPayment(page, context);
  if (prepared.status !== "succeeded") return prepared;
  const binding = prepared.data.binding as unknown as PaymentBinding;
  const expected = obj(context.input.binding ?? context.previous?.binding);
  if (
    !["account", "orderId", "amount", "currency", "method"].every(
      (k) => expected[k] === binding[k as keyof PaymentBinding],
    )
  )
    return problem(
      "needs_confirmation",
      "PAYMENT_BINDING_CHANGED",
      "账号、订单、金额或方式已改变，原付款确认不可使用。",
      prepared.data,
    );
  const modal = await visible(
    page.locator('.el-dialog,.el-message-box,[role="dialog"]').filter({
      hasText: new RegExp(
        "订单(?:编号|号)\\s*[:：]?\\s*" + binding.orderId + "(?![A-Za-z0-9])",
      ),
    }),
  );
  if (!modal)
    return handoff(
      "PAYMENT_PANEL_REQUIRED",
      "找不到绑定订单的支付面板。",
      prepared.data,
    );
  const button = await visible(
    modal.getByRole("button", {
      name: /^(确认支付|余额支付|确认付款|立即付款)$/,
    }),
  );
  if (!button)
    return handoff(
      "PAYMENT_BUTTON_UNAVAILABLE",
      "没有找到明确的最终余额付款按钮。",
      prepared.data,
    );
  await context.beforeEffect("pay", { ...binding });
  try {
    await button.click({ timeout: context.timeoutMs });
    return await waitUntil(
      () =>
        paymentResult(page, {
          ...context,
          previous: { ...context.previous, binding },
        }),
      (r) => r.status === "succeeded",
      context.timeoutMs,
    );
  } catch {
    return problem(
      "unknown",
      "PAYMENT_RESULT_UNKNOWN",
      "付款动作可能已经生效，需核实指定订单；不重复扣款。",
      { ...prepared.data, sideEffect: "pay" },
    );
  }
}
async function chatFrame(page: Page): Promise<Surface | null> {
  return (
    page.frames().find((f) => {
      try {
        return new URL(f.url()).hostname === "acsa.jlc.com";
      } catch {
        return false;
      }
    }) ??
    ((await page.locator('textarea[placeholder="输入消息..."]').count())
      ? page
      : null)
  );
}
async function chatResult(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const frame = await chatFrame(page);
  const prior = obj(context.previous?.chat);
  if (!frame) return handoff("CHAT_UNAVAILABLE", "嘉小智对话框未加载。");
  const count = Number(prior.beforeReplies);
  const replies = frame.locator(".ai-message-container");
  if (!Number.isFinite(count))
    return handoff("CHAT_CONTEXT_REQUIRED", "缺少本次消息的回复关联信息。");
  if ((await replies.count()) <= count)
    return handoff("CHAT_REPLY_PENDING", "消息已发送，等待嘉小智回复。", {
      chat: prior,
      sendStatus: "sent",
      replyStatus: "generating",
    });
  const reply = replies.nth(count);
  const complete =
    (await reply
      .getByRole("button", { name: "复制内容", exact: true })
      .count()) > 0;
  const answer = await reply.innerText();
  return complete
    ? ok({
        chat: prior,
        message: str(prior.message),
        reply: answer,
        sendStatus: "sent",
        replyStatus: "complete",
        authority: "嘉小智回复不构成用户参数决定或付款授权",
      })
    : handoff("CHAT_REPLY_PENDING", "嘉小智回复尚未完成。", {
        chat: prior,
        sendStatus: "sent",
        replyStatus: "generating",
        partialReply: answer,
      });
}
async function chat(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const message = str(context.input.message);
  if (!message.trim())
    return problem(
      "needs_input",
      "MESSAGE_REQUIRED",
      "请提供要发送给嘉小智的消息。",
    );
  await clickText(page, "AI客服");
  let frame = await chatFrame(page);
  if (!frame) {
    await navigate(page, URLS.member, context.timeoutMs);
    await clickText(page, "AI客服");
    frame = await chatFrame(page);
  }
  if (!frame) return handoff("CHAT_UNAVAILABLE", "未找到官方嘉小智对话页面。");
  const composer = await visible(
    frame.getByPlaceholder("输入消息...", { exact: true }),
  );
  if (!composer)
    return handoff("CHAT_COMPOSER_UNAVAILABLE", "嘉小智输入框尚未准备好。");
  const chat = {
    message,
    beforeReplies: await frame.locator(".ai-message-container").count(),
    sentAt: new Date().toISOString(),
  };
  await composer.fill(message);
  await composer.press("Enter");
  return waitUntil(
    () =>
      chatResult(page, { ...context, previous: { ...context.previous, chat } }),
    (r) => r.status === "succeeded",
    context.timeoutMs,
  );
}
async function accountInfo(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  await navigate(page, URLS.account, context.timeoutMs);
  const id = await waitUntil(
    () => accountOn(page),
    (v) => !!v,
    Math.min(context.timeoutMs, 5000),
  );
  if (!id) return loginStatus(page);
  const field = async (label: string): Promise<string | null> => {
    const labels = page.locator(".el-form-item").filter({
      has: page
        .locator("label")
        .filter({ hasText: new RegExp("^" + label + "[：:]?$") }),
    });
    if ((await labels.count()) !== 1) return null;
    const value = await labels
      .locator(".el-form-item__content")
      .innerText()
      .catch(() => "");
    return (
      norm(value)
        .replace(/(?:修改|绑定|解绑|编辑)\s*$/, "")
        .trim() || null
    );
  };
  return ok({
    account: id,
    customerCode: id,
    phone: await field("联系电话"),
    mobile: await field("绑定手机"),
    email: await field("绑定邮箱"),
    contact: await field("联系人"),
    unavailableRepresentation: null,
    evidence: "当前账号信息页的对应字段；脱敏值原样返回",
  });
}
/** A resume request is advisory; the engine retains the profile lock and all authorization gates. */
function resumeReady(data: Json): BusinessResult {
  return {
    ...handoff("RESUME_READY", "已核实阻塞已解决，可继续原任务。", data),
    resume: true,
  };
}
async function verifyRecoveryContext(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult | null> {
  const upload = getUpload(context);
  if (
    !upload ||
    !upload.formPageIdentity ||
    upload.formPageIdentity !== formIdentity(page.url())
  )
    return handoff(
      "FILE_CONTEXT_CHANGED",
      "接管后的参数页未能核实为原上传文件，不能自动继续。",
      { upload, quote: null },
    );
  if (!(await page.locator("#leftcontent").count()))
    return handoff("PARAMETERS_UNAVAILABLE", "原文件参数页仍未准备好。", {
      upload,
    });
  const expected = str(context.previous?.account) || upload.account;
  if (!expected)
    return problem(
      "needs_input",
      "ACCOUNT_CONTEXT_REQUIRED",
      "原任务缺少基准账号，不能在恢复时假定当前账号相同。",
      { upload },
    );
  const current = await account(page, true);
  if (!current)
    return handoff("LOGIN_INTERACTION_REQUIRED", "等待原账号重新登录。", {
      upload,
    });
  if (current !== expected)
    return problem(
      "needs_input",
      "ACCOUNT_CONTEXT_CHANGED",
      "当前账号不同于原任务账号，不能继续原任务。",
      {
        upload,
        expectedAccount: expected,
        currentAccount: current,
        quote: null,
      },
    );
  return null;
}
async function reconcileSubmit(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  if (context.effectStarted !== false) return submitResult(page, context);
  const blocked = await verifyRecoveryContext(page, context);
  if (blocked) return blocked;
  const checked = await check(page, context, false);
  if (checked.status !== "succeeded") return checked;
  const baselineAccount =
    str(context.previous?.account) || getUpload(context)?.account;
  if (!checked.data.account || checked.data.account !== baselineAccount)
    return handoff(
      "ACCOUNT_CONTEXT_CHANGED",
      "再次核对账号时状态已改变，不能自动继续。",
      { ...checked.data, quote: null },
    );
  const oldQuote = obj(context.previous?.quote);
  const currentQuote = obj(checked.data.quote);
  if (
    !oldQuote.amount ||
    !["amount", "currency", "parametersHash", "fileSha256"].every(
      (key) => oldQuote[key] === currentQuote[key],
    )
  )
    return problem(
      "needs_input",
      "QUOTE_CHANGED",
      "恢复后的文件、参数或报价与原任务不一致，需要重新报价。",
      { ...checked.data, quote: null, previousQuote: oldQuote },
    );
  const submitButton = await orderSubmitButton(page);
  if (!submitButton || !(await submitButton.isEnabled()))
    return handoff("SUBMIT_UNAVAILABLE", "提交按钮仍未可用。", checked.data);
  return resumeReady({
    ...checked.data,
    quote: oldQuote,
    recoveryEvidence: "同账号、同上传页面、显式参数及原报价全部一致",
  });
}
async function reconcilePayment(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const result = await paymentResult(page, context);
  if (
    result.status === "succeeded" ||
    context.effectStarted !== false ||
    result.error?.code === "PAYMENT_STATE_UNVERIFIED"
  )
    return result;
  const prepared = await readPayment(page, context);
  if (prepared.status !== "succeeded") return prepared;
  const expected = obj(context.input.binding ?? context.previous?.binding);
  const current = obj(prepared.data.binding);
  const currentAccount = await account(page, true);
  if (!currentAccount)
    return handoff(
      "LOGIN_INTERACTION_REQUIRED",
      "恢复余额支付前尚未核实当前登录账号。",
    );
  if (currentAccount !== expected.account)
    return problem(
      "needs_confirmation",
      "PAYMENT_BINDING_CHANGED",
      "恢复后的登录账号与付款授权不同，需要重新确认。",
      { ...prepared.data, currentAccount },
    );
  if (
    !["account", "orderId", "amount", "currency", "method"].every(
      (key) => expected[key] === current[key],
    )
  )
    return problem(
      "needs_confirmation",
      "PAYMENT_BINDING_CHANGED",
      "恢复后的账号、订单、金额或方式改变，需要重新确认。",
      prepared.data,
    );
  const id = str(current.orderId);
  const modal = await visible(
    page.locator('.el-dialog,.el-message-box,[role="dialog"]').filter({
      hasText: new RegExp(
        "订单(?:编号|号)\\s*[:：]?\\s*" + id + "(?![A-Za-z0-9])",
      ),
    }),
  );
  const button = modal
    ? await visible(
        modal.getByRole("button", {
          name: /^(确认支付|余额支付|确认付款|立即付款)$/,
        }),
      )
    : null;
  if (!button || !(await button.isEnabled()))
    return handoff(
      "PAYMENT_BUTTON_UNAVAILABLE",
      "已绑定订单的余额付款按钮仍不可用。",
      prepared.data,
    );
  return resumeReady({
    ...prepared.data,
    recoveryEvidence:
      "原账号、唯一订单、金额及余额方式一致；执行前仍需验证付款审批",
  });
}
function acceptsRequestedValue(parameter: Parameter, value: unknown): boolean {
  if (parameter.disabled) return false;
  if (parameter.kind === "checkbox") return typeof value === "boolean";
  if (
    parameter.kind === "choice" ||
    parameter.kind === "select" ||
    parameter.kind === "custom"
  ) {
    const requested = Array.isArray(value) ? value : [value];
    return (
      requested.length > 0 &&
      requested.every((v) =>
        parameter.choices.some(
          (c) =>
            !c.disabled && (c.value === String(v) || c.label === String(v)),
        ),
      )
    );
  }
  if (typeof value !== "string" && typeof value !== "number") return false;
  const min = parameter.constraints.min,
    max = parameter.constraints.max;
  if (
    parameter.kind === "number" &&
    (!Number.isFinite(Number(value)) ||
      (min !== null && min !== undefined && Number(value) < Number(min)) ||
      (max !== null && max !== undefined && Number(value) > Number(max)))
  )
    return false;
  return true;
}
async function reconcileParameters(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  const blocked = await verifyRecoveryContext(page, context);
  if (blocked) return blocked;
  const parameters = await discoverParameters(page);
  const requested = obj(context.input.params);
  const decisions = obj(context.previous?.decisions);
  if (!Object.keys(requested).length)
    return problem(
      "needs_input",
      "PARAMETERS_REQUIRED",
      "原任务未保留明确参数请求，不能自动填写。",
    );
  const priorConflicts = Object.entries(decisions).filter(
    ([key, value]) =>
      !Object.hasOwn(requested, key) &&
      norm(parameters.find((p) => p.key === key)?.value) !==
        norm(obj(value).value),
  );
  if (priorConflicts.length)
    return problem(
      "needs_input",
      "PARAMETER_CONFLICT",
      "接管改变了原任务之外的明确选择，不能自动覆盖。",
      { parameters, conflicts: priorConflicts, quote: null },
    );
  const pending = Object.entries(requested).filter(
    ([key, value]) =>
      norm(parameters.find((p) => p.key === key)?.value) !== norm(value),
  );
  if (!pending.length)
    return ok({
      ...context.previous,
      parameters,
      parametersHash: paramsHash(parameters),
      quote: null,
      decisions: {
        ...decisions,
        ...Object.fromEntries(
          Object.entries(requested).map(([key, value]) => [
            key,
            { value, source: context.input.mode === "auto" ? "ai" : "user" },
          ]),
        ),
      },
    });
  const unavailable = pending.filter(([key, value]) => {
    const parameter = parameters.find((p) => p.key === key);
    return !parameter || !acceptsRequestedValue(parameter, value);
  });
  if (context.effectStarted !== false || unavailable.length)
    return handoff(
      "PARAMETER_READBACK_MISMATCH",
      "原请求参数尚未具备安全自动继续的条件。",
      { parameters, pending, unavailable },
    );
  return resumeReady({
    ...context.previous,
    parameters,
    pending,
    quote: null,
    recoveryEvidence: "原文件与账号一致；仅继续原始显式参数请求",
  });
}
async function reconcileUpload(
  page: Page,
  context: AdapterContext,
): Promise<BusinessResult> {
  if (getUpload(context)) return readUpload(page, context);
  const file = str(context.input.file);
  if (!file)
    return problem(
      "needs_input",
      "UPLOAD_CONTEXT_REQUIRED",
      "没有保留原始上传文件路径，无法核实已有上传。",
    );
  try {
    const resolved = resolve(file);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    const bytes = await readFile(resolved);
    const upload: Upload = {
      taskId: context.taskId,
      fileName: basename(resolved),
      uploadName: `fabrelay-${context.taskId.slice(0, 12)}-${basename(resolved)}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      uploadedAt: "unknown",
      pageUrl: URLS.upload,
      account: (await accountOn(page)) ?? undefined,
    };
    // Interrupted legacy tasks may not have saved their upload metadata yet.
    // Match exactly one visible record across both names; never resend the file.
    const candidateUploadNames = [
      upload.uploadName,
      `jlc-cli-${context.taskId.slice(0, 12)}-${basename(resolved)}`,
    ];
    const matches: string[] = [];
    for (const name of candidateUploadNames) {
      const rows = page
        .locator("tr")
        .filter({ hasText: name.replace(/\.(zip|rar)$/i, "") });
      for (const row of await rows.all())
        if (await row.isVisible()) matches.push(name);
    }
    if (matches.length !== 1)
      return handoff(
        "UPLOAD_NOT_FOUND",
        "当前页面未能唯一识别本次上传；保留新旧文件名候选，等待核实，未重新上传。",
        { candidateUploadNames },
      );
    upload.uploadName = matches[0];
    return readUpload(page, {
      ...context,
      previous: { ...context.previous, upload },
    });
  } catch {
    return problem(
      "needs_input",
      "FILE_UNREADABLE",
      "原始上传文件已不可读取，不能重建文件关联；未重新发送文件。",
    );
  }
}
export const siteAdapter: SiteAdapter = {
  async run(operation, page, context) {
    page.setDefaultTimeout(Math.min(context.timeoutMs, 10000));
    try {
      if (page.url() === "about:blank")
        await navigate(
          page,
          operation.startsWith("pcb.") ? URLS.upload : URLS.member,
          context.timeoutMs,
        );
      if (!trusted(page.url()))
        return handoff(
          "UNEXPECTED_ORIGIN",
          "当前页面不在 jlc.com 官方 HTTPS 站点，未继续业务操作。",
          { pageUrl: cleanUrl(page.url()) },
        );
      switch (operation) {
        case "auth.login":
          return await login(page, context);
        case "auth.status":
          await page.goto(URLS.member, {
            waitUntil: "domcontentloaded",
            timeout: context.timeoutMs,
          });
          await waitUntil(
            () => accountOn(page),
            (v) => !!v,
            3000,
          );
          return await loginStatus(page);
        case "account.show":
          return await accountInfo(page, context);
        case "pcb.upload":
          return await uploadFile(page, context);
        case "pcb.options":
          return await options(page, context);
        case "pcb.set":
          return await setParameters(page, context);
        case "pcb.preview":
          return await preview(page, context);
        case "pcb.quote":
          return await quote(page, context);
        case "pcb.check":
          return await check(page, context);
        case "pcb.submit":
          return await submit(page, context);
        case "orders.list":
        case "orders.show":
        case "orders.progress":
          return await orders(page, context, operation);
        case "payment.prepare":
          return await preparePayment(page, context);
        case "payment.execute":
          return await executePayment(page, context);
        case "xiaozhi.ask":
          return await chat(page, context);
      }
    } catch (error) {
      // Authorization callbacks deliberately escape; only the engine can classify/record confirmation failures.
      if (
        error instanceof Error &&
        /confirm|authoriz|permission|批准|授权|确认/i.test(
          error.name + " " + error.message,
        )
      )
        throw error;
      return handoff(
        "PAGE_OPERATION_INTERRUPTED",
        "页面操作未达到预期状态；保留当前页面供核实。",
        {
          operation,
          pageUrl: cleanUrl(page.url()),
          cause: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
  },
  async reconcile(operation, page, context) {
    try {
      if (!trusted(page.url()))
        return handoff("UNEXPECTED_ORIGIN", "接管后的页面不在官方站点。");
      switch (operation) {
        case "auth.login":
          return await reconcileLogin(page, context);
        case "auth.status":
          return await loginStatus(page);
        case "pcb.submit":
          return await reconcileSubmit(page, context);
        case "payment.execute":
          return await reconcilePayment(page, context);
        case "payment.prepare":
          return await readPayment(page, context);
        case "pcb.upload":
          return await reconcileUpload(page, context);
        case "xiaozhi.ask":
          return await chatResult(page, context);
        case "pcb.set":
          return await reconcileParameters(page, context);
        case "pcb.options": {
          const parameters = await discoverParameters(page);
          return parameters.length
            ? ok({
                ...context.previous,
                parameters,
                parametersHash: paramsHash(parameters),
              })
            : handoff("PARAMETERS_UNAVAILABLE", "参数页仍未准备好。");
        }
        case "pcb.quote":
        case "pcb.check":
          if (!(await page.locator("#leftcontent").count()))
            return handoff(
              "PARAMETERS_UNAVAILABLE",
              "请先打开本次文件参数页。",
            );
          if (getUpload(context)?.formPageIdentity !== formIdentity(page.url()))
            return handoff(
              "FILE_CONTEXT_CHANGED",
              "当前页面尚未核实为本次上传文件参数页。",
              { upload: getUpload(context), quote: null },
            );
          return operation === "pcb.quote"
            ? await quote(page, context)
            : await check(page, context, false);
        case "orders.list": {
          const accountId = await accountOn(page);
          if (!accountId) return loginStatus(page);
          const orders = await ordersVisible(page);
          return orders.length
            ? ok({ orders, account: accountId })
            : handoff("ORDER_LIST_UNAVAILABLE", "订单列表仍未准备好。");
        }
        case "orders.show":
        case "orders.progress": {
          const id = str(context.input.orderId);
          const modal = await visible(
            page.locator(".el-dialog").filter({ hasText: rx(id) }),
          );
          return modal
            ? ok({ orderId: id, detail: await modal.innerText() })
            : handoff("ORDER_DETAIL_UNAVAILABLE", "尚未读取到请求订单的信息。");
        }
        case "account.show": {
          const state = await loginStatus(page);
          return state.status === "succeeded"
            ? ok({ ...state.data, phone: null, mobile: null })
            : state;
        }
        case "pcb.preview":
          return await preview(page, context, false);
      }
    } catch {
      return handoff(
        "RECONCILIATION_INTERRUPTED",
        "状态核实暂时无法完成，未重复写操作。",
      );
    }
  },
};
