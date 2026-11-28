"use strict";
// link_chat admin console. Plain DOM, hash routes, no framework and no build
// step (design.md decision 10). Every request goes through api(), which adds
// the CSRF header and handles 401/403 in one place. All text from the server
// is inserted with textContent, never as HTML.

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

// ---------- state ----------

const state = {
  me: null,        // {id, username, super, perms, all_perms}
  events: null,    // EventSource
  onEvent: null,   // handler of the current view
  onSimulationChange: null,
  disposeView: null,
  session: 0,
  route: null,
  pages: new Map(),
};

const PERM_LABEL = {
  "stats.view": "查看统计",
  "chat.view": "查看聊天",
  "users.moderate": "处置用户",
  "accounts.manage": "管理账号",
};

const GROUPS = [
  ["content", "内容"], ["manage", "管理"],
];
const SECTIONS = [
  { id: "live", label: "实况", perm: "stats.view", render: renderLive },
  { id: "users", label: "用户", group: "manage", perm: "users.moderate", render: renderUsers },
  { id: "chats", label: "会话", group: "content", perm: "chat.view", render: renderChats },
  { id: "search", label: "搜索", group: "content", perm: "chat.view", render: renderSearch },
  { id: "moments", label: "动态", group: "content", perm: "chat.view", render: renderMoments },
  { id: "accounts", label: "账号", group: "manage", perm: "accounts.manage", render: renderAccounts },
  { id: "audit", label: "审计", group: "manage", perm: "accounts.manage", render: renderAudit },
];

const can = (perm) => !!state.me && state.me.perms.includes(perm);
const sectionVisible = (section) => can(section.perm);
const canSimulate = () => can("stats.view") && can("accounts.manage") && state.me.super && state.me.simulation;

// ---------- api ----------

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `HTTP ${status}`);
    this.status = status;
    this.code = body && body.code;
    this.retryAfterMs = (body && body.retry_after_ms) || 0;
  }
}

const ERR_TEXT = {
  invalid_credentials: "用户名或密码错误",
  forbidden: "没有权限",
  unauthorized: "需要登录",
  token_expired: "登录已过期",
  account_banned: "账号已被封禁",
  rate_limited: "尝试太频繁，请稍后再试",
  username_taken: "用户名已被占用",
  invalid_username: "用户名只能用字母、数字和 _ - .，3 到 32 个字符",
  weak_password: "密码至少 8 个字符",
  user_not_found: "用户不存在",
  conversation_not_found: "会话不存在",
  storage_unavailable: "服务端存储异常",
  moment_not_found: "动态不存在或已删除",
  not_found: "内容不存在或已删除",
};

// retryClock renders the moment a wait ends. The page cannot refresh itself, so
// a countdown would freeze; a fixed time stays true however long it is read.
function retryClock(ms) {
  const d = new Date(Date.now() + ms + 999);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === new Date().toDateString()) return t;
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

function errText(e) {
  if (e instanceof ApiError) {
    // Server messages for forbidden are specific (which rule refused it).
    if (e.code === "forbidden" && e.message && e.message !== "not permitted") return "没有权限：" + e.message;
    if (e.code === "rate_limited" && e.retryAfterMs > 0) return "尝试太频繁，请在 " + retryClock(e.retryAfterMs) + " 后重试";
    return ERR_TEXT[e.code] || e.message;
  }
  return "网络错误";
}

async function api(method, path, body, signal) {
  const session = state.session;
  const opts = { method, headers: {}, credentials: "same-origin", signal };
  if (method !== "GET") opts.headers["X-Requested-With"] = "link-chat-admin";
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("api/" + path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (session !== state.session || signal?.aborted) throw new DOMException("Request expired", "AbortError");
  if (res.status === 401) {
    // Signed out, expired, or banned: back to the login form.
    if (path !== "login") showLogin(errText(new ApiError(res.status, data)));
    throw new ApiError(res.status, data);
  }
  if (res.status === 403 && path === "me") {
    showLogin("这个账号已经没有任何管理权限");
    throw new ApiError(res.status, data);
  }
  if (state.me && (res.status === 403 || (res.status === 404 && path.startsWith("simulation")))) refreshIdentity();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- formatting ----------

const pad = (n) => String(n).padStart(2, "0");
function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtShort(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtUntil(ms) { return ms ? fmtTime(ms) : "永久"; }
// ---------- toast and modal ----------

let toastTimer = 0;
let dismissModal;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// modal shows a form and resolves with submit(values) once it succeeds, or
// null when cancelled. submit may throw to keep the dialog open with an error.
function modal(title, body, okLabel, submit, danger = false) {
  return new Promise((resolve) => {
    const dlg = $("#modal"), form = $("#modal-form"), ok = $("#modal-ok");
    $("#modal-title").textContent = title;
    $("#modal-body").replaceChildren(...[body].flat());
    $("#modal-error").textContent = "";
    ok.textContent = okLabel;
    ok.className = danger ? "danger" : "";
    ok.disabled = false;
    let active = true;
    const onSubmit = async (ev) => {
      if (ev.submitter && ev.submitter.value === "cancel") return; // close normally
      ev.preventDefault();
      if (ok.disabled) return;
      ok.disabled = true;
      ok.textContent = "处理中…";
      try {
        const r = await submit(form);
        if (!active) return;
        cleanup();
        dlg.close();
        resolve(r === undefined ? true : r);
      } catch (e) {
        if (!active) return;
        $("#modal-error").textContent = e instanceof ApiError ? errText(e) : e.message;
      } finally {
        if (active) {
          ok.disabled = false;
          ok.textContent = okLabel;
        }
      }
    };
    const onClose = () => {
      if (dlg.open) return;
      cleanup();
      resolve(null);
    };
    function cleanup() {
      active = false;
      dismissModal = null;
      form.removeEventListener("submit", onSubmit);
      dlg.removeEventListener("close", onClose);
      $("#modal-body").replaceChildren();
    }
    dismissModal = () => { dlg.close(); onClose(); };
    form.addEventListener("submit", onSubmit);
    dlg.addEventListener("close", onClose);
    dlg.showModal();
    const first = $("#modal-body input, #modal-body select, #modal-body textarea");
    if (first) first.focus();
  });
}

// ---------- sign in and shell ----------

function showLogin(msg = "") {
  state.session++;
  closeEvents();
  clearView();
  state.pages.clear();
  state.route = null;
  state.me = null;
  closeDrawer(false);
  closeGroupMenu();
  $("#view").replaceChildren();
  $("#nav").replaceChildren();
  $("#rail-nav").replaceChildren();
  $("#me").textContent = "";
  $("#shell").hidden = true;
  $("#login").hidden = false;
  $("#login-error").textContent = msg;
  $("#login-form").password.value = "";
  $("#login-form").username.focus();
}

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $("#login-error").textContent = "";
  const btn = f.querySelector("button");
  btn.disabled = true;
  try {
    state.me = await api("POST", "login", { username: f.username.value.trim(), password: f.password.value });
    f.password.value = "";
    enterShell();
  } catch (e) {
    $("#login-error").textContent = errText(e);
  } finally {
    btn.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  const logout = $("#logout");
  const session = state.session;
  logout.disabled = true;
  try { await api("POST", "logout"); } catch { /* already gone */ }
  finally { logout.disabled = false; }
  if (session === state.session) {
    history.replaceState(null, "", location.pathname + location.search);
    showLogin();
  }
});

function enterShell() {
  state.session++;
  $("#login").hidden = true;
  $("#shell").hidden = false;
  drawNavigation();
  openEvents();
  route();
}

const drawer = $("#drawer");
let drawerTrigger;
let groupMenu;

function closeGroupMenu(restoreFocus = false) {
  if (!groupMenu) return;
  const { key, panel, timer } = groupMenu;
  groupMenu = null;
  clearTimeout(timer);
  if (panel.matches(":popover-open")) panel.hidePopover();
  key.setAttribute("aria-expanded", "false");
  if (restoreFocus) key.focus({ preventScroll: true });
}

function positionGroupMenu() {
  if (!groupMenu) return;
  const { key, panel } = groupMenu;
  const rect = key.getBoundingClientRect();
  panel.style.left = Math.max(4, Math.min(rect.right + 7, innerWidth - panel.offsetWidth - 4)) + "px";
  panel.style.top = Math.max(4, Math.min(rect.top, innerHeight - panel.offsetHeight - 4)) + "px";
}

function openGroupMenu(key, panel, pinned = false) {
  if (groupMenu?.key === key) {
    clearTimeout(groupMenu.timer);
    if (pinned) groupMenu.pinned = true;
    return;
  }
  closeDrawer(false);
  closeGroupMenu();
  groupMenu = { key, panel, pinned };
  key.setAttribute("aria-expanded", "true");
  panel.showPopover({ source: key });
  positionGroupMenu();
}

function bindGroupMenu(key, panel) {
  const focusOption = () => ($("[aria-current]", panel) || $("a", panel)).focus({ preventScroll: true });
  function leave(event) {
    if (event.pointerType !== "mouse" || groupMenu?.key !== key || groupMenu.pinned) return;
    clearTimeout(groupMenu.timer);
    groupMenu.timer = setTimeout(() => {
      if (groupMenu?.key === key && !panel.contains(document.activeElement)) closeGroupMenu();
    }, 160);
  }
  key.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") openGroupMenu(key, panel);
  });
  key.addEventListener("pointerleave", leave);
  panel.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse" && groupMenu?.key === key) clearTimeout(groupMenu.timer);
  });
  panel.addEventListener("pointerleave", leave);
  key.addEventListener("keydown", (event) => {
    if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    openGroupMenu(key, panel, true);
    focusOption();
  });
  key.addEventListener("click", (event) => {
    if (groupMenu?.key === key && groupMenu.pinned) {
      closeGroupMenu(true);
      return;
    }
    openGroupMenu(key, panel, event.pointerType !== "mouse" || event.detail === 0);
    if (event.detail === 0) focusOption();
  });
}

function closeGroupOutside(event) {
  if (groupMenu && !groupMenu.key.contains(event.target) && !groupMenu.panel.contains(event.target)) closeGroupMenu();
}
document.addEventListener("pointerdown", closeGroupOutside, true);
document.addEventListener("focusin", closeGroupOutside);
window.addEventListener("resize", positionGroupMenu);
$("#rail").addEventListener("scroll", positionGroupMenu);

function closeDrawer(restoreFocus = true) {
  if (drawer.inert) return;
  if (restoreFocus && drawerTrigger?.isConnected) drawerTrigger.focus();
  else if (drawer.contains(document.activeElement)) document.activeElement.blur();
  drawer.inert = true;
  $("#drawer-scrim").inert = true;
  $("#view").inert = false;
  $("#shell").classList.remove("drawer-open");
  drawerTrigger?.setAttribute("aria-expanded", "false");
  drawerTrigger = null;
}

function openDrawer(trigger, group) {
  closeGroupMenu();
  if (drawerTrigger === trigger) { closeDrawer(); return; }
  closeDrawer(false);
  drawerTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  const groups = [...drawer.querySelectorAll("details")];
  const selected = group === "current" ? state.route?.section?.group : group;
  if (selected) {
    for (const item of groups) item.open = item.dataset.group === selected;
  } else if (!groups.some((item) => item.open)) {
    if (groups[0]) groups[0].open = true;
  }
  drawer.inert = false;
  $("#drawer-scrim").inert = false;
  $("#view").inert = true;
  $("#shell").classList.add("drawer-open");
  const opened = groups.find((item) => item.open);
  const current = group === "current" ? $("[aria-current]", drawer) : null;
  const target = group === "account" ? $("#logout")
    : current || opened?.querySelector("[aria-current]") || opened?.querySelector("a") || $("#close-menu");
  target.focus({ preventScroll: true });
  if (document.activeElement !== target) requestAnimationFrame(() => {
    if (drawerTrigger === trigger) target.focus({ preventScroll: true });
  });
}

