import { STORAGE_KEY, emptyState, normaliseState } from "./model.js";

export function createAssessmentPersistence({
  data,
  getState,
  getStorage = () => globalThis.localStorage,
  now = () => new Date().toISOString(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
}) {
  let savedAt = null;
  let dirty = false;
  let error = null;
  let timer = null;

  function cancelPending() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function load() {
    // Reading an existing assessment must not depend on storage accepting writes.
    try {
      const raw = getStorage().getItem(STORAGE_KEY);
      if (raw) {
        const result = normaliseState(JSON.parse(raw), data);
        if (!result.ok) throw new Error("Invalid saved assessment");
        savedAt = result.state.updatedAt;
        return result.state;
      }
    } catch {
      error = "read";
    }
    return emptyState(data);
  }

  function saveNow() {
    cancelPending();
    const state = getState();
    // Exports include the latest edit time; savedAt only advances after a successful write.
    state.updatedAt = now();
    try {
      getStorage().setItem(STORAGE_KEY, JSON.stringify(state));
      savedAt = state.updatedAt;
      dirty = false;
      error = null;
    } catch {
      dirty = true;
      error = "save";
    }
    onChange();
    return error === null;
  }

  function queueSave() {
    cancelPending();
    dirty = true;
    timer = setTimer(saveNow, 250);
    onChange();
  }

  function clear() {
    cancelPending();
    try {
      getStorage().removeItem(STORAGE_KEY);
      savedAt = null;
      dirty = false;
      error = null;
    } catch {
      dirty = true;
      error = "clear";
    }
    onChange();
    return error === null;
  }

  return {
    load,
    saveNow,
    queueSave,
    clear,
    flush() { if (timer !== null) saveNow(); },
    exportJSON() {
      saveNow();
      return `${JSON.stringify(getState(), null, 2)}\n`;
    },
    get status() { return { savedAt, dirty, error }; },
  };
}
