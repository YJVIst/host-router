// Real Chromium acceptance, isolated configuration; no production services touched.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../web-panel/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const { expect } = require("@playwright/test");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-router-browser-"));
const repo = path.resolve(new URL("..", import.meta.url).pathname);
const bin =
  process.env.HOST_ROUTER_BIN || path.join(repo, "target/release/host-router");
const artifacts = process.env.HOST_ROUTER_SCREENSHOTS || root;
fs.mkdirSync(artifacts, { recursive: true });
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const port = await freePort(),
  front = await freePort(),
  target = await freePort();
const cfg = path.join(root, "config.json"),
  data = path.join(root, "data");
execFileSync(bin, ["-c", cfg, "init"]);
execFileSync(bin, ["panel-init", "--data-dir", data]);
const credentials = fs.readFileSync(
  path.join(data, "管理员登录信息.txt"),
  "utf8",
);
const username = credentials.split("管理员账号：")[1].split("\n")[0];
const password = credentials.split("初始密码：")[1].split("\n")[0];
let processes = [];
function start(args) {
  const fd = fs.openSync(
    path.join(root, `process-${processes.length}.log`),
    "w",
  );
  const p = spawn(bin, args, { stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  processes.push(p);
  return p;
}
start(["-c", cfg, "serve"]);
const base = `http://127.0.0.1:${port}/console/`;
start([
  "-c",
  cfg,
  "panel",
  "--data-dir",
  data,
  "--listen",
  `127.0.0.1:${port}`,
  "--origin",
  `http://127.0.0.1:${port}`,
  "--base-path",
  "/console/",
]);
let browser;
const checks = [];
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("Content Security Policy"))
      errors.push(m.text());
  });
  await page.goto(base);
  await page.screenshot({
    path: path.join(artifacts, "host-router-login.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByPlaceholder("输入管理员账号").fill(username);
  await page.getByPlaceholder("输入登录密码").fill(password);
  await page.getByRole("button", { name: "登录控制中心" }).click();
  await expect(page.getByRole("heading", { name: "网络总览" })).toBeVisible();
  await expect(page.getByText("转发内核在线", { exact: true })).toBeVisible();
  pass("browser login and real core status");
  await page.locator('[data-action="tcp-details"]').click();
  await expect(
    page.getByRole("heading", { name: "TCP 异常分类" }),
  ).toBeVisible();
  await expect(page.locator(".failure-item")).toHaveCount(9);
  await page.locator("#dialog-form button[type=submit]").click();

  await page
    .locator(".page-head")
    .getByRole("button", { name: "添加规则" })
    .click();
  await page.locator("input[name=listen]").fill(`127.0.0.1:${front}`);
  await page.locator("input[name=domain]").fill("app.example.com");
  await page.locator("input[name=target_host]").fill("127.0.0.1");
  await page.locator("input[name=target_port]").fill(String(target));
  await page.locator("input[name=note]").fill("主站入口");
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect(
    page
      .locator("#content")
      .getByText("app.example.com", { exact: false })
      .first(),
  ).toBeVisible();
  await page.locator("[data-page=rules]").click();
  await page.locator("[data-edit]").first().click();
  await expect(page.locator("input[name=target_host]")).toHaveValue(
    "127.0.0.1",
  );
  await expect(page.locator("input[name=target_port]")).toHaveValue(
    String(target),
  );
  await page
    .locator("input[name=target_host]")
    .fill("backend.example.com:8443");
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.locator("#modal-error")).toContainText("端口请单独填写");
  await page.locator("input[name=target_host]").fill("2001:db8::10");
  await page.locator("input[name=target_port]").fill("8443");
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  expect(JSON.parse(fs.readFileSync(cfg, "utf8")).rules[0].target).toBe(
    "[2001:db8::10]:8443",
  );
  await page.locator("[data-edit]").first().click();
  await expect(page.locator("input[name=target_host]")).toHaveValue(
    "2001:db8::10",
  );
  await expect(page.locator("input[name=target_port]")).toHaveValue("8443");
  await page.locator("input[name=target_host]").fill("127.0.0.1");
  await page.locator("input[name=target_port]").fill(String(target));
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  pass(
    "separate target host/port, IPv6 round-trip and misplaced-port validation",
  );

  await page.getByRole("button", { name: "批量添加" }).click();
  await page
    .locator("textarea[name=lines]")
    .fill(
      `${front} api.example.com 127.0.0.1 ${target}\n${front} *.example.org 127.0.0.1 ${target}`,
    );
  // Use explicit address to avoid conflicting wildcard/specific listeners.
  await page
    .locator("textarea[name=lines]")
    .fill(
      `127.0.0.1:${front} api.example.com 127.0.0.1 ${target}\n127.0.0.1:${front} *.example.org 127.0.0.1 ${target}`,
    );
  await page.getByRole("button", { name: "校验并添加" }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect(page.locator("#rules-list tbody tr")).toHaveCount(3);
  await page
    .getByRole("button", { name: "编辑 api.example.com", exact: true })
    .click();
  await page
    .locator("input[name=note]")
    .fill("<img src=x onerror=window.bad=1>");
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  expect(await page.evaluate(() => window.bad)).toBeUndefined();
  expect(await page.locator("#rules-list img").count()).toBe(0);
  pass("create, batch-add, edit rules; untrusted notes rendered as text");
  await page.getByRole("textbox", { name: "搜索规则" }).fill("api.example");
  await expect(page.locator("#rules-list tbody tr")).toHaveCount(1);
  await page.getByRole("textbox", { name: "搜索规则" }).fill("");
  await page.getByRole("combobox", { name: "协议筛选" }).selectOption("tcp");
  await expect(page.getByText("没有匹配的规则")).toBeVisible();
  await page.getByRole("combobox", { name: "协议筛选" }).selectOption("all");
  await expect(page.locator("#rules-list tbody tr")).toHaveCount(3);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const file = await downloadEvent;
  await file.saveAs(path.join(root, "export.json"));
  const exported = JSON.parse(
    fs.readFileSync(path.join(root, "export.json"), "utf8"),
  );
  expect(exported.rules.length).toBe(3);
  pass("rule search, protocol filter and configuration download");
  await page
    .getByRole("checkbox", { name: "选择 api.example.com", exact: true })
    .check();
  await page.getByRole("button", { name: "删除选中" }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect(page.locator("#rules-list tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "导入配置", exact: true }).click();
  await page
    .locator("#config-file")
    .setInputFiles(path.join(root, "export.json"));
  await expect(page.locator("#import-preview")).toContainText("校验通过");
  await page
    .getByRole("checkbox", { name: "我确认用此文件替换当前配置" })
    .check();
  await page.getByRole("button", { name: "校验并导入" }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect(page.locator("#rules-list tbody tr")).toHaveCount(3);
  pass("selected deletion and validated JSON import");
  await page.locator("[data-page=backups]").click();
  await expect(page.locator("[data-restore]").first()).toBeVisible();
  await page.locator("[data-restore]").first().click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  expect(JSON.parse(fs.readFileSync(cfg, "utf8")).rules.length).toBe(2);
  pass("browser backup restore reaches the core");
  await page.locator("[data-page=settings]").click();
  await page.locator("input[name=dns_refresh_seconds]").fill("45");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("配置已生效");
  expect(JSON.parse(fs.readFileSync(cfg, "utf8")).dns_refresh_seconds).toBe(45);
  await page.locator("[data-page=activity]").click();
  await expect(
    page.getByRole("heading", { name: "配置已更新" }).first(),
  ).toBeVisible();
  await page.locator("[data-page=overview]").click();
  await page.screenshot({
    path: path.join(artifacts, "host-router-overview.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.locator("[data-page=rules]").click();
  await page.screenshot({
    path: path.join(artifacts, "host-router-rules.png"),
    fullPage: true,
    animations: "disabled",
  });
  pass("settings, persistent audit and desktop layouts");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#menu-button").click();
  await page.locator("[data-page=overview]").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(artifacts, "host-router-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  pass("mobile navigation and layout without page overflow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("[data-page=settings]").click();
  await page.locator("input[name=current]").fill(password);
  await page
    .locator("#password-form input[name=password]")
    .fill("browser-test-password-new");
  await page.locator("input[name=confirm]").fill("browser-test-password-new");
  await page.getByRole("button", { name: "更新密码" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  pass("password change logs out current browser");
  expect(errors).toEqual([]);
  pass("no uncaught JavaScript errors or CSP violations");
} finally {
  if (browser) await browser.close();
  for (const p of processes.reverse()) {
    if (p.exitCode == null) {
      p.kill("SIGTERM");
      await new Promise((resolve) => {
        p.once("exit", resolve);
        setTimeout(() => {
          p.kill("SIGKILL");
          resolve();
        }, 5000).unref();
      });
    }
  }
  fs.writeFileSync(
    path.join(root, "report.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log("Browser artifacts:", root);
}