$("#menu").addEventListener("click", (e) => openDrawer(e.currentTarget, "current"));
$("#account").addEventListener("click", (e) => openDrawer(e.currentTarget, "account"));
$("#close-menu").addEventListener("click", () => closeDrawer());
$("#drawer-scrim").addEventListener("click", () => closeDrawer());
document.addEventListener("keydown", (e) => {
  if ($("dialog[open]")) return;
  if (groupMenu && e.key === "Escape") {
    e.preventDefault();
    closeGroupMenu(groupMenu.panel.contains(document.activeElement));
    return;
  }
  if (drawer.inert) return;
  if (e.key === "Escape") { e.preventDefault(); closeDrawer(); }
  if (e.key !== "Tab") return;
  const keys = [...drawer.querySelectorAll("a, button:not(:disabled), summary")].filter((node) => node.getClientRects().length);
  const edge = e.shiftKey ? keys[0] : keys.at(-1);
  if (document.activeElement === edge || !drawer.contains(document.activeElement)) {
    e.preventDefault();
    (e.shiftKey ? keys.at(-1) : keys[0])?.focus();
  }
});

function sectionLink(section, inRail = false) {
  const link = el("a", {
    href: "#" + section.id, "data-id": section.id, class: inRail ? "rail-key" : "nav-link",
    onclick: (e) => {
      if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (location.hash === "#" + section.id) {
        e.preventDefault();
        closeGroupMenu();
        closeDrawer(false);
        focusView(state.route);
      }
    },
  }, inRail && el("i", { class: "rail-icon monitor", "aria-hidden": "true" }), section.label);
  return link;
}

function drawNavigation() {
  closeGroupMenu();
  $("#me").textContent = state.me.username + (state.me.super ? "（超级管理员）" : "");
  const rail = $("#rail-nav"), nav = $("#nav");
  rail.replaceChildren();
  nav.replaceChildren();
  const visible = SECTIONS.filter(sectionVisible);
  const live = visible.find((section) => section.id === "live");
  if (live) { rail.append(sectionLink(live, true)); nav.append(sectionLink(live)); }
  for (const [group, label] of GROUPS) {
    const sections = visible.filter((section) => section.group === group);
    if (!sections.length) continue;
    const panel = el("div", { id: "rail-menu-" + group, class: "rail-flyout", popover: "manual", role: "group", "aria-label": label },
      sections.map((section) => sectionLink(section)));
    const key = el("button", { type: "button", class: "rail-key", "data-group": group,
      "aria-controls": panel.id, "aria-expanded": "false",
    }, el("i", { class: "rail-icon " + group, "aria-hidden": "true" }), label);
    rail.append(key, panel);
    bindGroupMenu(key, panel);
    nav.append(el("details", { class: "nav-group", "data-group": group },
      el("summary", {}, label), sections.map((section) => sectionLink(section))));
  }
}

