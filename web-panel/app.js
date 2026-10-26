"use strict";
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const paths = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  routes:
    '<path d="M5 5v14m0-7h8m0-7v14m0-14h6m-6 14h6"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/>',
  backup: '<path d="M4 8V4h16v4M3 8h18v13H3zM9 12h6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-7-4h11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  edit: '<path d="m15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20H4z"/>',
  trash: '<path d="M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  server:
    '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01m5-10h5m-5 10h5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
function icon(n) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[n] || paths.activity}</svg>`;
}
$$("[data-icon]").forEach((e) => (e.innerHTML = icon(e.dataset.icon)));
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (n) => Number(n || 0).toLocaleString("zh-CN");
const bytes = (n) => {
  n = Number(n || 0);
  let i = 0;
  while (n >= 1024 && i < 4) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][i]}`;
};
const stamp = (t) =>
  new Date(t * 1000).toLocaleString("zh-CN", { hour12: false });
let state = {
  page: "overview",
  config: null,
  revision: "",
  session: null,
  status: null,
  samples: [],
  filter: "",
  proto: "all",
  pageIndex: 0,
  selected: new Set(),
  busy: false,
};
let toastTimer;
function toast(text, error = false) {
  clearTimeout(toastTimer);
  const e = $("#toast");
  e.textContent = text;
  e.className = error ? "error" : "";
  e.hidden = false;
  toastTimer = setTimeout(() => (e.hidden = true), 6500);
}
async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "host-router-panel",
    ...(state.session ? { "X-CSRF-Token": state.session.csrf } : {}),
  };
  const r = await fetch(`api/${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const v = await r.json().catch(() => ({ error: `请求失败 (${r.status})` }));
  if (!r.ok) {
    if (r.status === 401 && path !== "login") {
      showLogin();
    }
    throw Error(v.error || `请求失败 (${r.status})`);
  }
  return v;
}
function showLogin() {
  state.session = null;
  $("#app").hidden = true;
  $("#login-screen").hidden = false;
  $("#modal").close();
}
async function loadConfig() {
  const c = await api("config");
  state.config = c.config;
  state.revision = c.revision;
  state.selected.clear();
  $("#nav-count").textContent = c.config.rules.length;
}
async function enter(session) {
  state.session = session;
  $("#username").textContent = session.username;
  await loadConfig();
  $("#login-screen").hidden = true;
  $("#app").hidden = false;
  await poll();
  navigate(location.hash.slice(1) || "overview");
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = $("button", e.target);
  b.disabled = true;
  $("#login-error").textContent = "";
  try {
    const data = Object.fromEntries(new FormData(e.target));
    await api("login", { method: "POST", body: JSON.stringify(data) });
    e.target.reset();
    await enter(await api("me"));
  } catch (e) {
    $("#login-error").textContent = e.message;
  } finally {
    b.disabled = false;
  }
});
$("#logout").onclick = async () => {
  try {
    await api("logout", { method: "POST", body: "{}" });
    showLogin();
  } catch (e) {
    toast(e.message, true);
  }
};
$("#menu-button").onclick = () => $(".sidebar").classList.toggle("open");
const titles = {
  overview: "总览",
  rules: "转发规则",
  backups: "配置备份",
  activity: "操作记录",
  settings: "系统设置",
};
$("#navigation").onclick = (e) => {
  const b = e.target.closest("[data-page]");
  if (b) {
    if (location.hash === `#${b.dataset.page}`) navigate(b.dataset.page);
    else location.hash = b.dataset.page;
  }
};
window.addEventListener("hashchange", () => {
  if (state.session) navigate(location.hash.slice(1));
});
function navigate(page) {
  state.page = titles[page] ? page : "overview";
  $("#breadcrumb").textContent = titles[state.page];
  $$(".nav-item").forEach((e) =>
    e.classList.toggle("active", e.dataset.page === state.page),
  );
  $(".sidebar").classList.remove("open");
  render();
}
function head(title, sub, actions = "") {
  return `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="actions">${actions}</div></div>`;
}
function button(action, text, ic, cl = "") {
  return `<button data-action="${action}" class="${cl}">${ic ? icon(ic) : ""}${text}</button>`;
}
function ruleRows(rules, select = false) {
  return rules
    .map(
      ({ r, i }) =>
        `<tr>${select ? `<td><input type="checkbox" aria-label="选择 ${esc(r.domain)}" data-select="${i}" ${state.selected.has(i) ? "checked" : ""}></td>` : ""}<td class="domain-cell">${esc(r.domain)}<small>${esc(r.note || (r.domain === "*" ? "默认转发" : r.domain.startsWith("*.") ? "通配域名" : "精确域名"))}</small></td><td class="mono">${esc(r.listen)}</td><td><span class="badge ${r.protocol}">${r.protocol === "both" ? "TCP + QUIC" : r.protocol === "udp" ? "QUIC" : "TCP"}</span></td><td class="mono">${esc(r.target)}</td><td><div class="row-actions"><button data-edit="${i}" aria-label="编辑 ${esc(r.domain)}">${icon("edit")}</button><button data-delete="${i}" aria-label="删除 ${esc(r.domain)}">${icon("trash")}</button></div></td></tr>`,
    )
    .join("");
}
function empty(
  text = "添加第一条转发规则",
  sub = "将域名与后端关联，开始管理你的转发网络。",
) {
  return `<div class="empty">${icon("routes")}<h3>${text}</h3><div>${sub}</div>${button("add", "添加规则", "plus", "primary")}</div>`;
}
function render() {
  if (!state.config) return;
  ({
    overview: renderOverview,
    rules: renderRules,
    backups: renderBackups,
    activity: renderActivity,
    settings: renderSettings,
  })[state.page]();
}
function renderOverview() {
  $("#content").innerHTML =
    head(
      "网络总览",
      "你的转发网络，一目了然。",
      `<span class="live-pill"><span class="dot"></span> 实时监测</span>${button("add", "添加规则", "plus", "primary")}`,
    ) +
    `<div id="offline-notice"></div><div class="stats-grid">${[
      ["routes", "转发规则", "rules", "条", "配置中的转发规则"],
      ["activity", "活跃连接", "active", "个", "TCP 与 QUIC 当前会话"],
      ["globe", "累计转发流量", "bytes", "", "自内核本次启动以来"],
      ["shield", "累计接入连接", "accepted", "次", "TCP 接入与 QUIC 新会话"],
    ]
      .map(
        ([ic, title, id, unit, note]) =>
          `<article class="stat-card"><div class="stat-top">${title}<span class="stat-icon">${icon(ic)}</span></div><div class="stat-value" id="metric-${id}">—<small>${unit}</small></div><div class="stat-note">${note}</div></article>`,
      )
      .join(
        "",
      )}</div><div class="two-columns"><section class="card"><div class="card-head"><div><h2>连接活动</h2><p>当前页面会话内的连接数 · 每 5 秒采样</p></div><span class="badge">最近 5 分钟</span></div><div class="chart-wrap"><div class="chart-legend"><span><i class="legend-dot"></i>TCP 连接</span><span><i class="legend-dot blue"></i>QUIC 会话</span></div><svg id="connection-chart" class="chart" viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label="TCP 与 QUIC 实时连接趋势"></svg><div class="chart-bottom"><span id="chart-start">开始采样</span><span>现在</span></div></div></section><section class="card"><div class="card-head"><div><h2>资源与容量</h2><p>内核自动感知可用资源</p></div>${icon("server")}</div><div class="resource-body" id="resources"></div></section></div><section class="card"><div class="card-head"><div><h2>转发规则</h2><p>精确域名优先，其次通配域名与默认目标</p></div><a href="#rules">管理全部规则 →</a></div>${state.config.rules.length ? `<div class="table-scroll"><table><thead><tr><th>匹配域名</th><th>监听入口</th><th>协议</th><th>转发目标</th><th>操作</th></tr></thead><tbody>${ruleRows(state.config.rules.slice(0, 5).map((r, i) => ({ r, i })))}</tbody></table></div>` : empty()}</section>`;
  updateMetrics();
}
function updateMetrics() {
  if (state.page !== "overview" || !$("#metric-rules")) return;
  const d = state.status,
    c = d?.core || {},
    running = d?.running;
  $("#offline-notice").innerHTML = running
    ? ""
    : `<div class="notice error">${esc(d?.error || "正在读取内核状态…")}。规则配置仍可查看。</div>`;
  $("#metric-rules").innerHTML =
    `${number(state.config.rules.length)}<small>条</small>`;
  $("#metric-active").innerHTML =
    `${running ? number((c.tcp_active || 0) + (c.udp_active || 0)) : "—"}<small>个</small>`;
  $("#metric-bytes").textContent = running
    ? bytes((c.tcp_bytes || 0) + (c.udp_bytes || 0))
    : "—";
  $("#metric-accepted").innerHTML =
    `${running ? number((c.tcp_accepted || 0) + (c.udp_created || 0)) : "—"}<small>次</small>`;
  const cap = c.capacity || {},
    r = cap.resources || {},
    lim = cap.effective || {};
  const mem = r.memory_total_bytes
    ? (1 - r.memory_available_bytes / r.memory_total_bytes) * 100
    : 0;
  $("#resources").innerHTML = running
    ? [
        [
          `系统 CPU`,
          r.system_cpu_percent || 0,
          `${(r.system_cpu_percent || 0).toFixed(1)}%`,
        ],
        ["有效内存使用", mem, `${mem.toFixed(1)}%`],
        [
          "TCP 容量",
          lim.tcp ? (c.tcp_active / lim.tcp) * 100 : 0,
          `${number(c.tcp_active)} / ${number(lim.tcp)}`,
        ],
      ]
        .map(
          ([title, v, label]) =>
            `<div class="resource-row"><div class="resource-title">${title}<b>${label}</b></div><progress max="100" value="${Math.max(0, Math.min(100, v))}"></progress></div>`,
        )
        .join("") +
      `<div class="resource-foot">${icon("shield")} ${cap.mode === "manual" ? "手动容量配置" : "自动容量管理"} · ${esc({ normal: "运行正常", manual: "手动管理", cpu: "CPU 压力", memory: "内存压力", memory_critical: "内存紧张", sensor_unavailable: "资源采样不可用" }[cap.pressure] || cap.pressure || "运行正常")}<br>TCP 异常累计 <button class="text-button" data-action="tcp-details">${number(c.tcp_failed)} · 查看分类</button><br>QUIC 拒绝累计 ${number(c.udp_rejected)}</div>`
    : '<div class="empty">内核离线，暂时没有资源数据</div>';
  drawChart();
}
function drawChart() {
  const el = $("#connection-chart");
  if (!el) return;
  const samples = state.samples;
  const max = Math.max(4, ...samples.flatMap((v) => [v.tcp, v.udp]));
  const points = (key) =>
    samples
      .map(
        (v, i) =>
          `${35 + (i * 560) / Math.max(1, samples.length - 1)},${140 - (v[key] / max) * 125}`,
      )
      .join(" ");
  el.innerHTML =
    [0, 1, 2]
      .map(
        (i) =>
          `<path d="M35 ${15 + i * 62.5}H595" stroke="#eef2ee" stroke-dasharray="3 4"/><text x="0" y="${19 + i * 62.5}">${Math.round(max * (1 - i / 2))}</text>`,
      )
      .join("") +
    `<polyline points="${points("tcp")}" fill="none" stroke="#238969" stroke-width="2" vector-effect="non-scaling-stroke"/><polyline points="${points("udp")}" fill="none" stroke="#8ba8c0" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  if (samples.length)
    $("#chart-start").textContent = new Date(
      samples[0].time,
    ).toLocaleTimeString("zh-CN", { hour12: false });
}
function renderRules() {
  $("#content").innerHTML =
    head(
      "转发规则",
      "在同一个入口上，将不同域名送往正确的后端。",
      button("export", "导出", "download") +
        button("import", "导入配置", "upload") +
        button("batch", "批量添加", "routes") +
        button("add", "添加规则", "plus", "primary"),
    ) +
    `<section class="card"><div class="toolbar"><div class="search-box">${icon("search")}<input id="rule-search" aria-label="搜索规则" placeholder="搜索域名、目标或备注" value="${esc(state.filter)}"></div><div class="toolbar-right"><select id="protocol-filter" aria-label="协议筛选"><option value="all">全部协议</option><option value="both">TCP + QUIC</option><option value="tcp">仅 TCP</option><option value="udp">仅 QUIC</option></select>${button("delete-selected", "删除选中", "trash")}${button("refresh-config", "刷新", "refresh")}</div></div><div id="rules-list"></div></section><p class="field-hint">规则保存后自动热加载。TCP 现有连接保持；移除 UDP 监听会关闭该监听的会话。</p>`;
  $("#protocol-filter").value = state.proto;
  $("#rule-search").oninput = (e) => {
    state.filter = e.target.value;
    state.pageIndex = 0;
    renderRuleList();
  };
  $("#protocol-filter").onchange = (e) => {
    state.proto = e.target.value;
    state.pageIndex = 0;
    renderRuleList();
  };
  renderRuleList();
}
function filteredRules() {
  const q = state.filter.toLowerCase();
  return state.config.rules
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        (state.proto === "all" || r.protocol === state.proto) &&
        [r.domain, r.target, r.listen, r.note].some((v) =>
          String(v || "")
            .toLowerCase()
            .includes(q),
        ),
    );
}
function renderRuleList() {
  const all = filteredRules(),
    pages = Math.max(1, Math.ceil(all.length / 20));
  state.pageIndex = Math.min(state.pageIndex, pages - 1);
  const current = all.slice(state.pageIndex * 20, (state.pageIndex + 1) * 20);
  $("#rules-list").innerHTML = all.length
    ? `<div class="table-scroll"><table><thead><tr><th><input type="checkbox" id="select-page" aria-label="选择本页" ${current.every((v) => state.selected.has(v.i)) ? "checked" : ""}></th><th>匹配域名</th><th>监听入口</th><th>协议</th><th>转发目标</th><th>操作</th></tr></thead><tbody>${ruleRows(current, true)}</tbody></table></div><div class="table-foot"><span>共 ${all.length} 条 · 已选择 ${state.selected.size} 条</span><div class="actions">${button("prev", "上一页")}${state.pageIndex + 1} / ${pages}${button("next", "下一页")}</div></div>`
    : state.config.rules.length
      ? '<div class="empty"><h3>没有匹配的规则</h3>试试其他关键词或协议筛选。</div>'
      : empty();
  if ($("#select-page"))
    $("#select-page").onchange = (e) => {
      current.forEach((v) =>
        e.target.checked ? state.selected.add(v.i) : state.selected.delete(v.i),
      );
      renderRuleList();
    };
}
function modal(title, sub, body, submitLabel, onSubmit) {
  $("#modal-content").innerHTML =
    `<form id="dialog-form"><div class="modal-head"><div><h2>${title}</h2><p>${sub}</p></div><button type="button" class="icon-button" id="modal-close" aria-label="关闭">${icon("close")}</button></div><div class="modal-body">${body}<p id="modal-error" class="form-error" role="alert"></p></div><div class="modal-foot"><button type="button" id="modal-cancel">取消</button><button type="submit" class="primary">${submitLabel}</button></div></form>`;
  $("#modal-close").onclick = $("#modal-cancel").onclick = () =>
    $("#modal").close();
  $("#dialog-form").onsubmit = async (e) => {
    e.preventDefault();
    const buttons = $$("button", e.target);
    buttons.forEach((b) => (b.disabled = true));
    $("#modal-error").textContent = "";
    try {
      await onSubmit(new FormData(e.target));
      $("#modal").close();
    } catch (e) {
      $("#modal-error").textContent = e.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  $("#modal").showModal();
}
function offlineOption() {
  return state.status?.running
    ? ""
    : `<label class="check"><input type="checkbox" name="offline" required>内核已停止，确认离线保存（下次启动生效）</label>`;
}
async function save(cfg, offline = false, revision = state.revision) {
  await api("config", {
    method: "PUT",
    body: JSON.stringify({ config: cfg, revision, offline }),
  });
  await loadConfig();
  render();
  await poll();
  toast(
    offline ? "配置已保存，启动内核后生效" : "配置已生效，变更前备份已保存",
  );
}
// Keep the core's existing target string format; split only at the form boundary.
function splitTarget(target, defaultPort) {
  const value = target.trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed)
    return { host: bracketed[1], port: bracketed[2] || String(defaultPort) };
  if ((value.match(/:/g) || []).length === 1) {
    const at = value.lastIndexOf(":");
    return { host: value.slice(0, at), port: value.slice(at + 1) };
  }
  return { host: value, port: String(defaultPort) };
}
function joinTarget(host, port) {
  host = host.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || /[\s/@?#]/.test(host))
    throw Error("后端地址只填写 IP 或域名，不要包含协议、路径或端口");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw Error("后端端口必须为 1–65535");
  if (host.includes(":")) {
    try {
      new URL(`http://[${host}]/`);
    } catch {
      throw Error("后端地址不是有效的 IPv6；域名或 IPv4 的端口请单独填写");
    }
    return `[${host}]:${Number(port)}`;
  }
  return `${host}:${Number(port)}`;
}
const failureLabels = {
  handshake_rejected: [
    "握手阶段结束或被拒绝",
    "识别域名前连接关闭、读取失败或报文校验不通过；仅凭计数无法确定具体子原因。",
  ],
  relay_error: [
    "转发阶段读写异常",
    "连接已选定后端，写入或双向转发出错；可能包含客户端或后端重置连接。",
  ],
  route_missing: [
    "未匹配转发规则",
    "识别到的域名未匹配规则，或没有可用域名且未配置默认目标。",
  ],
  handshake_timeout: [
    "等待域名识别超时",
    "在配置的识别超时内，没有收到完整的可识别请求。",
  ],
  admission_rejected: [
    "容量保护拒绝",
    "连接、握手、单 IP 或自动资源预算达到限制。",
  ],
  connect_timeout: ["后端连接超时", "解析与后端连接未在总超时预算内完成。"],
  connect_error: ["后端连接失败", "后端拒绝、连接错误或检测到直接回环目标。"],
  dns_error: ["后端域名解析失败", "系统解析器未能解析后端域名。"],
  socket_error: ["套接字设置失败", "TCP 套接字参数设置失败。"],
};
function showTcpFailures() {
  const c = state.status?.core;
  if (!state.status?.running || !c) {
    toast("内核离线，暂时无法查询分类", true);
    return;
  }
  const entries = Object.entries(failureLabels).sort(
    ([a], [b]) =>
      (c.tcp_failure_reasons?.[b] || 0) - (c.tcp_failure_reasons?.[a] || 0),
  );
  modal(
    "TCP 异常分类",
    "内核本次启动以来的累计统计，重启内核后归零。",
    `<div class="notice">累计 ${number(c.tcp_failed)} 次。该数字包含握手提前关闭、规则不匹配和转发读写错误，不等于后端故障次数，也不是当前失败率。分类来自内核计数器，不是逐条连接日志。</div><div class="failure-list">${entries.map(([key, [label, hint]]) => `<div class="failure-item"><div><b>${label}</b><strong>${number(c.tcp_failure_reasons?.[key])}</strong></div><p>${hint}</p></div>`).join("")}</div>`,
    "关闭",
    async () => {},
  );
  $("#modal-cancel").hidden = true;
}
function editRule(index) {
  const r =
      index == null
        ? { listen: "443", domain: "", target: "", protocol: "both", note: "" }
        : state.config.rules[index],
    base = structuredClone(state.config),
    rev = state.revision,
    endpoint = splitTarget(r.target, state.config.default_port);
  modal(
    index == null ? "添加转发规则" : "编辑转发规则",
    "通过域名，将入口流量转发到指定后端。",
    `<div class="form-grid"><label>监听地址 / 端口<input name="listen" required value="${esc(r.listen)}" placeholder="443"><span class="field-hint">端口号或 IP:端口；端口号默认监听双栈</span></label><label>转发协议<select name="protocol">${["both", "tcp", "udp"].map((p) => `<option value="${p}" ${r.protocol === p ? "selected" : ""}>${{ both: "TCP + QUIC", tcp: "仅 TCP", udp: "仅 QUIC" }[p]}</option>`).join("")}</select></label><label class="wide">匹配域名<input name="domain" required maxlength="253" value="${esc(r.domain)}" placeholder="app.example.com / *.example.com / *"></label><label>后端地址<input name="target_host" required maxlength="253" value="${esc(endpoint.host)}" placeholder="IP 地址或域名"><span class="field-hint">支持 IPv4、IPv6 和域名，无需附带端口</span></label><label>后端端口<input name="target_port" type="number" min="1" max="65535" step="1" required value="${esc(endpoint.port)}" placeholder="443"><span class="field-hint">独立填写，范围 1–65535</span></label><label class="wide">备注<input name="note" maxlength="256" value="${esc(r.note)}" placeholder="可选，例如：主站入口"></label></div><div class="notice">普通 UDP 不含可用域名，不会转发；QUIC 仅支持内核可识别的 SNI。</div>${offlineOption()}`,
    "保存并应用",
    async (f) => {
      const host = f.get("target_host").trim();
      const port = f.get("target_port").trim();
      const target = joinTarget(host, port);
      const unchanged =
        host === endpoint.host && Number(port) === Number(endpoint.port);
      const rule = {
        listen: f.get("listen").trim(),
        domain: f.get("domain").trim(),
        target: index != null && unchanged ? r.target : target,
        protocol: f.get("protocol"),
        note: f.get("note").trim(),
      };
      if (index == null) base.rules.push(rule);
      else base.rules[index] = rule;
      await save(base, f.has("offline"), rev);
    },
  );
}
function deleteRules(ids) {
  if (!ids.length) {
    toast("请先选择要删除的规则");
    return;
  }
  const base = structuredClone(state.config),
    rev = state.revision;
  modal(
    "删除转发规则",
    `已选择 ${ids.length} 条规则`,
    `<p>确认删除这些规则？保存前会自动备份当前配置。</p><pre>${esc(ids.map((i) => `${base.rules[i].domain} → ${base.rules[i].target}`).join("\n"))}</pre>${offlineOption()}`,
    "确认删除",
    async (f) => {
      base.rules = base.rules.filter((_, i) => !ids.includes(i));
      await save(base, f.has("offline"), rev);
    },
  );
}
function batch() {
  const base = structuredClone(state.config),
    rev = state.revision;
  modal(
    "批量添加规则",
    "整批校验，通过后一次性应用。",
    `<label>转发协议<select name="protocol"><option value="both">TCP + QUIC</option><option value="tcp">仅 TCP</option><option value="udp">仅 QUIC</option></select></label><label>规则内容<textarea name="lines" required spellcheck="false" placeholder="443 app.example.com 192.0.2.10 8443&#10;443 *.example.org backend.example.net 443"></textarea><span class="field-hint">每行：监听地址/端口 域名 后端主机 后端端口。支持 # 注释。</span></label>${offlineOption()}`,
    "校验并添加",
    async (f) => {
      const rows = f
        .get("lines")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"));
      if (!rows.length) throw Error("请填写至少一条规则");
      const newRules = rows.map((line, i) => {
        const p = line.split(/\s+/);
        if (p.length !== 4) throw Error(`第 ${i + 1} 行需填写四列`);
        if (!/^\d+$/.test(p[3]) || +p[3] < 1 || +p[3] > 65535)
          throw Error(`第 ${i + 1} 行端口无效`);
        let host = p[2];
        if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
        return {
          listen: p[0],
          domain: p[1],
          target: `${host}:${p[3]}`,
          protocol: f.get("protocol"),
          note: "",
        };
      });
      base.rules.push(...newRules);
      await save(base, f.has("offline"), rev);
    },
  );
}
function download(name, value) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importConfig() {
  const rev = state.revision;
  let imported = null;
  modal(
    "导入配置",
    "导入将替换完整配置；原配置会自动备份。",
    `<label>JSON 配置文件<input id="config-file" type="file" accept=".json,application/json" required></label><p id="import-preview" class="muted">选择从 Host Router 导出的配置文件。</p><label class="check"><input name="confirm" type="checkbox" required>我确认用此文件替换当前配置</label>${offlineOption()}`,
    "校验并导入",
    async (f) => {
      if (!imported) throw Error("请先选择有效的 JSON 配置文件");
      await api("validate", { method: "POST", body: JSON.stringify(imported) });
      await save(imported, f.has("offline"), rev);
    },
  );
  $("#config-file").onchange = async (e) => {
    imported = null;
    try {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) throw Error("配置文件不得超过 1 MiB");
      const v = JSON.parse(await file.text());
      const result = await api("validate", {
        method: "POST",
        body: JSON.stringify(v),
      });
      imported = v;
      $("#import-preview").textContent =
        `校验通过：${result.rules} 条规则，${result.listeners} 个监听地址。`;
    } catch (e) {
      $("#import-preview").textContent = e.message;
    }
  };
}
async function renderBackups() {
  const page = "backups";
  $("#content").innerHTML =
    head(
      "配置备份",
      "每次变更前自动保存快照，保留最近 30 份。",
      button("export", "导出当前配置", "download") +
        button("import", "导入配置", "upload"),
    ) +
    '<section class="card" id="backup-list"><div class="empty">正在加载备份…</div></section>';
  try {
    const list = await api("backups");
    if (state.page !== page) return;
    $("#backup-list").innerHTML = list.length
      ? `<div class="table-scroll"><table><thead><tr><th>备份时间</th><th>快照编号</th><th>规则数</th><th>大小</th><th>操作</th></tr></thead><tbody>${list.map((v) => `<tr><td class="domain-cell">${stamp(Number(v.id.split("-")[0]))}</td><td class="mono">${esc(v.id)}</td><td>${v.rules} 条</td><td>${bytes(v.bytes)}</td><td><div class="row-actions"><button data-backup-download="${esc(v.id)}">下载</button><button data-restore="${esc(v.id)}">恢复</button></div></td></tr>`).join("")}</tbody></table></div>`
      : '<div class="empty">还没有备份。首次保存规则或设置后，将在这里保留变更前的配置。</div>';
  } catch (e) {
    if (state.page === page)
      $("#backup-list").innerHTML =
        `<div class="empty">${esc(e.message)}</div>`;
  }
}
function restoreBackup(id) {
  const rev = state.revision;
  modal(
    "恢复配置备份",
    "恢复也会备份当前配置，可以再次回退。",
    `<p>将恢复快照 <b>${esc(id)}</b>。规则与设置会被替换。</p>${offlineOption()}`,
    "确认恢复",
    async (f) => {
      await api(`backups/${id}`, {
        method: "POST",
        body: JSON.stringify({ revision: rev, offline: f.has("offline") }),
      });
      await loadConfig();
      render();
      toast("备份已恢复");
    },
  );
}
const eventNames = {
  login: "管理员登录",
  logout: "退出登录",
  login_failed: "登录失败",
  password_changed: "密码修改",
  config_applied: "配置已更新",
  apply_failed: "配置应用失败",
  backup_restored: "备份已恢复",
  service: "内核服务操作",
};
async function renderActivity() {
  $("#content").innerHTML =
    head(
      "操作记录",
      "记录管理员登录、配置变更和恢复操作，保留最近 500 条。",
      button("refresh-page", "刷新", "refresh"),
    ) +
    '<section class="card" id="audit-list"><div class="empty">正在加载记录…</div></section>';
  try {
    const list = await api("audit");
    if (state.page !== "activity") return;
    $("#audit-list").innerHTML = list.length
      ? `<div class="audit-list">${list.map((e) => `<article class="audit-item"><span class="audit-icon">${icon(e.kind.includes("login") ? "shield" : "activity")}</span><div><h3>${esc(eventNames[e.kind] || e.kind)}</h3><p>${esc(e.detail)}</p></div><time>${stamp(e.time)}</time></article>`).join("")}</div>`
      : '<div class="empty">暂无操作记录</div>';
  } catch (e) {
    if (state.page === "activity")
      $("#audit-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function renderSettings() {
  const c = state.config;
  $("#content").innerHTML =
    head("系统设置", "调整转发行为与账户安全。") +
    `<div class="settings-grid"><section class="card"><div class="card-head"><div><h2>转发与解析</h2><p>以下设置支持在线热加载</p></div>${icon("settings")}</div><form id="settings-form" class="card-body"><div class="form-grid">${[
      ["dns_refresh_seconds", "DNS 刷新间隔（秒）", 1, 3600],
      ["default_port", "默认目标端口", 1, 65535],
      ["dial_timeout_ms", "连接超时（毫秒）", 100, 120000],
      ["sniff_timeout_ms", "域名识别超时（毫秒）", 100, 30000],
      ["udp_idle_seconds", "QUIC 空闲超时（秒）", 1, 3600],
    ]
      .map(
        ([key, label, min, max]) =>
          `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" value="${c[key]}" required></label>`,
      )
      .join(
        "",
      )}<label class="check"><input name="access_log" type="checkbox" ${c.access_log ? "checked" : ""}>启用内核访问日志</label></div><div class="notice">DNS 缓存到期后由新连接重新查询。QUIC 已有会话保持原后端，直到空闲超时。</div>${offlineOption()}<div class="form-footer"><span class="field-hint">配置保存前自动备份</span><button type="submit" class="primary">保存设置</button></div><p class="form-error" id="settings-error" role="alert"></p></form></section><div class="stack"><section class="card"><div class="card-head"><div><h2>账户安全</h2><p>修改后所有登录会话立即失效</p></div>${icon("shield")}</div><form id="password-form" class="card-body"><label>当前密码<input type="password" name="current" autocomplete="current-password" required></label><br><label>新密码<input type="password" name="password" minlength="14" maxlength="256" autocomplete="new-password" required placeholder="至少 14 位"></label><br><label>确认新密码<input type="password" name="confirm" autocomplete="new-password" required></label><div class="form-footer"><span class="field-hint">当前账户：${esc(state.session.username)}</span><button type="submit">更新密码</button></div><p id="password-error" class="form-error" role="alert"></p></form></section><section class="card"><div class="card-head"><div><h2>转发内核</h2><p>控制面板与转发进程独立运行</p></div>${icon("server")}</div><div class="card-body"><div class="actions">${state.session.manage_service ? button("service-start", "启动") + button("service-restart", "重启") + button("service-stop", "停止", null, "danger") : '<span class="field-hint">本部署未启用 systemd 服务控制。</span>'}</div><div class="settings-details">版本 ${esc(state.status?.core?.version || state.session.version)} · ${c.auto_capacity ? "自动容量管理" : "手动容量管理"}<br>连接上限等资源预算沿用现有内核配置。<br>重启或停止内核会中断现有连接。</div></div></section></div></div>`;
  const rev = state.revision,
    base = structuredClone(c);
  $("#settings-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("button[type=submit]", e.target);
    b.disabled = true;
    try {
      const f = new FormData(e.target);
      for (const k of [
        "dns_refresh_seconds",
        "dial_timeout_ms",
        "sniff_timeout_ms",
        "udp_idle_seconds",
      ])
        base[k] = Number(f.get(k));
      base.default_port = f.get("default_port");
      base.access_log = f.has("access_log");
      await save(base, f.has("offline"), rev);
    } catch (e) {
      $("#settings-error").textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
  $("#password-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      b = $("button", e.target);
    if (f.get("password") !== f.get("confirm")) {
      $("#password-error").textContent = "两次输入的新密码不一致";
      return;
    }
    b.disabled = true;
    try {
      await api("password", {
        method: "POST",
        body: JSON.stringify({
          current: f.get("current"),
          password: f.get("password"),
        }),
      });
      e.target.reset();
      showLogin();
      toast("密码已更新，请重新登录");
    } catch (e) {
      $("#password-error").textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}
function serviceAction(action) {
  modal(
    { start: "启动内核", stop: "停止内核", restart: "重启内核" }[action],
    "控制面板会继续保持运行。",
    `<p>${action === "start" ? "将按当前配置启动转发服务。" : "此操作会中断现有转发连接。确认继续？"}</p>`,
    "确认操作",
    async () => {
      await api(`service/${action}`, { method: "POST", body: "{}" });
      await poll();
      render();
      toast("服务操作已完成");
    },
  );
}
$("#content").addEventListener("change", (e) => {
  if (e.target.matches("[data-select]")) {
    const i = +e.target.dataset.select;
    e.target.checked ? state.selected.add(i) : state.selected.delete(i);
    renderRuleList();
  }
});
$("#content").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.edit !== undefined) return editRule(+b.dataset.edit);
    if (b.dataset.delete !== undefined) return deleteRules([+b.dataset.delete]);
    if (b.dataset.restore) return restoreBackup(b.dataset.restore);
    if (b.dataset.backupDownload) {
      download(
        `host-router-${b.dataset.backupDownload}.json`,
        await api(`backups/${b.dataset.backupDownload}`),
      );
      return;
    }
    const a = b.dataset.action;
    if (a?.startsWith("service-")) return serviceAction(a.slice(8));
    switch (a) {
      case "tcp-details":
        showTcpFailures();
        break;
      case "add":
        editRule();
        break;
      case "batch":
        batch();
        break;
      case "import":
        importConfig();
        break;
      case "export": {
        const fresh = await api("config");
        download("host-router-config.json", fresh.config);
        break;
      }
      case "delete-selected":
        deleteRules([...state.selected]);
        break;
      case "refresh-config":
        await loadConfig();
        render();
        toast("已同步最新配置");
        break;
      case "refresh-page":
        render();
        break;
      case "prev":
        state.pageIndex = Math.max(0, state.pageIndex - 1);
        renderRuleList();
        break;
      case "next":
        state.pageIndex++;
        renderRuleList();
        break;
    }
  } catch (e) {
    toast(e.message, true);
  }
});
let polling = false;
async function poll() {
  if (!state.session || polling) return;
  polling = true;
  try {
    state.status = await api("status");
    const d = state.status;
    $("#core-text").textContent = d.running ? "转发内核在线" : "转发内核离线";
    $("#core-dot").classList.toggle("offline", !d.running);
    $("#core-version").textContent = d.core ? `v${d.core.version}` : "—";
    if (d.running) {
      state.samples.push({
        time: Date.now(),
        tcp: d.core.tcp_active,
        udp: d.core.udp_active,
      });
      if (state.samples.length > 60) state.samples.shift();
    }
    $("#last-updated").textContent =
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    updateMetrics();
  } catch (e) {
    state.status = { running: false, error: e.message };
    $("#core-text").textContent = "状态获取失败";
    $("#core-dot").classList.add("offline");
    updateMetrics();
  } finally {
    polling = false;
  }
}
setInterval(() => {
  if (!document.hidden) poll();
}, 5000);
$("#clock").textContent = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});
(async () => {
  try {
    const session = await api("me");
    await enter(session);
  } catch {
    showLogin();
  }
})();
