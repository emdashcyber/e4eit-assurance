import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as model from "../src/lib/model.js";
import { STORAGE_KEY, emptyState, normaliseState } from "../src/lib/model.js";
import { createAssessmentPersistence } from "../src/lib/persistence.js";

const data = JSON.parse(readFileSync(new URL("../src/data/e4eit.json", import.meta.url), "utf8"));
const savedAt = "2026-11-01T00:00:00Z";
const nextSave = "2026-11-08T00:00:00Z";

function fixture() {
  const saved = emptyState(data);
  saved.details.organisation = "Saved organisation";
  saved.updatedAt = savedAt;
  const values = new Map([[STORAGE_KEY, JSON.stringify(saved)]]);
  const failures = { access: false, read: false, write: false, remove: false };
  const calls = { reads: 0, writes: 0, removes: 0 };
  const storage = {
    getItem(key) {
      calls.reads += 1;
      if (failures.read) throw new Error("SecurityError");
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.writes += 1;
      if (failures.write) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem(key) {
      calls.removes += 1;
      if (failures.remove) throw new Error("SecurityError");
      values.delete(key);
    },
  };
  let state;
  let nextTimer = 0;
  const timers = new Map();
  const changes = [];
  const persistence = createAssessmentPersistence({
    data,
    getState: () => state,
    getStorage: () => {
      if (failures.access) throw new Error("SecurityError");
      return storage;
    },
    now: () => nextSave,
    setTimer(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimer(id) { timers.delete(id); },
    onChange() { changes.push(persistence.status); },
  });
  return {
    persistence, values, failures, calls, changes, timers, storage,
    get state() { return state; },
    set state(value) { state = value; },
    load() { state = persistence.load(); },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("full storage still loads the saved assessment without a write probe", () => {
  const f = fixture();
  f.failures.write = true;
  f.load();
  assert.equal(f.state.details.organisation, "Saved organisation");
  assert.deepEqual(f.persistence.status, { savedAt, dirty: false, error: null });
  assert.deepEqual(f.calls, { reads: 1, writes: 0, removes: 0 });
  assert.equal(f.values.size, 1);
});

test("pending and failed saves retain the last successful save time; recovery clears the warning", () => {
  const f = fixture();
  f.load();
  f.failures.write = true;
  f.state.details.organisation = "Latest edits";
  f.persistence.queueSave();
  assert.deepEqual(f.changes.at(-1), { savedAt, dirty: true, error: null });
  f.runTimers();
  assert.deepEqual(f.changes.at(-1), { savedAt, dirty: true, error: "save" });
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Saved organisation");
  f.failures.write = false;
  f.persistence.queueSave();
  f.runTimers();
  assert.deepEqual(f.changes.at(-1), { savedAt: nextSave, dirty: false, error: null });
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Latest edits");
});

test("clearing cancels queued saves and pagehide cannot recreate the assessment", () => {
  const f = fixture();
  f.load();
  f.state.details.assessor = "Pending edit";
  f.persistence.queueSave();
  assert.equal(f.persistence.clear(), true);
  f.state = emptyState(data);
  f.runTimers();
  f.persistence.flush();
  assert.equal(f.values.has(STORAGE_KEY), false);
  assert.equal(f.calls.writes, 0);
  assert.deepEqual(f.persistence.status, { savedAt: null, dirty: false, error: null });
  f.state.details.assessor = "New assessment";
  f.persistence.queueSave();
  f.runTimers();
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.assessor, "New assessment");
});

test("failed removal is reported, cancels pending writes, and can be retried", () => {
  const f = fixture();
  f.load();
  f.persistence.queueSave();
  f.failures.remove = true;
  assert.equal(f.persistence.clear(), false);
  f.state = emptyState(data);
  f.runTimers();
  f.persistence.flush();
  assert.deepEqual(f.persistence.status, { savedAt, dirty: true, error: "clear" });
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Saved organisation");
  assert.equal(f.calls.writes, 0);
  f.failures.remove = false;
  assert.equal(f.persistence.clear(), true);
  assert.equal(f.values.has(STORAGE_KEY), false);
  assert.deepEqual(f.persistence.status, { savedAt: null, dirty: false, error: null });
});

test("JSON export preserves current edits and the assessment format when saving fails", () => {
  const f = fixture();
  f.load();
  f.failures.write = true;
  f.state.details.organisation = "Unsaved organisation";
  f.state.scope[data.domains[0].id] = { inScope: false, justification: "New scope" };
  f.persistence.queueSave();
  const exported = JSON.parse(f.persistence.exportJSON());
  assert.equal(exported.details.organisation, "Unsaved organisation");
  assert.equal(exported.updatedAt, nextSave);
  const imported = normaliseState(exported, data);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.state, f.state);
  assert.deepEqual(f.persistence.status, { savedAt, dirty: true, error: "save" });
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Saved organisation");
  assert.equal(f.timers.size, 0);
});

test("storage access errors keep the app usable and allow export", () => {
  const f = fixture();
  f.failures.access = true;
  f.load();
  assert.deepEqual(f.state, emptyState(data));
  assert.equal(f.persistence.status.error, "read");
  f.state.details.assessor = "Available in memory";
  assert.equal(JSON.parse(f.persistence.exportJSON()).details.assessor, "Available in memory");
  assert.deepEqual(f.persistence.status, { savedAt: null, dirty: true, error: "save" });
  f.failures.access = false;
  assert.equal(f.persistence.saveNow(), true);
  assert.equal(f.persistence.status.error, null);
});

test("debouncing and pagehide persist the latest state exactly once", () => {
  const f = fixture();
  f.load();
  f.persistence.queueSave();
  f.state.details.organisation = "Latest edit";
  f.persistence.queueSave();
  assert.equal(f.timers.size, 1);
  f.persistence.flush();
  f.runTimers();
  f.persistence.flush();
  assert.equal(f.calls.writes, 1);
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Latest edit");
});

test("replacing the assessment before an immediate save cancels older pending work", () => {
  const f = fixture();
  f.load();
  f.persistence.queueSave();
  f.state = emptyState(data);
  f.state.details.organisation = "Imported organisation";
  f.persistence.saveNow();
  f.runTimers();
  assert.equal(f.calls.writes, 1);
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Imported organisation");
});

function startApp(f) {
  const nodes = new Map();
  const events = new Map();
  const downloads = [];
  function node() {
    return {
      value: "", textContent: "", hidden: false, style: {}, children: [], listeners: {},
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      click() { return this.listeners.click?.(); },
      remove() {},
    };
  }
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    createElement: node,
    createTextNode: (text) => text,
    body: node(),
  };
  const window = {
    addEventListener(type, callback) { events.set(type, callback); },
    confirm: () => true,
    setTimeout(callback) { const id = Symbol(); f.timers.set(id, callback); return id; },
  };
  const source = readFileSync(new URL("../src/scripts/app.js", import.meta.url), "utf8");
  // Supply module dependencies to the DOM harness, executing the whole application unchanged.
  vm.runInNewContext(source.replace(/^import[\s\S]*?;\n/gm, ""), {
    ...model, data, document, window, Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    createAssessmentPersistence(options) {
      return createAssessmentPersistence({
        ...options, getStorage: () => f.storage, now: () => nextSave,
        setTimer: window.setTimeout, clearTimer: (id) => f.timers.delete(id),
      });
    },
  });
  return {
    nodes, downloads,
    input(value) { nodes.get("#assessment").listeners.input({ target: { dataset: { detail: "organisation" }, value } }); },
    pagehide() { events.get("pagehide")(); },
  };
}

test("the page labels failed writes as unsaved, exports edits, and recovers its saved status", async () => {
  const f = fixture();
  f.failures.write = true;
  const app = startApp(f);
  const label = app.nodes.get("#updated-at");
  const originalTime = label.textContent.replace(/^Saved /, "");
  assert.match(label.textContent, /^Saved /);
  app.input("Unsaved browser edit");
  assert.equal(label.textContent, `Unsaved changes · Last saved ${originalTime}`);
  f.runTimers();
  assert.equal(label.textContent, `Unsaved changes · Last saved ${originalTime}`);
  assert.equal(app.nodes.get("#storage-warning").hidden, false);
  app.nodes.get("#export-json").click();
  assert.equal(JSON.parse(await app.downloads.at(-1).text()).details.organisation, "Unsaved browser edit");
  assert.match(label.textContent, /^Unsaved changes/);
  f.failures.write = false;
  app.input("Recovered browser edit");
  f.runTimers();
  assert.match(label.textContent, /^Saved /);
  assert.notEqual(label.textContent, `Saved ${originalTime}`);
  assert.equal(app.nodes.get("#storage-warning").hidden, true);
});

test("the page cancels a pending save on clear and reports failed deletion accurately", () => {
  const f = fixture();
  const app = startApp(f);
  app.input("Pending edit");
  f.failures.remove = true;
  app.nodes.get("#clear-all").click();
  f.runTimers();
  app.pagehide();
  assert.match(app.nodes.get("#data-status").textContent, /saved copy could not be removed/);
  assert.match(app.nodes.get("#storage-warning").textContent, /may reappear/);
  assert.equal(f.calls.writes, 0);
  assert.equal(JSON.parse(f.values.get(STORAGE_KEY)).details.organisation, "Saved organisation");
  f.failures.remove = false;
  app.nodes.get("#clear-all").click();
  app.pagehide();
  assert.equal(f.values.has(STORAGE_KEY), false);
  assert.equal(app.nodes.get("#data-status").textContent, "Assessment cleared.");
  assert.equal(app.nodes.get("#updated-at").textContent, "Nothing saved yet");
  assert.equal(app.nodes.get("#storage-warning").hidden, true);
});