function focusView(current) {
  if (!current || state.route !== current) return;
  const heading = $("h1,h2", current.view) || current.view;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function route({ notice = "" } = {}) {
  if (!state.me) return;
  closeGroupMenu();
  closeDrawer(false);
  const allowed = SECTIONS.filter(sectionVisible);
  const [requested, ...parts] = location.hash.slice(1).split("/");
  const alias = !parts.length && (requested === "overview" || requested === "simulation");
  const id = alias ? "live" : requested;
  const openSimulation = (alias && requested === "simulation") || (id === "live" && parts.join("/") === "simulation");
  let section = allowed.find((s) => s.id === id), rest = [];
  if (section) {
    try {
      rest = parts.map(decodeURIComponent);
      if (openSimulation && id === "live") rest = [];
      else if (parts.length && (!["users", "chats"].includes(id) || parts.length !== 1 || !rest[0])) section = null;
    } catch { section = null; }
  }
  if (section?.id === "live" && openSimulation && !canSimulate() && !notice) notice = "当前账号无法使用模拟测试，或服务端尚未启用模拟测试。";
  if (section?.id === "live" && (alias || (openSimulation && !canSimulate()))) {
    history.replaceState(null, "", openSimulation && canSimulate() ? "#live/simulation" : "#live");
  }
  if (!section) {
    if (id && !notice) notice = SECTIONS.some((s) => s.id === id) && !allowed.some((s) => s.id === id)
      ? "当前账号无权访问请求的页面。" : "这个后台地址已失效。";
    section = allowed.find((s) => s.id === "live") || allowed[0];
    rest = [];
    if (section) history.replaceState(null, "", "#" + section.id);
  }
  const workspace = $("#view");
  const prior = state.route;
  if (prior && !prior.rest.length) prior.scroll.top = prior.view.scrollTop;
  clearView();
  for (const link of document.querySelectorAll("#shell [data-id]")) {
    if (link.dataset.id === section?.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const group of document.querySelectorAll("#shell [data-group]")) {
    group.classList.toggle("active", group.dataset.group === section?.group);
  }
  $("#area").textContent = section?.group ? GROUPS.find(([key]) => key === section.group)[1] : "管理后台";
  $("#shell").classList.toggle("is-live", section?.id === "live");
  const view = el("div", { class: "view", tabindex: -1 });
  const prefs = state.pages.get(section?.id) || {};
  if (section) state.pages.set(section.id, prefs);
  const scroll = rest.length ? {} : (prefs.scroll ??= {});
  const controller = new AbortController();
  const current = { section, rest, view, scroll, controller };
  state.route = current;
  workspace.replaceChildren(view);
  if (notice) workspace.prepend(el("p", { class: "route-notice", role: "status" }, notice));
  if (!section) view.append(el("h2", {}, "没有可访问的工作区"), el("p", {}, "可从左侧「账户」退出后台。"));
  const active = () => state.route === current && !controller.signal.aborted;
  const context = {
    prefs,
    openSimulation: openSimulation && canSimulate(),
    api: async (method, endpoint, body, signal) => {
      if (!active()) throw new DOMException("View closed", "AbortError");
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const result = await api(method, endpoint, body, method === "GET" ? requestSignal : undefined);
      if (!active()) throw new DOMException("View closed", "AbortError");
      return result;
    },
    toast: (...args) => { if (active()) toast(...args); },
  };
  let rendered;
  try { rendered = section?.render(view, rest, context); }
  catch (e) { rendered = Promise.reject(e); }
  focusView(current);
  Promise.resolve(rendered).catch((e) => {
    if (active()) view.append(el("p", { class: "error", role: "alert" }, errText(e)));
  }).finally(() => {
    if (!active()) return;
    if (scroll.top) view.scrollTop = scroll.top;
    if (document.activeElement === view) focusView(current);
  });
}

function clearView() {
  state.route?.controller.abort();
  state.disposeView?.();
  state.disposeView = null;
  state.onEvent = null;
  state.onSimulationChange = null;
  dismissModal?.();
  clearTimeout(toastTimer);
  $("#toast").hidden = true;
}
window.addEventListener("hashchange", () => route());

async function confirmAccountDeletion(user, api) {
  const username = el("input", { type: "text", required: true, autocomplete: "off" });
  const keep = el("input", { type: "checkbox" });
  const deleted = await modal("删除账号 " + user.username, [
    el("p", { class: "muted" }, "永久删除账号资料、私聊会话、本人频道消息、好友关系和自己的动态。频道有其他成员时会移交，无其他成员时一并删除。"),
    el("div", { class: "checks" }, el("label", {}, keep, "匿名保留其在别人动态下的评论正文")),
    el("label", {}, "输入完整用户名以确认删除", username),
  ], "永久删除", () => {
    if (username.value !== user.username) throw new Error("输入的用户名不匹配");
    return api("DELETE", "users/" + encodeURIComponent(user.id), { username: username.value, keep_comments: keep.checked });
  }, true);
  return deleted;
}

const SIMULATION_ACTIONS = [
  ["dm", "好友私聊", 2, 6],
  ["channel_message", "频道发言", 3, 8],
  ["focus", "切换查看频道", 2, 5],
  ["post", "发朋友圈", 8, 15],
  ["comment", "评论好友动态", 4, 10],
  ["like", "点赞好友动态", 6, 16],
  ["friend_remove", "删除好友关系", 20, 60],
  ["presence", "随机上下线", 10, 30],
];
const SIMULATION_MAX_USERS = 10000;

function watchPageSize(container, measure, update, ...dependencies) {
  let size;
  const measureNow = () => {
    if (!container.isConnected || !container.clientHeight) return;
    const next = measure();
    if (size === next) return;
    const first = size === undefined;
    size = next;
    update(size, first);
  };
  const observer = new ResizeObserver(measureNow);
  observer.observe(container);
  for (const node of dependencies) observer.observe(node);
  measureNow();
  return () => observer.disconnect();
}

function rangePreview(input, commit) {
  const display = el("output", { class: "range-value", "aria-hidden": "true" });
  const element = el("span", { class: "range-control" }, input, display);
  let tracking;
  function endDrag(event) {
    const dragged = !!tracking;
    element.classList.remove("dragging");
    tracking?.abort();
    tracking = null;
    if (dragged && (event?.type === "pointerup" || event?.type === "mouseup")) commit?.();
  }
  input.addEventListener("pointerdown", (event) => {
    if (input.disabled || event.button !== 0) return;
    endDrag();
    element.classList.add("dragging");
    tracking = new AbortController();
    const options = { capture: true, signal: tracking.signal };
    for (const name of ["pointerup", "pointercancel", "mouseup"]) {
      window.addEventListener(name, endDrag, options);
    }
    window.addEventListener("blur", endDrag, { signal: tracking.signal });
  });
  return {
    element, dragging: () => element.classList.contains("dragging"),
    update(text) {
      const fraction = (input.valueAsNumber - Number(input.min)) / Math.max(1, Number(input.max) - Number(input.min));
      const progress = fraction * 100 + "%";
      input.style.setProperty("--position", progress);
      element.style.setProperty("--position", progress);
      display.textContent = text;
      input.setAttribute("aria-valuetext", text);
    },
  };
}

function pager(label, go) {
  const control = (text, title, onClick) => el("button", { type: "button", class: "pager-key secondary", "aria-label": title, title, onclick: onClick }, text);
  const first = control("«", "后退 5 页", () => go(Math.max(1, current - 5)));
  const prev = control("‹", "上一页", () => go(current - 1));
  const next = control("›", "下一页", () => go(current + 1));
  const jump = control("»", "前进 5 页", () => go(Math.min(total || current + 5, current + 5)));
  const numbers = el("span", { class: "pager-numbers" });
  const status = el("span", { class: "pager-status", role: "status" });
  const wheel = el("input", { class: "pager-wheel", type: "range", min: 1, max: 1, step: 1,
    "aria-label": label + "滚轮", oninput: showWheel,
    onchange: applyWheel,
  });
  const preview = rangePreview(wheel, applyWheel);
  function showWheel() {
    preview.update("第 " + wheel.value + " 页");
  }
  function applyWheel() {
    const page = wheel.valueAsNumber;
    if (wheel.disabled || page === current || page === pendingPage) return;
    pendingPage = page;
    go(page);
  }
  wheel.addEventListener("wheel", (ev) => {
    if (document.activeElement !== wheel || wheel.disabled || !ev.deltaY) return;
    ev.preventDefault();
    go(Math.max(1, Math.min(Number(wheel.max), current + Math.sign(ev.deltaY))));
  }, { passive: false });
  let current = 1, total = null, signature, pendingPage;
  const element = el("nav", { class: "list-pager", "aria-label": label },
    el("div", { class: "pager-controls" }, first, prev, numbers, next, jump),
    el("div", { class: "pager-readout" }, preview.element, status));
  return {
    element, status, dragging: preview.dragging,
    update({ page = 1, known = 1, last = null, busy = false, text = "" }) {
      current = page;
      total = last;
      if (!busy) pendingPage = undefined;
      const end = last || known;
      first.disabled = prev.disabled = busy || page <= 1;
      next.disabled = jump.disabled = busy || page >= end;
      wheel.disabled = busy || end <= 1;
      if (!preview.dragging() || Number(wheel.max) !== end) {
        wheel.max = end;
        wheel.value = page;
        showWheel();
      }
      const key = [page, end, last, busy].join("/");
      if (key !== signature) {
        signature = key;
        const values = new Set();
        for (const n of end <= 7 ? Array.from({ length: end }, (_, i) => i + 1)
          : [1, 2, 3, page, end - 2, end - 1, end]) values.add(n);
        let prior = 0;
        const nodes = [];
        for (const n of [...values].sort((a, b) => a - b)) {
          if (n - prior > 1) nodes.push(el("span", { class: "pager-ellipsis", "aria-hidden": "true" }, "…"));
          const button = control(n, "第 " + n + " 页", () => go(n));
          if (n === page) button.setAttribute("aria-current", "page");
          button.disabled = busy || n === page;
          nodes.push(button);
          prior = n;
        }
        if (!last && end > 1) nodes.push(el("span", { class: "pager-ellipsis", "aria-hidden": "true" }, "…"));
        numbers.replaceChildren(...nodes);
      }
      if (status.textContent !== text) status.textContent = text;
    },
  };
}

// Cursor APIs reveal the next page when the current one returns. Keep the
// discovered edges to allow direct backward jumps without rewalking history.
function cursorPages() {
  let edges = [undefined], last = null;
  function note(page, next) {
    if (next == null || next === "") {
      edges.length = page;
      last = page;
    } else if (JSON.stringify(edges[page]) !== JSON.stringify(next)) {
      edges.length = page;
      edges.push(next);
      last = null;
    }
  }
  return {
    note, clear: () => { edges = [undefined]; last = null; },
    state: () => ({ known: edges.length, last }),
    snapshot: () => ({ edges: [...edges], last }),
    restore: (saved) => { edges = [...saved.edges]; last = saved.last; },
    async read(target, fetch, signal) {
      let result;
      let page = Math.min(target, edges.length);
      while (true) {
        result = await fetch(edges[page - 1]);
        signal.throwIfAborted();
        note(page, result.next);
        if (page >= target || page === last) return { page, result };
        page++;
      }
    },
  };
}

function responsiveList({ container, list, label, rowHeight, max = 100, fetch, draw, enabled = () => true, cache, indexed = false }) {
  let size = 12, page = 1, last = null, revision = 0, busy = false, timer, request;
  const cursor = cursorPages();
  const toolbar = pager(label, (target) => load(target));
  list.after(toolbar.element);
  function update() {
    const state = indexed ? { last } : cursor.state();
    toolbar.update({ ...state, page, busy, text: busy ? "正在加载…" : "第 " + page + (state.last ? " / " + state.last : "") + " 页 · 每页 " + size + " 条" });
  }
  async function load(target, reset = false) {
    if (!enabled()) { update(); return; }
    const generation = ++revision;
    request?.abort();
    const signal = (request = new AbortController()).signal;
    if (reset) { cursor.clear(); page = 1; last = null; }
    busy = true;
    update();
    let error;
    try {
      let loaded;
      if (indexed) {
        const result = await fetch(size, target, signal);
        loaded = { result, page: result.page };
      } else {
        loaded = await cursor.read(target, (edge) => fetch(size, edge, signal), signal);
      }
      if (generation !== revision) return;
      draw(loaded.result);
      if (loaded.page !== page) container.scrollTop = 0;
      page = loaded.page;
      if (indexed) last = loaded.result.last;
      if (cache) cache.current = { data: loaded.result, position: page, cursor: cursor.snapshot(), size, last };
    } catch (e) {
      if (generation !== revision || !container.isConnected) return;
      error = errText(e);
    } finally {
      if (generation === revision && container.isConnected) {
        busy = false;
        update();
        if (error) toolbar.status.replaceChildren(error, " ", el("button", {
          type: "button", class: "secondary", onclick: () => load(target),
        }, "重试"));
      }
    }
  }
  const stopResize = watchPageSize(container, () => {
    const used = list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const reserve = Math.max(76, toolbar.element.offsetHeight + 24);
    return Math.min(max, Math.max(1, Math.floor((container.clientHeight - used - reserve) / rowHeight)));
  }, (capacity, first) => {
    size = capacity;
    if (!first) load(1, true);
  }, toolbar.element);
  const dispose = state.disposeView;
  state.disposeView = () => { revision++; request?.abort(); clearTimeout(timer); stopResize(); dispose?.(); };
  return {
    restore: () => {
      const saved = cache?.current;
      if (!saved || size !== saved.size) return load(1, true);
      cursor.restore(saved.cursor);
      page = saved.position;
      last = saved.last;
      draw(saved.data);
      update();
    },
    reset: () => { clearTimeout(timer); timer = undefined; container.scrollTop = 0; return load(1, true); },
    refresh: () => load(page),
    refreshFirst: () => {
      if (timer || busy || page !== 1 || document.hidden) return;
      timer = setTimeout(() => { timer = undefined; if (!busy && page === 1 && !toolbar.dragging()) load(1); }, 1200);
    },
  };
}

function integerWheel(label, value, max, unit = "", min = 1) {
  const input = el("input", { type: "number", min, max, step: 1, value, required: true,
    "aria-label": unit ? `${label}（${unit}）` : label });
  const range = el("input", { type: "range", min: 0, max: 1000, "aria-label": `${label}滚轮` });
  const preview = rangePreview(range);
  const element = el("div", { class: "simulation-wheel" },
    preview.element, el("div", { class: "simulation-readout" }, input, unit && el("span", { "aria-hidden": "true" }, unit)));
  const scale = Math.log1p(max - min);
  const position = (amount) => Math.round(1000 * Math.log1p(amount - min) / scale);
  const marks = [min, 5, 10, 15, 30, 50, 60, 100, 200, 300, 500, 1000, 2000, 5000, 10000, max]
    .filter((n) => n >= min && n <= max).map((n) => [position(n), n]);

  function sync() {
    const amount = Math.min(max, Math.max(min, Math.round(input.valueAsNumber || min)));
    range.value = position(amount);
    preview.update(unit ? `${amount} ${unit}` : String(amount));
  }
  function change(amount) {
    input.value = Math.min(max, Math.max(min, Math.round(amount)));
    input.dispatchEvent(new Event("input"));
  }
  range.addEventListener("input", () => {
    const raw = Number(range.value);
    const nearest = marks.reduce((best, mark) => Math.abs(mark[0] - raw) < Math.abs(best[0] - raw) ? mark : best);
    change(Math.abs(nearest[0] - raw) <= 8 ? nearest[1] : min + Math.expm1(scale * raw / 1000));
  });
  range.addEventListener("keydown", (ev) => {
    const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[ev.key];
    if (!direction) return;
    ev.preventDefault();
    change((input.valueAsNumber || min) + direction * (ev.shiftKey ? 10 : 1));
  });
  range.addEventListener("wheel", (ev) => {
    if (document.activeElement !== range || !ev.deltaY) return;
    ev.preventDefault();
    change((input.valueAsNumber || min) - Math.sign(ev.deltaY) * (ev.shiftKey ? 10 : 1));
  }, { passive: false });
  input.addEventListener("input", sync);
  input.addEventListener("change", () => change(input.valueAsNumber || min));
  sync();
  return { element, input, range };
}

function renderSimulation(view, { api, prefs, expanded, expand }) {
  view.classList.add("simulation-view");
  const number = (value, min, max) => el("input", { type: "number", value, min, max, required: true });
  const prefix = el("input", { type: "text", value: "test", required: true, maxlength: 28, pattern: "[A-Za-z0-9_.\\-]+" });
  const count = number(10, 1, SIMULATION_MAX_USERS), duration = integerWheel("运行时长", 60, 3600, "s"), friends = number(5, 0, 30);
  const joinMin = number(1, 0, 30), joinMax = number(3, 0, 30);
  const own = el("input", { type: "checkbox", checked: true });
  const usersPerChannel = number(1, 1, SIMULATION_MAX_USERS);
  own.addEventListener("change", () => { usersPerChannel.disabled = !own.checked; });
  const usePublic = el("input", { type: "checkbox" });
  const texts = el("textarea", { id: "simulation-texts", rows: 2, maxlength: 2420, placeholder: "留空使用 100 条默认英文素材" });
  const start = el("button", { type: "submit" }, "启动模拟");
  const stop = el("button", { type: "button", class: "secondary", disabled: true }, "停止模拟");
  const summary = el("p", { class: "simulation-telemetry", role: "status" }, "正在读取模拟状态…");
  const runFeedback = el("p", { class: "operation-status simulation-feedback", role: "status", hidden: true });
  const filter = el("input", { type: "search", placeholder: "按用户名筛选", "aria-label": "筛选模拟账号" });
  const interval = integerWheel("删除间隔", 2000, 3600000, "ms");
  const keepComments = el("input", { type: "checkbox" });
  const deleteBatch = el("button", { type: "button", class: "danger", disabled: true }, "顺序删除");
  const stopDeletion = el("button", { type: "button", class: "secondary", disabled: true }, "停止删除");
  const selectPage = el("button", { type: "button", class: "secondary", disabled: true }, "选择本页");
  const selectAll = el("button", { type: "button", class: "secondary", disabled: true }, "选择全部账号");
  const clearSelection = el("button", { type: "button", class: "secondary", disabled: true }, "清空所选");
  const selectionText = el("span", { role: "status" });
  const deletionSummary = el("p", { class: "simulation-telemetry", role: "status", hidden: true });
  const deletionFeedback = el("p", { class: "operation-status", role: "status", hidden: true });
  const deletionControls = el("div", { class: "simulation-deletion" },
    el("div", { class: "toolbar" }, filter,
      el("div", { class: "simulation-field" }, el("span", {}, "删除间隔"), interval.element), deleteBatch, stopDeletion),
    el("div", { class: "checks" }, el("label", {}, keepComments, "匿名保留在别人动态下的评论")),
    el("div", { class: "simulation-selection" }, selectPage, selectAll, clearSelection, selectionText),
    deletionSummary, deletionFeedback);
  const accounts = el("div", { class: "simulation-user-grid" });
  const pages = pager("模拟账号分页", (target) => { page = target - 1; drawAccounts(); });
  const labels = new Map([
    ...SIMULATION_ACTIONS.map(([id, label]) => [id, label]),
    ["friendship", "建立好友"], ["create_channel", "创建频道"], ["join_channel", "加入频道"],
  ]);
  const settings = new Map();
  const form = el("form", { class: "simulation-form" },
    el("fieldset", {}, el("legend", {}, "注册与准备"),
      el("div", { class: "simulation-grid" },
        el("label", {}, "用户名前缀", prefix), el("label", {}, "用户数", count),
        el("label", {}, "每人最多好友", friends),
        el("label", {}, "额外加频道最少", joinMin), el("label", {}, "额外加频道最多", joinMax),
        el("label", {}, "每几人建一个频道", usersPerChannel),
        el("div", { class: "simulation-field simulation-duration" }, el("span", {}, "运行时长"), duration.element)),
      el("div", { class: "checks" },
        el("label", {}, own, "创建公开频道"),
        el("label", {}, usePublic, "也允许加入已有公开频道"))),
    el("fieldset", {}, el("legend", {}, "循环行为"),
      el("div", { class: "simulation-action simulation-action-head", "aria-hidden": "true" },
        el("span", {}, "行为"), el("span", {}, "最短间隔"), el("span", {}, "最长间隔")),
      ...SIMULATION_ACTIONS.map(([id, label, min, max]) => {
        const enabled = el("input", { type: "checkbox", checked: true });
        const lower = integerWheel(`${label}最短间隔`, min, 600, "s");
        const upper = integerWheel(`${label}最长间隔`, max, 600, "s");
        const update = () => {
          for (const control of [lower, upper]) control.input.disabled = control.range.disabled = !enabled.checked;
        };
        enabled.addEventListener("change", update);
        update();
        settings.set(id, { enabled, lower: lower.input, upper: upper.input });
        return el("div", { class: "simulation-action" },
          el("label", { class: "simulation-switch" }, enabled, label), lower.element, upper.element);
      }),
      el("div", { class: "simulation-text" },
        el("div", {}, el("label", { for: "simulation-texts" }, "文本素材"),
          el("a", { href: "simulation-texts.txt", target: "_blank", rel: "noopener" }, "查看默认素材 ↗")), texts)),
    el("div", { class: "simulation-runbar" }, start, stop, summary, runFeedback));
  const fields = [...form.querySelectorAll("input, textarea")];
  const config = el("div", { class: "simulation-config" }, [...form.querySelectorAll(":scope > fieldset")]);
  form.prepend(config);
  if (prefs.config) {
    fields.forEach((field, i) => {
      if (field.type === "checkbox") field.checked = prefs.config[i];
      else if (field.type !== "range") field.value = prefs.config[i];
      field.dispatchEvent(new Event("input"));
      field.dispatchEvent(new Event("change"));
    });
  }
  const accountPanel = el("section", { class: "simulation-accounts", "aria-label": "模拟账号管理" }, deletionControls, accounts, pages.element);
  const configTab = el("button", { type: "button", class: "secondary", onclick: () => selectPanel(false) }, "运行设置");
  const accountTab = el("button", { type: "button", class: "secondary", onclick: () => selectPanel(true) }, "账号管理");
  view.append(el("div", { class: "simulation-tabs", role: "group", "aria-label": "模拟测试面板" }, configTab, accountTab), form, accountPanel);
  function selectPanel(showAccounts) {
    prefs.accountsTab = showAccounts;
    config.hidden = showAccounts;
    accountPanel.hidden = !showAccounts;
    configTab.setAttribute("aria-pressed", String(!showAccounts));
    accountTab.setAttribute("aria-pressed", String(showAccounts));
    if (showAccounts) drawAccounts();
  }
  const showSettings = () => { expand(); selectPanel(false); };
  form.addEventListener("invalid", showSettings, true);

  let active = true, busy = false, polling = false, run, users = [], deletion, deletionBusy = false;
  let accountKey;
  const selected = new Set(prefs.selected || []);
  const report = (node, status, error = false) => {
    node.hidden = false;
    node.classList.toggle("error", error);
    node.textContent = status;
  };
  filter.value = prefs.filter || "";
  let page = prefs.page || 0, usersRevision = "", pageSize = prefs.pageSize || 12, pageRows = [];
  const filteredUsers = () => {
    const q = filter.value.trim().toLowerCase();
    return users.filter((u) => u.username.toLowerCase().includes(q));
  };
  const deletionRunning = () => deletion && deletion.phase !== "finished";
  function drawAccounts() {
    if (!expanded()) return;
    const shown = filteredUsers();
    const locked = !!deletionRunning() || deletionBusy;
    deleteBatch.textContent = selected.size ? `顺序删除所选（${selected.size}）` : "顺序删除所选";
    deleteBatch.disabled = locked || !selected.size || selected.size > SIMULATION_MAX_USERS;
    stopDeletion.disabled = deletionBusy || !deletionRunning() || deletion.phase === "stopping";
    const countPages = Math.max(1, Math.ceil(shown.length / pageSize));
    page = Math.min(page, countPages - 1);
    pages.update({ page: page + 1, last: countPages, text: `第 ${page + 1} / ${countPages} 页 · 共 ${shown.length} 个账号` });
    const rows = pageRows = shown.slice(page * pageSize, (page + 1) * pageSize);
    const allSelected = rows.length > 0 && rows.every((u) => selected.has(u.id));
    selectPage.textContent = allSelected ? "取消本页选择" : "选择本页";
    selectPage.disabled = locked || !rows.length;
    selectAll.disabled = locked || !users.length || selected.size === users.length;
    clearSelection.disabled = locked || !selected.size;
    const selectionLabel = `已选 ${selected.size} / ${users.length} 个测试账号`
      + (selected.size > SIMULATION_MAX_USERS ? ` · 单次最多删除 ${SIMULATION_MAX_USERS} 个` : "");
    if (selectionText.textContent !== selectionLabel) selectionText.textContent = selectionLabel;
    const key = JSON.stringify([rows, locked]);
    if (key !== accountKey) {
      accountKey = key;
      accounts.replaceChildren(...(rows.length ? rows.map((u) => el("button", {
        type: "button", class: "simulation-user-key secondary", "data-user-id": u.id, disabled: locked,
        title: u.run_id ? `${u.username} · 运行批次 ${u.run_id}` : u.username,
        onclick: () => { selected.has(u.id) ? selected.delete(u.id) : selected.add(u.id); drawAccounts(); },
      }, el("span", { class: "simulation-user-name" }, u.username))) : [el("p", { class: "empty" }, "没有匹配的模拟账号")]));
    }
    for (const key of accounts.querySelectorAll("[data-user-id]")) {
      key.setAttribute("aria-pressed", String(selected.has(key.dataset.userId)));
    }
  }
  function controls() {
    const running = run && run.phase !== "finished";
    start.disabled = busy || running;
    stop.disabled = busy || !running || run.phase === "stopping";
  }
  async function load() {
    if (polling || !active) return;
    polling = true;
    try {
      const full = expanded();
      const path = !full ? "simulation?status_only=1"
        : usersRevision ? "simulation?users_revision=" + encodeURIComponent(usersRevision) : "simulation";
      const data = await api("GET", path);
      if (!active) return;
      run = data.run;
      if (full && data.users_revision !== usersRevision) {
        users = data.users || [];
        const available = new Set(users.map((u) => u.id));
        for (const id of selected) if (!available.has(id)) selected.delete(id);
      }
      if (full) usersRevision = data.users_revision;
      if (!deletionBusy) deletion = data.deletion;
      deletionSummary.hidden = !deletion;
      if (deletion) {
        const phase = { running: "正在顺序删除", stopping: "正在停止删除", finished: "顺序删除已结束" }[deletion.phase];
        deletionSummary.textContent = `${phase} · 已删除 ${deletion.deleted}/${deletion.total} · 跳过 ${deletion.skipped} · 失败 ${deletion.failed}`;
      }
      if (run) {
        const phase = { setup: "准备中 · 已上线用户可执行动作", running: "运行中", stopping: "正在停止", finished: "已结束" }[run.phase] || run.phase;
        const left = run.phase === "running" && run.ends_at ? ` · 剩余约 ${Math.max(0, Math.ceil((run.ends_at - Date.now()) / 1000))} 秒` : "";
        const actions = [...labels].filter(([id]) => run.actions[id]).map(([id, label]) => `${label} ${run.actions[id]}`);
        summary.textContent = [phase + left, `参与 ${run.count} 人`, `新注册 ${run.created}`, `复用 ${run.reused}`,
          `跳过重名普通账号 ${run.conflicts}`, ...actions,
          `跳过 ${run.skipped}`, `失败 ${run.failed}`, run.last_error].filter(Boolean).join(" · ");
      } else {
        summary.textContent = "等待启动";
      }
      controls();
      drawAccounts();
    } catch (e) {
      if (active) summary.textContent = errText(e);
    } finally {
      polling = false;
    }
  }
  filter.addEventListener("input", () => { page = 0; drawAccounts(); });
  selectPage.addEventListener("click", () => {
    const remove = pageRows.every((u) => selected.has(u.id));
    for (const u of pageRows) remove ? selected.delete(u.id) : selected.add(u.id);
    drawAccounts();
  });
  selectAll.addEventListener("click", () => {
    for (const user of users) selected.add(user.id);
    drawAccounts();
  });
  clearSelection.addEventListener("click", () => { selected.clear(); drawAccounts(); });
  const updatePrefixLimit = () => { prefix.maxLength = 31 - String(count.valueAsNumber || 1).length; };
  count.addEventListener("input", updatePrefixLimit);
  updatePrefixLimit();
  deleteBatch.addEventListener("click", async () => {
    const ids = [...selected];
    if (deletionBusy || deletionRunning() || !ids.length || ids.length > SIMULATION_MAX_USERS || !interval.input.reportValidity()) return;
    deletionBusy = true;
    drawAccounts();
    report(deletionFeedback, "正在提交顺序删除…");
    try {
      deletion = await api("POST", "simulation/deletions/start", {
        user_ids: ids, interval_ms: interval.input.valueAsNumber, keep_comments: keepComments.checked,
      });
      selected.clear();
      deletionFeedback.hidden = true;
    } catch (e) {
      report(deletionFeedback, errText(e), true);
    } finally {
      deletionBusy = false;
      drawAccounts();
      load();
    }
  });
  stopDeletion.addEventListener("click", async () => {
    deletionBusy = true;
    drawAccounts();
    report(deletionFeedback, "正在发送停止请求…");
    try {
      await api("POST", "simulation/deletions/stop", {});
      deletionFeedback.hidden = true;
    } catch (e) {
      report(deletionFeedback, errText(e), true);
    } finally {
      deletionBusy = false;
      drawAccounts();
      load();
    }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const actions = {};
    for (const [id, { enabled, lower, upper }] of settings) {
      if (!enabled.checked) continue;
      if (Number(upper.value) < Number(lower.value)) { showSettings(); report(runFeedback, "最长间隔必须大于或等于最短间隔", true); return; }
      actions[id] = { min_seconds: Number(lower.value), max_seconds: Number(upper.value) };
    }
    if (Number(joinMax.value) < Number(joinMin.value)) { showSettings(); report(runFeedback, "最多加入数必须大于或等于最少加入数", true); return; }
    busy = true;
    controls();
    report(runFeedback, "正在启动模拟…");
    try {
      await api("POST", "simulation/start", {
        prefix: prefix.value, count: Number(count.value), duration_seconds: duration.input.valueAsNumber,
        own_channel: own.checked, users_per_channel: own.checked ? usersPerChannel.valueAsNumber : 1,
        use_public_channels: usePublic.checked, friends: Number(friends.value),
        join_min: Number(joinMin.value), join_max: Number(joinMax.value), actions,
        texts: texts.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      });
      runFeedback.hidden = true;
    } catch (e) {
      report(runFeedback, errText(e), true);
    } finally {
      busy = false;
      controls();
      load();
    }
  });
  stop.addEventListener("click", async () => {
    busy = true;
    controls();
    report(runFeedback, "正在发送停止请求…");
    try {
      await api("POST", "simulation/stop", {});
      runFeedback.hidden = true;
    } catch (e) {
      report(runFeedback, errText(e), true);
    } finally {
      busy = false;
      controls();
      load();
    }
  });
  const timer = setInterval(load, 1200);
  selectPanel(prefs.accountsTab === true);
  const stopResize = watchPageSize(accounts, () => {
    if (!expanded() || !accounts.clientWidth) return pageSize;
    const columns = Math.max(1, Math.floor((accounts.clientWidth + 8) / 153));
    const rows = Math.max(1, Math.floor((accounts.clientHeight + 8) / 46));
    return Math.min(100, rows * columns);
  }, (nextSize) => {
    page = Math.floor((page * pageSize) / nextSize);
    pageSize = nextSize;
    if (usersRevision) drawAccounts();
  });
  const dispose = () => {
    prefs.config = fields.map((field) => field.type === "checkbox" ? field.checked : field.value);
    Object.assign(prefs, { filter: filter.value, page, pageSize, selected: [...selected] });
    active = false;
    stopResize();
    clearInterval(timer);
  };
  load();
  return { dispose, load };
}

function simulationWindowFrames(large, small) {
  const settle = (value) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  const frames = [];
  for (let step = 0; step <= 24; step++) {
    const time = step / 24;
    const left = [], right = [];
    // Lower rows lag behind the header so the silhouette bends as it retracts.
    for (let row = 0; row <= 10; row++) {
      const delay = .38 * Math.pow(row / 10, 1.25);
      const progress = settle((time - delay) / (1 - delay));
      left.push((small.left - large.left) * progress);
      right.push(large.width + (small.right - large.right) * progress);
    }
    const x = Math.min(...left);
    const drop = settle((time - .14) / .86);
    const width = large.width + (small.width - large.width) * drop;
    const y = (small.top - large.top) * drop;
    const height = large.height + (small.height - large.height) * drop;
    const point = (value, row) => (Math.min(1, (value - x) / width) * 100) + "% " + row * 10 + "%";
    const leftSide = left.map(point);
    const rightSide = right.map(point).reverse();
    frames.push({
      transform: `translate3d(${x}px, ${y}px, 0) scale(${width / large.width}, ${height / large.height})`,
      clipPath: `polygon(${[...leftSide, ...rightSide].join(", ")})`,
    });
  }
  return frames;
}

async function renderLive(view, _parts, { api, prefs, openSimulation }) {
  view.classList.add("live-view");
  const placeholder = el("p", { class: "live-loading", role: "status" }, "正在加载实况…");
  view.append(placeholder);
  let dispose;
  let disposePanel;
  let cancelMorph;
  let simulationPanel;
  let closed = false;
  state.disposeView = () => { closed = true; cancelMorph?.(); disposePanel?.(); dispose?.(); };
  try {
    const { mountLive } = await import("./live.js");
    if (!closed) {
      dispose = mountLive(view, {
        fetchSnapshot: () => api("GET", "live/snapshot"),
        fetchStats: (minutes, since, startedAt) => api("GET", "live/stats?" + new URLSearchParams({
          minutes, since, started_at: startedAt,
        })),
        fetchFriends: (id) => api("GET", "live/users/" + encodeURIComponent(id) + "/friends"),
        onEvent: (handler) => { state.onEvent = handler; },
        connected: () => state.events?.readyState === EventSource.OPEN,
        markUpdated: () => { lastUpdate = Date.now(); },
        errText, integerWheel,
      }, prefs);
      state.onSimulationChange = () => {
        if (!canSimulate()) {
          cancelMorph?.();
          cancelMorph = null;
          disposePanel?.();
          disposePanel = null;
          simulationPanel?.remove();
          simulationPanel = null;
          return;
        }
        if (simulationPanel) return;
        const simulationPrefs = state.pages.get("simulation") || {};
        state.pages.set("simulation", simulationPrefs);
        let simulation, targetExpanded, morph, morphListeners;
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
        const body = el("div", { class: "simulation-float-body" });
        const expand = () => setExpanded(true);
        const resize = el("button", { type: "button", class: "secondary", onclick: () => setExpanded(!targetExpanded) });
        const summary = el("summary", {}, "模拟测试");
        const panel = el("details", { class: "live-simulation-float", open: openSimulation || prefs.simulationOpen },
          summary, el("div", { class: "simulation-float-tools" }, resize), body);
        simulationPanel = panel;
        $(".live-space", view).append(panel);
        function finishMorph(refresh = true) {
          const animation = morph;
          morph = null;
          morphListeners?.abort();
          morphListeners = null;
          animation?.cancel();
          panel.classList.toggle("expanded", targetExpanded);
          panel.classList.remove("morphing");
          if (refresh && panel.open) simulation?.load();
        }
        cancelMorph = () => finishMorph(false);
        function setExpanded(expanded, animate = true) {
          if (targetExpanded === expanded) return;
          targetExpanded = expanded;
          resize.textContent = expanded ? "缩小" : "放大设置";
          resize.setAttribute("aria-expanded", String(expanded));
          prefs.simulationExpanded = expanded;
          if (!animate || !panel.open || reducedMotion.matches || typeof panel.animate !== "function") {
            finishMorph();
            return;
          }
          if (morph) {
            morph.reverse();
            return;
          }
          panel.classList.remove("opening");
          panel.classList.add("morphing");
          panel.classList.remove("expanded");
          const small = panel.getBoundingClientRect();
          panel.classList.add("expanded");
          const large = panel.getBoundingClientRect();
          if (!small.width || !small.height || !large.width || !large.height) {
            finishMorph();
            return;
          }
          const duration = 520;
          const animation = panel.animate(simulationWindowFrames(large, small), { duration, fill: "both" });
          morph = animation;
          if (expanded) {
            animation.currentTime = duration;
            animation.playbackRate = -1;
          }
          animation.onfinish = () => { if (morph === animation) finishMorph(); };
          morphListeners = new AbortController();
          const options = { signal: morphListeners.signal };
          window.addEventListener("resize", () => finishMorph(), options);
          reducedMotion.addEventListener("change", () => finishMorph(), options);
        }
        setExpanded(openSimulation || prefs.simulationExpanded === true, false);
        const sync = () => {
          if (closed || simulationPanel !== panel) return;
          prefs.simulationOpen = panel.open;
          if (panel.open && !simulation) {
            if (!targetExpanded && !reducedMotion.matches) panel.classList.add("opening");
            simulation = renderSimulation(body, { api, prefs: simulationPrefs,
              expanded: () => panel.classList.contains("expanded"), expand });
            disposePanel = simulation.dispose;
          } else if (!panel.open && simulation) {
            finishMorph(false);
            panel.classList.remove("opening");
            simulation.dispose();
            simulation = null;
            disposePanel = null;
            body.replaceChildren();
          }
        };
        panel.addEventListener("keydown", (e) => {
          if (e.key !== "Escape" || !panel.open) return;
          e.preventDefault();
          if (targetExpanded) {
            setExpanded(false);
            resize.focus();
          } else {
            panel.open = false;
            summary.focus();
          }
        });
        panel.addEventListener("toggle", sync);
        panel.addEventListener("animationend", (event) => {
          if (event.target === panel && event.animationName === "window-arrival") panel.classList.remove("opening");
        });
        sync();
        if (openSimulation) resize.focus({ preventScroll: true });
      };
      state.onSimulationChange();
    }
  } catch (e) {
    if (!closed) placeholder.textContent = "实况页面加载失败";
  }
}

// ---------- live events ----------

let lastUpdate = 0;
let identityRequest;

function connection(status) {
  const indicator = $("#live");
  const time = lastUpdate && new Date(lastUpdate).toLocaleTimeString("zh-CN", { hour12: false });
  indicator.dataset.state = status;
  indicator.textContent = status === "open" ? "实时连接"
    : status === "connecting" ? "正在连接"
    : "连接中断" + (time ? " · 更新于 " + time : "");
}

function refreshIdentity(queue = false) {
  if (!state.me) return;
  const session = state.session;
  if (identityRequest?.session === session) {
    if (queue) identityRequest.again = true;
    return identityRequest.promise;
  }
  const promise = api("GET", "me").then((me) => {
    if (session !== state.session) return;
    if (me.id !== state.me.id) { showLogin("登录账号已变更，请重新进入后台。"); return; }
    const changed = me.perms.join() !== state.me.perms.join() || me.super !== state.me.super;
    const simulationChanged = me.simulation !== state.me.simulation;
    state.me = me;
    if (changed) {
      closeDrawer(false);
      drawNavigation();
      state.pages.clear();
      route({ notice: "管理权限或功能状态已更新。" });
    } else if (simulationChanged) state.onSimulationChange?.();
  }).catch(() => { /* api handles expired sessions */ }).finally(() => {
    if (identityRequest?.promise !== promise) return;
    const again = identityRequest.again;
    identityRequest = null;
    if (again && session === state.session) refreshIdentity();
  });
  identityRequest = { session, promise };
  return promise;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshIdentity();
});

function openEvents() {
  closeEvents();
  const es = new EventSource("api/events");
  state.events = es;
  es.onopen = () => {
    if (state.events !== es) return;
    lastUpdate ||= Date.now();
    connection("open");
    state.onEvent?.({ type: "stream.open" });
    refreshIdentity(true);
  };
  es.onerror = () => {
    if (state.events !== es) return;
    connection("closed");
    state.onEvent?.({ type: "stream.closed" });
    refreshIdentity();
  };
  es.onmessage = (m) => {
    if (state.events !== es) return;
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    lastUpdate = Date.now();
    if (ev.type === "simulation.setting") { refreshIdentity(true); return; }
    if (state.onEvent) state.onEvent(ev);
  };
}

function closeEvents() {
  if (state.events) { state.events.close(); state.events = null; }
  lastUpdate = 0;
  connection("connecting");
}

// ---------- users ----------

function userTags(u) {
  return [
    u.online && el("span", { class: "tag on" }, "在线"),
    u.ban && el("span", { class: "tag ban", title: u.ban.reason }, "封禁至 " + fmtUntil(u.ban.expires_at)),
    u.mute && el("span", { class: "tag mute", title: u.mute.reason }, "禁言至 " + fmtUntil(u.mute.expires_at)),
    u.super ? el("span", { class: "tag admin" }, "超级管理员") : u.admin && el("span", { class: "tag admin" }, "管理员"),
  ];
}

async function renderUsers(view, [id], context) {
  if (id) return renderUserDetail(view, id, context);
  const { api, prefs } = context;
  view.append(el("h2", {}, "用户"));
  const q = el("input", { type: "search", placeholder: "按用户名筛选", "aria-label": "按用户名筛选", value: prefs.filter || "" });
  const table = el("div");
  const deletedUser = prefs.deletedUser;
  if (deletedUser) {
    view.append(el("p", { class: "operation-status", role: "status" }, "已删除账号 " + deletedUser));
    delete prefs.deletedUser;
    delete prefs.userPage;
  }
  view.append(el("div", { class: "toolbar" }, q), table);

  let filterTimer;
  state.disposeView = () => { clearTimeout(filterTimer); prefs.filter = q.value; };
  const draw = (rows) => {
    table.replaceChildren(rows.length ? el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "用户名"), el("th", {}, "状态"), el("th", { class: "opt" }, "客户端"), el("th", { class: "opt" }, "注册于"))),
      el("tbody", {}, rows.map((u) => el("tr", {},
        el("td", {}, el("a", { href: "#users/" + encodeURIComponent(u.id) }, u.username)),
        el("td", {}, userTags(u)),
        el("td", { class: "opt mono" }, (u.client_versions || []).map((v) => v === "unknown" ? "未知" : v).join(", ")),
        el("td", { class: "opt faint" }, fmtTime(u.created_at)))))) : el("p", { class: "empty" }, "没有匹配的用户"));
  };

  const pages = responsiveList({
    container: view, list: table, label: "用户列表分页", rowHeight: 36, cache: prefs.userPage ??= {}, indexed: true,
    fetch: (limit, page, signal) => api("GET", "users?" + new URLSearchParams({ limit, page, q: q.value.trim() }), undefined, signal),
    draw: ({ users }) => draw(users),
  });
  q.addEventListener("input", () => {
    delete prefs.userPage.current;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(pages.reset, 180);
  });
  state.onEvent = (ev) => {
    if (["online", "offline", "registered", "sanction", "account.deleted"].includes(ev.type)) pages.refreshFirst();
  };
  await pages.restore();
}

