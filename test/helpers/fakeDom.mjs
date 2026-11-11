// test/helpers/fakeDom.mjs
// A deliberately STRICT fake popup environment for view tests: a fake DOM, a
// fake `chrome` (storage + runtime messaging) and a fake `window`.
//
// Strictness is the point:
//   - getElementById THROWS on an id that isn't in popup.html. The id list is
//     parsed from the real popup.html, so a view that asks for an id the HTML
//     doesn't have fails here, and there is no hand-kept id list to drift.
//   - chrome.storage hands back/keeps COPIES and returns only the requested
//     keys, like the real thing. A shared-reference mock hides lost-update and
//     stale-read bugs.
//
// Each setup() call returns a brand-new world (new window, storage, IndexedDB
// and elements) so tests can't leak state into each other.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeIndexedDB } from "./fakeIndexedDB.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POPUP_HTML = readFileSync(path.join(root, "popup.html"), "utf8");
export const HTML_IDS = [...POPUP_HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
// Elements that carry the `hidden` attribute in the real markup start hidden
// here too — otherwise "has the view rendered yet?" checks pass before it has.
// Same for `checked`: a checkbox ticked in the HTML starts ticked.
export const CHECKED_IDS = new Set(
  [...POPUP_HTML.matchAll(/<input[^>]*?\sid="([^"]+)"[^>]*>/g)]
    .filter((m) => /\schecked(?=[\s>=\/])/.test(m[0].replace(/"[^"]*"/g, '""')))
    .map((m) => m[1])
);
export const HIDDEN_IDS = new Set(
  [...POPUP_HTML.matchAll(/<[^>]*?\sid="([^"]+)"[^>]*>/g)]
    .filter((m) => /\shidden(?=[\s>=\/])/.test(m[0].replace(/"[^"]*"/g, '""')))
    .map((m) => m[1])
);

export function makeElement(id) {
  const listeners = {};
  const stubs = {};
  let text = "";
  let html = "";
  const classes = new Set();
  const el = {
    id,
    hidden: false,
    disabled: false,
    value: "",
    checked: false,
    open: false,
    href: "",
    scrollLeft: 0,
    scrollWidth: 0,
    style: {},
    _children: [],
    focused: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    async dispatch(type, evt = {}) {
      for (const fn of listeners[type] || []) await fn({ stopPropagation() {}, preventDefault() {}, target: { closest: () => null }, ...evt });
    },
    appendChild(child) {
      el._children.push(child);
    },
    // Stable stub per selector, so code that caches `el.querySelector(...)`
    // and a test that inspects it see the same object.
    querySelector(sel) {
      return (stubs[sel] = stubs[sel] || makeElement(`${id}>${sel}`));
    },
    querySelectorAll: () => [],
    setAttribute() {},
    closest: () => null,
    focus() {
      el.focused = true;
    },
  };
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set(v) {
      text = String(v);
      html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set(v) {
      html = String(v);
      el._children = [];
    },
  });
  Object.defineProperty(el, "className", {
    get: () => [...classes].join(" "),
    set(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  return el;
}

/** chrome.storage.local + chrome.runtime, backed by plain objects. */
export function makeChrome() {
  const store = {};
  const sent = [];
  const runtimeListeners = [];
  let responder = () => undefined;
  const pick = (keys) => {
    const names = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
    const out = {};
    for (const k of names) if (k in store) out[k] = structuredClone(store[k]);
    return out;
  };
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          cb(pick(keys));
        },
        set(obj, cb) {
          for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
          cb();
        },
      },
    },
    runtime: {
      lastError: null,
      id: "test-extension-id",
      sendMessage(message, cb) {
        sent.push(message);
        const res = responder(message);
        if (typeof cb === "function") {
          cb(res);
          return undefined;
        }
        return Promise.resolve(res);
      },
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
  };
  return {
    chrome,
    store,
    sent,
    sentOfType: (type) => sent.filter((m) => m?.type === type),
    setResponder: (fn) => {
      responder = fn;
    },
    /** Simulate the worker broadcasting a message to this popup. */
    broadcast(message) {
      for (const fn of runtimeListeners) fn(message);
    },
  };
}

/**
 * Installs a fresh world on globalThis and returns handles to it. Call once
 * per test, BEFORE the view's init function.
 */
export function setup({ ids = HTML_IDS } = {}) {
  const fakeDb = createFakeIndexedDB();
  const world = makeChrome();
  const elements = {};
  for (const id of ids) {
    elements[id] = makeElement(id);
    elements[id].hidden = HIDDEN_IDS.has(id);
    elements[id].checked = CHECKED_IDS.has(id);
  }
  const created = [];

  const win = new EventTarget();
  const dialogs = { alerts: [], confirmAnswer: true, confirms: [] };

  globalThis.indexedDB = fakeDb.indexedDB;
  globalThis.chrome = world.chrome;
  globalThis.window = win;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
  globalThis.alert = (msg) => dialogs.alerts.push(String(msg));
  globalThis.confirm = (msg) => {
    dialogs.confirms.push(String(msg));
    return dialogs.confirmAnswer;
  };
  globalThis.document = {
    getElementById(id) {
      if (!elements[id]) {
        throw new Error(`Test harness: a view requested element id "${id}" which is not in popup.html`);
      }
      return elements[id];
    },
    createElement(tag) {
      const el = makeElement(`created-${tag}`);
      created.push(el);
      return el;
    },
  };

  const events = [];
  const watch = (name) => win.addEventListener(name, () => events.push(name));
  return {
    ...world,
    el: (id) => elements[id],
    elements,
    created,
    win,
    fakeDb,
    dialogs,
    events,
    watch,
    emit: (name) => win.dispatchEvent(new CustomEvent(name)),
  };
}

/** Polls until `predicate()` is truthy. Real crypto + the fake IndexedDB resolve across macrotasks, so a fixed number of ticks is not reliable. */
export async function waitFor(predicate, what = "condition", timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = !!predicate();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Lets already-queued async work settle (use when asserting that something did NOT happen). */
export const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

export function jsonResponse(body, { status = 200, headers = {}, statusText = "OK" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}
