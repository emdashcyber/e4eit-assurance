import data from "../data/e4eit.json";
import {
  STORAGE_KEY, RATING_LABELS, actionEntry, appliesInScope, effectiveRating, emptyAction, emptyState,
  gaps, inScope, normaliseState, percent, phaseOf, summarise, suggestRating, toCsv,
} from "../lib/model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const MAX_IMPORT_BYTES = 2_000_000;
const PILL = { fully: "good", partial: "warn", not: "bad", unassessed: "dim" };
const controlById = new Map(data.controls.map((c) => [c.id, c]));

let storageOk = true;
let state = load();
let saveTimer = 0;

function load() {
  try {
    window.localStorage.setItem(`${STORAGE_KEY}:probe`, "1");
    window.localStorage.removeItem(`${STORAGE_KEY}:probe`);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const result = normaliseState(JSON.parse(raw), data);
      if (result.ok) return result.state;
    }
  } catch {
    storageOk = false;
  }
  return emptyState(data);
}

function saveNow() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  state.updatedAt = new Date().toISOString();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageOk = false;
  }
  $("#storage-warning").hidden = storageOk;
  renderUpdated();
}

function queueSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 250);
}

function el(tag, { text, cls, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function status(message) {
  $("#data-status").textContent = message;
}

function renderUpdated() {
  const t = state.updatedAt ? new Date(state.updatedAt) : null;
  $("#updated-at").textContent = t && !Number.isNaN(t.getTime()) ? `Saved ${t.toLocaleString("en-AU")}` : "Nothing saved yet";
}

/* DOM from state */
function hydrate() {
  for (const input of $$("[data-detail]")) input.value = state.details[input.dataset.detail] ?? "";
  for (const card of $$(".domain-card")) {
    const scope = state.scope[card.dataset.domain];
    $("[data-scope-toggle]", card).checked = scope.inScope;
    $(".justification", card).hidden = scope.inScope;
    $("[data-scope-justification]", card).value = scope.justification;
  }
  for (const node of $$(".action")) {
    const entry = actionEntry(state, node.dataset.id);
    const ticked = new Set(entry.indicators);
    for (const box of $$("[data-indicator]", node)) box.checked = ticked.has(box.dataset.indicator);
    for (const field of $$("[data-field]", node)) field.value = entry[field.dataset.field] ?? "";
  }
}

/* Derived views */
function refresh() {
  for (const node of $$(".action")) {
    const control = controlById.get(node.dataset.id);
    const entry = actionEntry(state, control.id);
    const live = appliesInScope(control, state);
    const rating = effectiveRating(control, entry);
    const pill = $("[data-pill]", node);
    pill.textContent = live ? RATING_LABELS[rating] : "Out of scope";
    pill.className = `status-pill ${live ? PILL[rating] : "dim"}`;
    node.classList.toggle("out-of-scope", !live);

    const suggested = suggestRating(control, new Set(entry.indicators));
    const total = Object.values(control.indicators).flat().length;
    const ticked = entry.indicators.length;
    let note = "Tick indicators you have seen evidence for to get a suggested rating.";
    if (suggested) {
      note = `Suggested rating: ${RATING_LABELS[suggested]} (${ticked} of ${total} indicators ticked).`;
      if (entry.rating && entry.rating !== suggested) note += ` Your rating, ${RATING_LABELS[entry.rating]}, overrides it.`;
    }
    $("[data-suggestion]", node).textContent = note;
  }

  const summary = summarise(data, state);
  const t = summary.overall;
  const assessed = t.total - t.unassessed;
  const values = { total: t.total, assessed, fully: t.fully, partial: t.partial, not: t.not, unassessed: t.unassessed };
  for (const [id, value] of Object.entries(values)) $(`[data-metric="${id}"]`).textContent = String(value);
  $('[data-metric-foot="assessed"]').textContent = `${percent(assessed, t.total)}% of in-scope actions`;
  for (const id of ["fully", "partial", "not", "unassessed"]) {
    $(`[data-metric-foot="${id}"]`).textContent = `${percent(t[id], t.total)}% of in-scope actions`;
  }
  renderRows($("#rows-phase"), summary.phaseRows);
  renderRows($("#rows-domain"), summary.domainRows);
  renderRows($("#rows-principle"), summary.principleRows);
  renderGaps();

  const on = data.domains.filter((d) => inScope(state, d.id)).length;
  $("#scope-count").textContent = `${on} of ${data.domains.length} domains in scope`;
  $("#print-meta").textContent = printMeta();
}

function renderRows(tbody, rows) {
  tbody.replaceChildren(...rows.map((row) => {
    const tr = el("tr", {}, [el("th", { text: row.title, attrs: { scope: "row" } })]);
    if (!row.tally) {
      tr.append(el("td", { text: "Out of scope", cls: "out-cell", attrs: { colspan: "6" } }));
      return tr;
    }
    const t = row.tally;
    const bar = el("div", { cls: "bar", attrs: { "aria-hidden": "true" } });
    for (const key of ["fully", "partial", "not", "unassessed"]) {
      const seg = el("span", { cls: `seg seg-${key}` });
      seg.style.width = `${t.total ? (t[key] / t.total) * 100 : 0}%`;
      bar.append(seg);
    }
    const labels = ["Actions", "Fully", "Partially", "Not", "Not assessed", "Progress"];
    const cells = [t.total, t.fully, t.partial, t.not, t.unassessed].map((n, i) => el("td", { text: String(n), cls: "num", attrs: { "data-label": labels[i] } }));
    tr.append(...cells, el("td", { attrs: { "data-label": labels[5] } }, [bar]));
    return tr;
  }));
}

function renderGaps() {
  const list = gaps(data, state);
  $("#gap-count").textContent = `${list.length} gap${list.length === 1 ? "" : "s"}`;
  $("#gap-empty").hidden = list.length > 0;
  $("#gap-list").replaceChildren(...list.map(({ control, rating, phase }) => {
    const link = el("a", { text: control.id, cls: "gap-link", attrs: { href: `#action-${control.id}`, "data-reveal": control.id } });
    const where = phase ? `Phase ${phase}` : "Capability";
    return el("li", { cls: "gap-item" }, [
      el("span", { text: RATING_LABELS[rating], cls: `status-pill ${PILL[rating]}` }),
      el("span", { cls: "gap-body" }, [link, document.createTextNode(` ${control.action}`)]),
      el("span", { text: where, cls: "chip" }),
    ]);
  }));
}

function printMeta() {
  const d = state.details;
  const parts = [
    d.organisation && `Organisation: ${d.organisation}`,
    d.assessor && `Assessor: ${d.assessor}`,
    d.date && `Assessment date: ${d.date}`,
    `Catalog ${data.catalog.version}`,
    `Printed ${new Date().toLocaleDateString("en-AU")}`,
  ];
  return parts.filter(Boolean).join(" | ");
}

/* Filters */
const filterIds = ["text", "domain", "phase", "family", "rating", "technique"];
const filterValue = (name) => $(`#filter-${name}`).value;

function applyFilters() {
  const q = filterValue("text").trim().toLowerCase();
  const f = Object.fromEntries(filterIds.map((n) => [n, filterValue(n)]));
  let shown = 0;
  for (const node of $$(".action")) {
    const control = controlById.get(node.dataset.id);
    const ok =
      (!q || node.dataset.search.includes(q)) &&
      (!f.domain || node.dataset.domains.split(" ").includes(f.domain)) &&
      (!f.phase || node.dataset.phases.split(" ").includes(f.phase)) &&
      (!f.family || node.dataset.family === f.family) &&
      (!f.technique || node.dataset.techniques.split("|").includes(f.technique)) &&
      (!f.rating || effectiveRating(control, actionEntry(state, control.id)) === f.rating);
    node.hidden = !ok;
    if (ok) shown += 1;
  }
  for (const block of $$("[data-principle-block]")) block.hidden = !$(".action:not([hidden])", block);
  for (const block of $$("[data-family-block]")) block.hidden = !$("[data-principle-block]:not([hidden])", block);
  $("#action-count").textContent = `Showing ${shown} of ${data.controls.length} actions`;
  $("#actions-empty").hidden = shown > 0;
}

function resetFilters() {
  for (const n of filterIds) $(`#filter-${n}`).value = "";
  applyFilters();
}

function reveal(id) {
  let node = $(`.action[data-id="${id}"]`);
  if (node?.hidden) {
    resetFilters();
    node = $(`.action[data-id="${id}"]`);
  }
  if (!node) return;
  node.open = true;
  node.scrollIntoView({ block: "start" });
  $("summary", node).focus({ preventScroll: true });
}

/* State edits */
function entryFor(id) {
  if (!Object.hasOwn(state.actions, id)) state.actions[id] = emptyAction();
  return state.actions[id];
}

function tidy(id) {
  const e = state.actions[id];
  if (e && !e.indicators.length && !e.rating && !e.evidence && !e.owner && !e.date && !e.ref) delete state.actions[id];
}

function onActionInput(event) {
  const target = event.target;
  const node = target.closest(".action");
  if (!node) return;
  const id = node.dataset.id;
  const entry = entryFor(id);
  if (target.matches("[data-indicator]")) {
    const set = new Set(entry.indicators);
    if (target.checked) set.add(target.dataset.indicator);
    else set.delete(target.dataset.indicator);
    entry.indicators = [...set];
  } else if (target.matches("[data-field]")) {
    const field = target.dataset.field;
    entry[field] = field === "rating" ? (["fully", "partial", "not"].includes(target.value) ? target.value : null) : target.value;
  } else {
    return;
  }
  tidy(id);
  queueSave();
  refresh();
}

function onScopeInput(event) {
  const card = event.target.closest(".domain-card");
  if (!card) return;
  const scope = state.scope[card.dataset.domain];
  if (event.target.matches("[data-scope-toggle]")) {
    scope.inScope = event.target.checked;
    $(".justification", card).hidden = scope.inScope;
  } else if (event.target.matches("[data-scope-justification]")) {
    scope.justification = event.target.value;
  } else {
    return;
  }
  queueSave();
  refresh();
}

/* Import, export, clear, print */
function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = el("a", { attrs: { href: url, download: name } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

function hasData() {
  return Object.keys(state.actions).length > 0 || Object.values(state.scope).some((s) => !s.inScope) || Object.values(state.details).some(Boolean);
}

async function importFile(file) {
  if (file.size > MAX_IMPORT_BYTES) return status("That file is too large to be an assessment.");
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return status("That file is not valid JSON.");
  }
  const result = normaliseState(parsed, data);
  if (!result.ok) return status(result.warnings[0]);
  if (hasData() && !window.confirm("Replace the current assessment in this browser with the imported file?")) return status("Import cancelled.");
  state = result.state;
  saveNow();
  hydrate();
  refresh();
  applyFilters();
  status(`Imported ${Object.keys(state.actions).length} assessed actions.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`);
}

function clearAll() {
  if (!window.confirm("Delete the assessment stored in this browser? Export it first if you want to keep it.")) return;
  state = emptyState(data);
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    storageOk = false;
  }
  $("#storage-warning").hidden = storageOk;
  hydrate();
  refresh();
  applyFilters();
  renderUpdated();
  status("Assessment cleared.");
}

let reopened = [];
window.addEventListener("beforeprint", () => {
  reopened = $$(".action:not([open])").filter((n) => Object.hasOwn(state.actions, n.dataset.id));
  for (const n of reopened) n.open = true;
});
window.addEventListener("afterprint", () => {
  for (const n of reopened) n.open = false;
  reopened = [];
});
window.addEventListener("pagehide", () => {
  if (saveTimer) saveNow();
});

/* Wiring */
hydrate();
$("#storage-warning").hidden = storageOk;
renderUpdated();
refresh();
applyFilters();

$("#actions").addEventListener("input", onActionInput);
$("#actions").addEventListener("change", onActionInput);
$("#scope").addEventListener("input", onScopeInput);
$("#assessment").addEventListener("input", (event) => {
  const key = event.target.dataset?.detail;
  if (!key) return;
  state.details[key] = event.target.value;
  queueSave();
  $("#print-meta").textContent = printMeta();
});
for (const n of filterIds) $(`#filter-${n}`).addEventListener(n === "text" ? "input" : "change", applyFilters);
$("#filter-reset").addEventListener("click", resetFilters);
$("#gap-list").addEventListener("click", (event) => {
  const link = event.target.closest("[data-reveal]");
  if (!link) return;
  event.preventDefault();
  reveal(link.dataset.reveal);
});
$("#export-json").addEventListener("click", () => {
  saveNow();
  download(`e4eit-assessment-${stamp()}.json`, "application/json", `${JSON.stringify(state, null, 2)}\n`);
  status("Exported assessment as JSON.");
});
$("#export-csv").addEventListener("click", () => {
  download(`e4eit-assessment-${stamp()}.csv`, "text/csv;charset=utf-8", `\uFEFF${toCsv(data, state)}`);
  status("Exported assessment as CSV.");
});
$("#import-json").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) await importFile(file);
});
$("#print-report").addEventListener("click", () => window.print());
$("#clear-all").addEventListener("click", clearAll);