const DURATIONS = [
  ["60", "1 小时"], ["1440", "1 天"], ["10080", "7 天"], ["43200", "30 天"], ["custom", "自定义"], ["0", "永久"],
];

function sanctionForm(kind) {
  const reason = el("textarea", { name: "reason", rows: 3, required: true, maxlength: 500, placeholder: "必填，会显示给对方" });
  const dur = el("select", { name: "duration" }, DURATIONS.map(([v, l]) => el("option", { value: v }, l)));
  const custom = el("input", { name: "custom", type: "number", min: 1, step: 1, value: 3, hidden: true });
  const unit = el("select", { name: "unit", hidden: true }, el("option", { value: "60" }, "小时"), el("option", { value: "1440" }, "天"));
  dur.addEventListener("change", () => { custom.hidden = unit.hidden = dur.value !== "custom"; });
  return {
    body: [
      el("label", {}, kind === "ban" ? "封禁原因" : "禁言原因", reason),
      el("label", {}, "时长", el("div", { class: "toolbar" }, dur, custom, unit)),
      kind === "ban" ? el("p", { class: "muted" }, "封禁会立即断开对方的所有连接，并让已保存的登录失效。") : el("p", { class: "muted" }, "禁言期间可以登录和阅读，但不能发消息、编辑消息或建频道。"),
    ],
    values() {
      if (!reason.value.trim()) throw new Error("请填写原因");
      let minutes = Number(dur.value);
      if (dur.value === "custom") {
        const n = Math.floor(Number(custom.value));
        if (!(n >= 1)) throw new Error("请输入有效的时长");
        minutes = n * Number(unit.value);
      }
      return { reason: reason.value.trim(), minutes };
    },
  };
}

async function renderUserDetail(view, id, { api, prefs }) {
  view.append(el("p", {}, el("a", { href: "#users" }, "← 全部用户")));
  const box = el("div");
  const feedback = el("p", { class: "operation-status", role: "status", hidden: true });
  view.append(feedback, box);
  let loading = 0;
  const load = async () => {
    const revision = ++loading;
    let u;
    try { u = await api("GET", "users/" + encodeURIComponent(id)); }
    catch (e) {
      if (revision === loading) box.replaceChildren(el("p", { class: "error" }, errText(e)));
      return;
    }
    if (revision !== loading) return;
    const self = u.id === state.me.id;
    const protectedUser = u.super || self;
    const report = (text, error = false) => {
      feedback.hidden = false;
      feedback.textContent = text;
      feedback.classList.toggle("error", error);
    };
    const sanction = (kind) => async () => {
      const f = sanctionForm(kind);
      const ok = await modal(kind === "ban" ? `封禁 ${u.username}` : `禁言 ${u.username}`, f.body, kind === "ban" ? "封禁" : "禁言",
        () => api("POST", `users/${encodeURIComponent(u.id)}/${kind}`, f.values()), true);
      if (ok) { report(kind === "ban" ? "已封禁" : "已禁言"); load(); }
    };
    const resetPw = async () => {
      const p1 = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8 });
      const p2 = el("input", { type: "password", autocomplete: "new-password", required: true });
      const ok = await modal(`重置 ${u.username} 的密码`, [
        el("label", {}, "新密码（至少 8 个字符）", p1), el("label", {}, "再输入一次", p2),
        el("p", { class: "muted" }, "对方的所有登录会立即失效，需要用新密码重新登录。"),
      ], "重置", () => {
        if (p1.value !== p2.value) throw new Error("两次输入的密码不一致");
        return api("POST", `users/${encodeURIComponent(u.id)}/reset-password`, { password: p1.value });
      }, true);
      if (ok) report("密码已重置");
    };
    const kick = async () => {
      const ok = await modal(`让 ${u.username} 下线`, el("p", {}, "对方会立即下线，但可以马上重新登录。这不是处分。"), "下线",
        () => api("POST", `users/${encodeURIComponent(u.id)}/kick`, {}), true);
      if (ok) { report("已下线"); load(); }
    };
    const revoke = async (sc) => {
      if (revoking) return;
      revoking = true;
      report("正在解除处分…");
      try {
        await api("POST", `users/${encodeURIComponent(u.id)}/revoke`, { sanction_id: sc.id });
        report("已解除处分");
        await load();
      } catch (e) { report(errText(e), true); }
      finally { revoking = false; }
    };

    box.replaceChildren(
      el("h2", {}, u.username, " ", userTags(u)),
      el("dl", { class: "kv" },
        el("dt", {}, "注册于"), el("dd", {}, fmtTime(u.created_at)),
        el("dt", {}, "在线客户端"), el("dd", { class: "mono" }, u.online ? u.client_versions.map((v) => v === "unknown" ? "未知" : v).join(", ") : "离线"),
        el("dt", {}, "管理权限"), el("dd", {}, u.super ? "全部（超级管理员）" : u.perms.length ? u.perms.map((p) => PERM_LABEL[p] || p).join("、") : "无"),
        el("dt", {}, "自助找回"), el("dd", {}, u.can_recover ? "已设置安全问题" : "未设置，只能由管理员重置密码")),
      protectedUser ? el("p", { class: "muted" }, self ? "不能处置自己。" : "超级管理员不能被处置。") : el("div", { class: "detail-actions" },
        el("button", { class: "danger", onclick: sanction("ban") }, u.ban ? "重新封禁" : "封禁"),
        el("button", { class: "secondary", onclick: sanction("mute") }, u.mute ? "重新禁言" : "禁言"),
        u.ban && el("button", { class: "secondary", onclick: () => revoke(u.ban) }, "解除封禁"),
        u.mute && el("button", { class: "secondary", onclick: () => revoke(u.mute) }, "解除禁言"),
        el("button", { class: "secondary", onclick: resetPw }, "重置密码"),
        u.online && el("button", { class: "secondary", onclick: kick }, "强制下线"),
        state.me.super && !u.admin && el("button", { class: "danger", onclick: async () => {
          if (await confirmAccountDeletion(u, api) && view.isConnected) {
            prefs.deletedUser = u.username;
            location.hash = "users";
          }
        } }, "删除账号")),
      el("h3", {}, "当前会话来源"),
      u.sessions.length ? el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "类型"), el("th", {}, "来源"), el("th", {}, "设备"), el("th", {}, "客户端版本"), el("th", { class: "opt" }, "签发于"), el("th", { class: "opt" }, "过期于"))),
        el("tbody", {}, u.sessions.map((s) => el("tr", {},
          el("td", {}, s.purpose === "admin" ? "管理后台" : "聊天"),
          el("td", { class: "mono" }, s.remote),
          el("td", {}, s.device),
          el("td", { class: "mono" }, s.client_version === "unknown" ? "未知" : s.client_version || "—"),
          el("td", { class: "opt faint" }, fmtTime(s.created_at)),
          el("td", { class: "opt faint" }, fmtTime(s.expires_at)))))) : el("p", { class: "empty" }, "没有有效的登录"),
      el("h3", {}, "处分历史"),
      u.sanctions.length ? el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "类型"), el("th", {}, "原因"), el("th", {}, "时间"), el("th", {}, "到期"), el("th", {}, "状态"), el("th", { class: "opt" }, "操作人"))),
        el("tbody", {}, u.sanctions.map((sc) => el("tr", {},
          el("td", {}, sc.kind === "ban" ? "封禁" : "禁言"),
          el("td", {}, sc.reason),
          el("td", { class: "faint" }, fmtTime(sc.created_at)),
          el("td", { class: "faint" }, fmtUntil(sc.expires_at)),
          el("td", {}, sc.active ? el("span", { class: "tag " + sc.kind }, "生效中")
            : sc.revoked_at ? `已由 ${sc.revoked_by_name} 解除（${fmtTime(sc.revoked_at)}）`
            : sc.superseded_by ? "被新处分取代" : "已到期"),
          el("td", { class: "opt" }, sc.created_by_name))))) : el("p", { class: "empty" }, "没有处分记录"),
    );
  };
  let revoking = false;
  state.onEvent = (ev) => {
    if (ev.data && ev.data.user_id === id && ["online", "offline", "sanction", "account.deleted"].includes(ev.type)) load();
  };
  await load();
}

// ---------- conversations ----------

async function renderChats(view, [openId], { api, toast, prefs }) {
  view.classList.add("split");
  const filter = el("input", { type: "search", placeholder: "筛选会话", "aria-label": "筛选会话", value: prefs.filter || "" });
  const list = el("div");
  const convList = el("div", { class: "convs" }, el("header", {},
    el("h2", {}, "会话"), filter), list);
  const pane = el("div", { class: "pane" }, el("div", { class: "empty" }, "选择左侧的会话查看消息"));
  view.append(el("div", { class: "split-grid" }, convList, pane));
  let filterTimer;
  state.disposeView = () => {
    clearTimeout(filterTimer);
    prefs.filter = filter.value;
    prefs.conversationScroll = convList.scrollTop;
  };

  let current;
  const directory = responsiveList({
    container: convList, list, label: "会话列表分页", rowHeight: 55, indexed: true,
    fetch: (limit, page, signal) => api("GET", "conversations?" + new URLSearchParams({ limit, page, q: filter.value.trim() }), undefined, signal),
    draw: ({ conversations }) => {
      const focus = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
      list.replaceChildren(...(conversations.length ? conversations.map((c) =>
        el("a", { class: "conv" + (openId === c.id ? " on" : ""), "data-id": c.id, href: "#chats/" + encodeURIComponent(c.id), "aria-current": openId === c.id ? "page" : null },
          el("div", { class: "l" }, el("span", { class: "n" }, c.kind === "dm" ? "🔒 " + c.label : c.label), el("span", { class: "t" }, fmtShort(c.last_at))),
          el("div", { class: "faint", style: "font-size:12px" }, `${c.message_count} 条消息 · ${c.members} 人`)))
        : [el("p", { class: "empty" }, "没有匹配的会话")]));
      if (focus) (list.querySelector(`[data-id="${CSS.escape(focus)}"]`) || filter).focus({ preventScroll: true });
    },
  });
  filter.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(directory.reset, 180);
  });

  const msgNode = (m, fresh) => el("div", { class: "msg" + (m.deleted ? " del" : "") + (fresh ? " new" : ""), "data-id": m.id },
    el("div", { class: "h" }, el("span", { class: "a" }, m.author_name), el("span", { class: "tm" }, fmtTime(m.created_at)),
      m.edited_at && !m.deleted ? el("span", { class: "tm" }, "已编辑") : null),
    el("div", { class: "b" }, m.deleted ? "（消息已删除）" : m.body));

  async function open(id) {
    const box = el("div", { class: "msgs" });
    const heading = el("h2", { tabindex: -1 }, "会话消息");
    const detail = el("div", { class: "sub" }, "查看会记入审计日志");
    const header = el("div", { class: "pane-head" }, heading, detail);
    const pages = pager("会话消息分页", (target) => load(target));
    const cursor = cursorPages();
    pane.classList.add("is-paged");
    pane.replaceChildren(header, box, pages.element);
    if (document.activeElement === $("h2", convList)) heading.focus({ preventScroll: true });

    current = { id, box, page: 1, messages: [], hasMore: false, size: 12, loading: false, changes: new Map() };
    const { changes } = current;
    let revision = 0, request;
    const stopResize = watchPageSize(pane, () => {
      return Math.min(200, Math.max(1, Math.floor((pane.clientHeight - header.offsetHeight - pages.element.offsetHeight - 20) / 52)));
    }, (size, first) => {
      current.size = size;
      if (!first) load(1, true);
    }, header, pages.element);
    const dispose = state.disposeView;
    state.disposeView = () => { revision++; request?.abort(); stopResize(); dispose(); };

    function updatePager() {
      const state = cursor.state();
      pages.update({ ...state, page: current.page, busy: current.loading, text: current.loading ? "正在读取消息…"
        : `${current.page === 1 ? "最新一页" : `第 ${current.page} 页`} · 每页 ${current.size} 条` });
    }
    current.updatePager = updatePager;
    current.updateEdge = () => cursor.note(1, current.hasMore ? current.messages[0]?.seq : null);

    async function load(target, reset = false) {
      const generation = ++revision;
      request?.abort();
      const signal = (request = new AbortController()).signal;
      if (reset) { cursor.clear(); current.page = 1; }
      const size = current.size;
      current.loading = true;
      changes.clear();
      updatePager();
      try {
        const loaded = await cursor.read(target, async (before = 0) => {
          const query = new URLSearchParams({ limit: size, before });
          const page = await api("GET", `conversations/${encodeURIComponent(id)}/messages?` + query, undefined, signal);
          return { ...page, next: page.has_more ? page.messages[0]?.seq : null };
        }, signal);
        if (generation !== revision) return;
        const { page, result: data } = loaded;
        const c = data.conversation;
        heading.textContent = c.kind === "dm" ? "私聊 " + c.label : c.label;
        detail.textContent = (c.topic ? c.topic + " · " : "") + "查看会记入审计日志";
        current.page = page;
        const messages = data.messages.map((m) => changes.get(m.id)?.message || m);
        if (page === 1) {
          const ids = new Set(messages.map((m) => m.id));
          for (const [id, change] of changes) {
            if (change.fresh && !ids.has(id)) messages.push(change.message);
          }
          messages.sort((a, b) => a.seq - b.seq);
        }
        current.hasMore = data.has_more || messages.length > size;
        current.messages = messages.slice(-size);
        if (page === 1) current.updateEdge();
        box.replaceChildren(...(current.messages.length ? current.messages.map((m) => msgNode(m, false))
          : [el("p", { class: "empty" }, "还没有消息")]));
        box.scrollTop = page === 1 ? box.scrollHeight : 0;
      } catch (e) {
        if (generation !== revision) return;
        if (current.messages.length) toast(errText(e), true);
        else box.replaceChildren(el("p", { class: "error" }, errText(e)),
          el("button", { type: "button", class: "secondary", onclick: () => load(target) }, "重试"));
      } finally {
        if (generation === revision) {
          current.loading = false;
          changes.clear();
          updatePager();
        }
      }
    }
    await load(1);
  }

  state.onEvent = (ev) => {
    if (ev.type === "stream.open" || (ev.type === "activity" && /^channel\.(created|deleted|joined|left)$/.test(ev.data?.kind))) {
      directory.refreshFirst();
    }
    if (!ev.type.startsWith("message") || !ev.data || !ev.data.message) return;
    const m = ev.data.message;
    if (ev.type === "message") directory.refreshFirst();
    if (!current || current.id !== m.conversation_id) return;
    if (current.loading) {
      const prior = current.changes.get(m.id);
      current.changes.set(m.id, { message: m, fresh: prior?.fresh || ev.type === "message" });
      if (current.changes.size > 2 * current.size) current.changes.delete(current.changes.keys().next().value);
    }
    const box = current.box;
    const existing = box.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (existing) {
      const index = current.messages.findIndex((item) => item.id === m.id);
      current.messages[index] = m;
      existing.replaceWith(msgNode(m, true));
      return;
    }
    if (ev.type !== "message" || current.page !== 1 || current.loading) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    $(".empty", box)?.remove();
    box.append(msgNode(m, true));
    current.messages.push(m);
    if (current.messages.length > current.size) {
      current.messages.shift();
      current.hasMore = true;
      box.firstElementChild.remove();
      current.updateEdge();
      current.updatePager();
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  };

  await Promise.all([directory.reset(), openId && open(openId)]);
  if (view.isConnected) convList.scrollTop = prefs.conversationScroll || 0;
}

// ---------- search ----------

function dateMs(v, endOfDay) {
  if (!v) return "";
  const d = new Date(v + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
  return isNaN(d) ? "" : String(d.getTime());
}

function searchTerms(value) {
  return [...new Set([...value.matchAll(/"([^"]*)"|[^\s,，、;；]+/gu)]
    .map((match) => (match[1] ?? match[0]).trim()).filter(Boolean))];
}

function searchPattern(terms) {
  if (!terms.length) return null;
  const literals = [...terms].sort((a, b) => b.length - a.length).map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[A-Za-z]/g, (char) => "[" + char.toLowerCase() + char.toUpperCase() + "]"));
  return new RegExp(literals.join("|"), "gu");
}

function markSearchText(text, pattern, limit = 48, start = 0, stop = text.length) {
  if (!pattern) return document.createTextNode(text.slice(start, stop));
  const fragment = document.createDocumentFragment();
  let count = 0;
  pattern.lastIndex = start;
  const matches = text.matchAll(pattern);
  pattern.lastIndex = 0;
  for (const match of matches) {
    if (count++ === limit || match.index >= stop) break;
    const end = Math.min(stop, match.index + match[0].length);
    fragment.append(text.slice(start, match.index), el("mark", {}, text.slice(match.index, end)));
    start = end;
  }
  fragment.append(text.slice(start, stop));
  return fragment;
}

function searchExcerpt(body, terms, pattern) {
  const length = 240;
  if (body.length <= length) return markSearchText(body, pattern);
  const fold = (text) => text.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const haystack = fold(body);
  const matches = terms.map((term) => [haystack.indexOf(fold(term)), term.length])
    .filter(([at]) => at >= 0).sort(([a], [b]) => a - b);
  const windows = [];
  for (const [at, span] of matches) {
    const start = Math.max(0, at - 25), end = Math.min(body.length, at + Math.min(span, 85) + 30);
    const prior = windows.at(-1);
    if (prior && start <= prior[1]) prior[1] = Math.min(prior[0] + length, Math.max(prior[1], end));
    else if (windows.length < 3) windows.push([start, end]);
  }
  if (!windows.length) windows.push([0, length]);
  const fragment = document.createDocumentFragment();
  let previous = 0;
  for (const [start, end] of windows) {
    if (start > previous) fragment.append(" … ");
    fragment.append(markSearchText(body, pattern, 48, start, end));
    previous = end;
  }
  if (previous < body.length) fragment.append(" …");
  return fragment;
}

async function renderSearch(view, _parts, { api, prefs }) {
  view.classList.add("search-view");
  view.append(el("h2", {}, "搜索消息"));
  const q = el("input", { type: "search", name: "q", placeholder: "例如 发布 v2", "aria-describedby": "search-terms-hint" });
  const author = el("input", { name: "author", placeholder: "用户名" });
  const conv = el("select", { name: "conversation" }, el("option", { value: "" }, "全部会话"));
  const convFilter = el("input", { type: "search", placeholder: "按名称查找会话", "aria-label": "按名称查找会话" });
  const moreConvs = el("button", { type: "button", class: "secondary", hidden: true }, "更多会话");
  const from = el("input", { type: "date" });
  const to = el("input", { type: "date" });
  const go = el("button", { type: "submit" }, "搜索");
  const results = el("div");
  const form = el("form", { class: "toolbar" },
    el("label", {}, "关键词", q), el("label", {}, "作者", author), el("label", {}, "查找会话", convFilter),
    el("label", {}, "会话", conv), moreConvs,
    el("label", {}, "从", from), el("label", {}, "到", to), go);
  const feedback = el("p", { class: "operation-status", role: "status", hidden: true });
  const fullBody = el("div", { class: "search-full-body" });
  const full = el("dialog", { class: "modal search-message-dialog", "aria-labelledby": "search-message-title" },
    el("h2", { id: "search-message-title" }, "消息全文"), fullBody,
    el("form", { method: "dialog", class: "actions" }, el("button", { class: "secondary" }, "关闭")));
  full.addEventListener("close", () => { if (!full.open) fullBody.replaceChildren(); });
  view.append(form, el("p", { id: "search-terms-hint", class: "muted" },
    "用空格或逗号分隔关键词，消息须包含全部词。固定短语用双引号括起。搜索条件会记入审计日志。"), feedback, results, full);
  q.value = prefs.q || "";
  author.value = prefs.author || "";
  from.value = prefs.from || "";
  to.value = prefs.to || "";
  let selectedConversation = prefs.conversation || "";
  let selectedLabel = prefs.conversationLabel || "已选会话", optionCursor, optionRevision = 0, optionTimer, optionRequest, optionsReady = false;
  if (selectedConversation) {
    conv.append(el("option", { value: selectedConversation }, selectedLabel));
    conv.value = selectedConversation;
  }
  async function loadOptions(after = "") {
    const revision = ++optionRevision;
    optionRequest?.abort();
    const signal = (optionRequest = new AbortController()).signal;
    moreConvs.disabled = true;
    try {
      const query = new URLSearchParams({ limit: 25, after, q: convFilter.value.trim() });
      const page = await api("GET", "conversations?" + query, undefined, signal);
      if (revision !== optionRevision) return;
      const choices = page.conversations.map((c) => el("option", { value: c.id }, (c.kind === "dm" ? "私聊 " : "") + c.label));
      if (selectedConversation && !choices.some((choice) => choice.value === selectedConversation)) {
        choices.unshift(el("option", { value: selectedConversation }, selectedLabel));
      }
      conv.replaceChildren(el("option", { value: "" }, "全部会话"), ...choices);
      conv.value = selectedConversation;
      optionCursor = page.next;
      moreConvs.hidden = !optionCursor;
      optionsReady = true;
    } catch (e) {
      if (revision === optionRevision && view.isConnected) report(errText(e));
    } finally {
      if (revision === optionRevision) { moreConvs.disabled = false; optionRequest = null; }
    }
  }
  function prepareOptions() {
    if (!optionsReady && !optionRequest && !optionTimer) loadOptions();
  }
  conv.addEventListener("focus", prepareOptions);
  conv.addEventListener("pointerdown", prepareOptions);
  convFilter.addEventListener("focus", prepareOptions);
  moreConvs.addEventListener("click", () => loadOptions(optionCursor));
  convFilter.addEventListener("input", () => {
    optionRevision++;
    clearTimeout(optionTimer);
    optionRequest?.abort();
    optionRequest = null;
    moreConvs.disabled = true;
    optionTimer = setTimeout(() => { optionTimer = null; loadOptions(); }, 180);
  });
  conv.addEventListener("change", () => {
    selectedConversation = conv.value;
    selectedLabel = conv.selectedOptions[0]?.textContent;
  });
  state.disposeView = () => {
    optionRevision++;
    optionRequest?.abort();
    clearTimeout(optionTimer);
    Object.assign(prefs, { q: q.value, author: author.value, from: from.value, to: to.value, conversation: selectedConversation, conversationLabel: selectedLabel });
  };

  let params = prefs.params;
  const cache = prefs.searchCache ??= {};
  function drawResults({ messages, next, keywords = [] }) {
    const pattern = searchPattern(keywords);
    const rows = messages.map((m) => {
      const metadata = el("td", { class: "search-meta" },
        el("a", { href: "#chats/" + encodeURIComponent(m.conversation_id) }, (m.conversation_kind === "dm" ? "🔒 " : "") + m.conversation_label),
        el("div", {}, m.author_name), el("time", { class: "muted" }, fmtTime(m.created_at)));
      const body = el("td", { class: "search-hit-body" }, el("div", { class: "search-excerpt" }, searchExcerpt(m.body, keywords, pattern)));
      if (m.body.length > 240) body.append(el("button", { class: "link", type: "button", onclick: () => {
        fullBody.replaceChildren(markSearchText(m.body, pattern, 500));
        full.showModal();
      } }, "查看全文"));
      return el("tr", {}, metadata, body);
    });
    results.replaceChildren(
      rows.length ? el("table", { class: "search-results" }, el("thead", {}, el("tr", {}, el("th", { class: "search-meta" }, "来源"), el("th", {}, "内容"))), el("tbody", {}, rows))
        : el("p", { class: "empty" }, next ? "本页没有匹配项，可以继续下一页" : "没有匹配的消息"));
  }
  const report = (text) => {
    feedback.hidden = false;
    feedback.textContent = text;
    feedback.classList.add("error");
  };
  const pages = responsiveList({
    container: view, list: results, label: "搜索结果分页", rowHeight: 70, max: 24, enabled: () => !!params, draw: drawResults, cache,
    fetch: (limit, cursor, signal) => {
      const p = new URLSearchParams(params);
      p.set("limit", limit);
      if (cursor) { p.set("cursor_at", cursor.at); p.set("cursor_id", cursor.id); }
      return api("GET", "search?" + p, undefined, signal);
    },
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = new URLSearchParams();
    const terms = searchTerms(q.value);
    if (terms.length > 16) { report("最多输入 16 个关键词"); return; }
    for (const term of terms) p.append("keyword", term);
    if (author.value.trim()) p.set("author", author.value.trim());
    if (selectedConversation) p.set("conversation", selectedConversation);
    if (from.value) p.set("from", dateMs(from.value, false));
    if (to.value) p.set("to", dateMs(to.value, true));
    if (!p.size) { report("至少填写一个条件"); return; }
    feedback.hidden = true;
    delete cache.current;
    params = prefs.params = p;
    pages.reset();
  });
  await pages.restore();
}

// ---------- moments ----------

// renderMoments lists every moment, private ones included, newest first. Each
// one and each comment can be deleted by someone who may also moderate users
// (spec admin-console / 动态浏览与删除).
async function renderMoments(view, _parts, { api, prefs }) {
  view.append(el("h2", {}, "朋友圈动态"));
  const author = el("input", { name: "author", placeholder: "作者用户名", value: prefs.author || "" });
  const go = el("button", { type: "submit" }, "筛选");
  const form = el("form", { class: "toolbar" }, el("label", {}, "作者", author), go);
  const canDelete = can("users.moderate");
  const list = el("div");
  const feedback = el("p", { class: "operation-status", role: "status", hidden: true });
  view.append(form, ...(canDelete ? [] : [el("p", { class: "muted" }, "删除动态和评论还需要「处置用户」权限。")]), feedback, list);
  state.disposeView = () => { prefs.author = author.value; };

  let loadedAuthor = author.value.trim();
  const who = (u) => (u.nickname ? `${u.nickname}（@${u.username}）` : u.username);

  function card(m) {
    const box = el("div", { class: "msg moment" });
    const comments = el("details", { class: "comments" }, el("summary", {}, `查看评论（${m.comments.length}）`));
    comments.addEventListener("toggle", () => {
      if (!comments.open) { while (comments.children.length > 1) comments.lastChild.remove(); return; }
      if (comments.children.length > 1) return;
      for (const c of m.comments) comments.append(el("div", { class: "comment" },
        el("span", { class: "a" }, who(c.author)),
        c.reply_to ? el("span", { class: "faint" }, ` 回复 ${who(c.reply_to)}`) : null,
        "：", el("span", { class: "b" }, c.body), " ",
        el("span", { class: "tm" }, fmtShort(c.created_at)),
        canDelete ? el("button", { class: "link danger", onclick: () => del("comments", c.id, `删除 ${c.author.username} 的评论？`, c.body) }, "删除") : null));
    });
    box.append(...[
      el("div", { class: "h" },
        el("span", { class: "a" }, who(m.author)),
        el("span", { class: "tm" }, fmtTime(m.created_at)),
        m.visibility === "private" ? el("span", { class: "tag" }, "仅自己可见") : el("span", { class: "tag on" }, "好友可见"),
        el("span", { class: "faint" }, `赞 ${m.likes.length}`),
        canDelete ? el("button", { class: "link danger", onclick: () => del("moments", m.id, `删除 ${m.author.username} 的动态？`, m.body) }, "删除动态") : null),
      el("div", { class: "b" }, m.body),
      m.comments.length ? comments : null].filter(Boolean));
    return box;
  }

  async function del(kind, id, title, body) {
    const ok = await modal(title, [el("p", { class: "b" }, body), el("p", { class: "muted" }, "删除后所有人都看不到，并记入审计日志。")],
      "删除", () => api("POST", `${kind}/${encodeURIComponent(id)}/delete`, {}), true);
    if (ok) {
      feedback.hidden = false;
      feedback.textContent = "已删除，正在更新列表…";
      pages.refresh();
    }
  }

  const pages = responsiveList({
    container: view, list, label: "动态分页", rowHeight: 105, max: 30,
    fetch: (limit, cursor, signal) => {
      const p = new URLSearchParams({ limit });
      if (loadedAuthor) p.set("author", loadedAuthor);
      if (cursor) { p.set("cursor_at", cursor.at); p.set("cursor_id", cursor.id); }
      return api("GET", "moments?" + p, undefined, signal);
    },
    draw: ({ moments }) => {
      if (!feedback.hidden) feedback.textContent = "已删除";
      list.replaceChildren(...(moments.length ? moments.map(card) : [el("p", { class: "empty" }, "没有动态")]));
    },
  });
  form.addEventListener("submit", (ev) => { ev.preventDefault(); loadedAuthor = author.value.trim(); pages.reset(); });
  await pages.reset();
}

// ---------- accounts ----------

// grantable mirrors the server's rules so the form disables what would be
// refused, and says why. The server enforces them regardless.
function grantable(perm, target) {
  if (!state.me.super && perm === "accounts.manage") return "只有超级管理员能授予或收回";
  if (target && target.perms.includes(perm)) return "";
  if (!can(perm)) return "你自己没有这项权限";
  return "";
}

function permChecks(target) {
  return el("div", { class: "checks" }, state.me.all_perms.map((p) => {
    const why = grantable(p, target);
    return el("label", {},
      el("input", { type: "checkbox", value: p, checked: !!(target && target.perms.includes(p)), disabled: !!why }),
      PERM_LABEL[p] || p, why ? el("span", { class: "why" }, `（${why}）`) : null);
  }));
}
const checkedPerms = (box) => [...box.querySelectorAll("input:checked")].map((i) => i.value);

async function renderAccounts(view, _parts, { api, prefs }) {
  view.append(el("div", { class: "page-heading" }, el("h2", {}, "账号与权限"),
    el("button", { onclick: create }, "新建账号")));
  const feedback = el("p", { class: "operation-status", role: "status", hidden: true });
  const filter = el("input", { type: "search", placeholder: "筛选用户名", "aria-label": "筛选账号用户名", value: prefs.filter || "" });
  const box = el("div");
  view.append(el("div", { class: "toolbar" }, filter), feedback, box);
  let filterTimer;
  state.disposeView = () => { clearTimeout(filterTimer); prefs.filter = filter.value; };
  const report = (text) => { feedback.hidden = false; feedback.textContent = text; };

  async function create() {
    const name = el("input", { autocomplete: "off", required: true, minlength: 3, maxlength: 32 });
    const pw1 = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8 });
    const checks = permChecks(null);
    const ok = await modal("新建账号", [
      el("label", {}, "用户名", name), el("label", {}, "初始密码（至少 8 个字符）", pw1),
      el("div", {}, el("div", { class: "muted", style: "margin-bottom:6px" }, "管理权限（不勾选即普通聊天账号）"), checks),
      el("p", { class: "muted" }, "新账号没有安全问题，忘记密码时只能由管理员重置。"),
    ], "创建", () => api("POST", "accounts", { username: name.value.trim(), password: pw1.value, perms: checkedPerms(checks) }));
    if (ok) { report("已创建 " + ok.username); directory.refresh(); }
  }

  async function edit(u) {
    const checks = permChecks(u);
    const ok = await modal(`${u.username} 的权限`, checks, "保存",
      () => api("POST", `users/${encodeURIComponent(u.id)}/perms`, { perms: checkedPerms(checks) }));
    if (ok) { report("已更新权限"); directory.refresh(); }
  }

  function draw({ users }) {
    const row = (u) => el("tr", {},
      el("td", {}, u.username, " ", u.super ? el("span", { class: "tag admin" }, "超级管理员") : null),
      el("td", {}, u.admin ? "管理员" : "普通账号"),
      el("td", {}, u.super ? "全部" : u.perms.map((p) => PERM_LABEL[p] || p).join("、") || el("span", { class: "faint" }, "无")),
      el("td", {}, u.super || u.id === state.me.id ? el("span", { class: "faint" }, u.id === state.me.id ? "不能改自己" : "")
        : el("button", { class: "link", onclick: () => edit(u) }, "修改权限")));
    box.replaceChildren(users.length ? el("table", {}, el("thead", {},
      el("tr", {}, el("th", {}, "用户名"), el("th", {}, "角色"), el("th", {}, "权限"), el("th", {}, "操作"))),
      el("tbody", {}, users.map(row))) : el("p", { class: "empty" }, "没有匹配的账号"));
  }
  const directory = responsiveList({
    container: view, list: box, label: "账号列表分页", rowHeight: 40, draw, indexed: true,
    fetch: (limit, page, signal) => api("GET", "accounts?" + new URLSearchParams({ limit, page, q: filter.value.trim() }), undefined, signal),
  });
  filter.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(directory.reset, 180);
  });
  await directory.reset();
}

// ---------- audit ----------

const ACTION_LABEL = {
  admin_login: "登录后台", admin_logout: "退出后台",
  view_conversation: "查看会话", search: "搜索消息",
  ban: "封禁", mute: "禁言", revoke: "解除处分",
  reset_password: "重置密码", kick: "强制下线",
  create_account: "新建账号", set_perms: "修改权限",
  create_admin: "命令行创建超级管理员", promote_admin: "命令行提升为超级管理员",
  delete_moment: "删除动态", delete_comment: "删除评论",
};

function auditDetail(e) {
  const d = e.detail || {};
  switch (e.action) {
    case "view_conversation": return (d.kind === "dm" ? "私聊 " : "") + (d.label || e.target_name || e.target) + (d.before ? `（更早于 #${d.before}）` : "");
    case "search": return Object.entries(d).filter(([k]) => k !== "continued").map(([k, v]) => {
      if (k === "from" || k === "to") v = fmtTime(Number(v));
      return `${{ q: "关键词", keywords: "关键词", author: "作者", conversation: "会话", from: "从", to: "到" }[k] || k}: ${v}`;
    }).join("，") + (d.continued ? "（继续）" : "");
    case "ban": case "mute": return `${d.username}，原因：${d.reason}，至 ${d.until === "permanent" ? "永久" : fmtTime(Date.parse(d.until))}`;
    case "revoke": return `${d.username} 的${d.kind === "ban" ? "封禁" : "禁言"}`;
    case "set_perms": return `${d.username}：${d.before || "无"} → ${d.after || "无"}`;
    case "create_account": return `${d.username}${d.perms ? "，权限 " + d.perms : ""}${d.super === "true" ? "，超级管理员" : ""}`;
    case "admin_login": return d.addr || "";
    case "delete_moment": case "delete_comment": return `${d.username}：${d.body}`;
    default: return d.username || e.target_name || "";
  }
}

async function renderAudit(view, _parts, { api, prefs }) {
  view.append(el("h2", {}, "审计日志"));
  const actor = el("input", { placeholder: "操作人用户名", value: prefs.actor || "" });
  const action = el("select", {}, el("option", { value: "" }, "全部操作"),
    Object.entries(ACTION_LABEL).map(([k, v]) => el("option", { value: k }, v)));
  action.value = prefs.action || "";
  const from = el("input", { type: "date", value: prefs.from || "" }), to = el("input", { type: "date", value: prefs.to || "" });
  const filter = el("button", { type: "submit" }, "筛选");
  const form = el("form", { class: "toolbar" },
    el("label", {}, "操作人", actor), el("label", {}, "操作", action), el("label", {}, "从", from), el("label", {}, "到", to),
    filter);
  const tbody = el("tbody");
  const list = el("div", {}, el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "时间"), el("th", {}, "操作人"), el("th", {}, "操作"), el("th", {}, "对象"), el("th", {}, "详情"))), tbody));
  view.append(form, list);
  state.disposeView = () => Object.assign(prefs, { actor: actor.value, action: action.value, from: from.value, to: to.value });

  function filters() {
    const q = new URLSearchParams();
    if (actor.value.trim()) q.set("actor_name", actor.value.trim());
    if (action.value) q.set("action", action.value);
    if (from.value) q.set("from", dateMs(from.value, false));
    if (to.value) q.set("to", dateMs(to.value, true));
    return q;
  }
  let query = filters();
  const pages = responsiveList({
    container: view, list, label: "审计日志分页", rowHeight: 39,
    fetch: async (limit, cursor, signal) => {
      const p = new URLSearchParams(query);
      p.set("limit", limit + 1);
      if (cursor) { p.set("before", cursor.at); p.set("before_id", cursor.id); }
      const { entries } = await api("GET", "audit?" + p, undefined, signal);
      const edge = entries[limit - 1];
      return { entries: entries.slice(0, limit), next: entries.length > limit ? { at: edge.at, id: edge.id } : null };
    },
    draw: ({ entries }) => tbody.replaceChildren(...(entries.length ? entries.map((e) => el("tr", {},
      el("td", { class: "faint" }, fmtTime(e.at)), el("td", {}, e.actor_name),
      el("td", {}, ACTION_LABEL[e.action] || e.action), el("td", {}, e.target_name || "—"),
      el("td", {}, auditDetail(e)))) : [el("tr", {}, el("td", { colspan: 5, class: "empty" }, "没有记录"))])),
  });
  form.addEventListener("submit", (ev) => { ev.preventDefault(); query = filters(); pages.reset(); });
  await pages.reset();
}

// ---------- start ----------

(async function start() {
  try {
    state.me = await api("GET", "me");
    enterShell();
  } catch (e) {
    if (!state.me && $("#login").hidden) showLogin(errText(e));
  }
})();
