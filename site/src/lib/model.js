// Pure assessment logic shared by the page script and the tests; nothing here touches the DOM.

export const STORAGE_KEY = "e4eit-assurance:v1";
export const SCHEMA = 1;
export const RATINGS = ["fully", "partial", "not"];
export const RATING_LABELS = {
  fully: "Fully effective",
  partial: "Partially effective",
  not: "Not effective",
  unassessed: "Not assessed",
};
export const LIMITS = { short: 200, long: 5000, justification: 1000 };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const own = (obj, key) => obj != null && typeof obj === "object" && Object.hasOwn(obj, key);
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const validDate = (value) => {
  if (typeof value !== "string" || !DATE.test(value)) return "";
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value ? "" : value;
};

export function emptyAction() {
  return { indicators: [], rating: null, evidence: "", owner: "", date: "", ref: "" };
}

export function emptyState(data) {
  return {
    schema: SCHEMA,
    catalogVersion: data.catalog.version,
    updatedAt: null,
    details: { organisation: "", assessor: "", date: "" },
    scope: Object.fromEntries(data.domains.map((d) => [d.id, { inScope: true, justification: "" }])),
    actions: {},
  };
}

export function actionEntry(state, id) {
  return own(state.actions, id) ? state.actions[id] : emptyAction();
}

// A suggestion only: the assessor's judgement (the rating override) always wins.
export function suggestRating(control, observed) {
  const seen = (level) => control.indicators[level].filter((i) => observed.has(i.id)).length;
  if (seen("not") > 0) return "not";
  if (seen("partial") > 0) return "partial";
  const fully = seen("fully");
  if (fully === control.indicators.fully.length) return "fully";
  return fully > 0 ? "partial" : null;
}

export function effectiveRating(control, entry) {
  if (entry.rating && RATINGS.includes(entry.rating)) return entry.rating;
  return suggestRating(control, new Set(entry.indicators)) ?? "unassessed";
}

export function inScope(state, domainId) {
  return !own(state.scope, domainId) || state.scope[domainId].inScope !== false;
}

export const appliesInScope = (control, state) => control.domains.some((d) => inScope(state, d));

export function tally(controls, state) {
  const t = { total: 0, fully: 0, partial: 0, not: 0, unassessed: 0 };
  for (const control of controls) {
    t.total += 1;
    t[effectiveRating(control, actionEntry(state, control.id))] += 1;
  }
  return t;
}

export function summarise(data, state) {
  const live = data.controls.filter((c) => appliesInScope(c, state));
  const domainRows = data.domains.map((domain) => {
    const on = inScope(state, domain.id);
    return {
      id: domain.id,
      title: domain.title,
      phase: domain.phase,
      inScope: on,
      tally: on ? tally(data.controls.filter((c) => c.domains.includes(domain.id)), state) : null,
    };
  });
  const phaseRows = data.phases.map((phase) => {
    const ids = phase.domains.filter((d) => inScope(state, d));
    return {
      id: String(phase.id),
      title: `${phase.title}: ${phase.domains.map((d) => data.domains.find((x) => x.id === d).title).join(" and ")}`,
      inScope: ids.length > 0,
      tally: ids.length ? tally(data.controls.filter((c) => c.domains.some((d) => ids.includes(d))), state) : null,
    };
  });
  const principleRows = data.principles.map((principle) => {
    const controls = principle.controlIds.map((id) => data.controls.find((c) => c.id === id)).filter((c) => appliesInScope(c, state));
    return { id: principle.id, title: `${principle.id} ${principle.title}`, inScope: controls.length > 0, tally: controls.length ? tally(controls, state) : null };
  });
  return { overall: tally(live, state), phaseRows, domainRows, principleRows };
}

export function phaseOf(control, data, state) {
  const phases = data.phases.filter((p) => p.domains.some((d) => control.domains.includes(d) && inScope(state, d))).map((p) => p.id);
  return phases.length ? Math.min(...phases) : 0;
}

export function gaps(data, state) {
  const weight = { not: 0, partial: 1 };
  return data.controls
    .filter((c) => appliesInScope(c, state))
    .map((control, order) => ({ control, order, rating: effectiveRating(control, actionEntry(state, control.id)), phase: phaseOf(control, data, state) }))
    .filter((g) => g.rating === "not" || g.rating === "partial")
    .sort((a, b) => weight[a.rating] - weight[b.rating] || a.phase - b.phase || a.order - b.order);
}

// Validates untrusted JSON (import or storage) and rebuilds state only from known keys.
export function normaliseState(raw, data) {
  const warnings = [];
  const state = emptyState(data);
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { state, warnings: ["The file is not an assessment."], ok: false };
  if (raw.schema !== SCHEMA) return { state, warnings: [`Unsupported assessment format (schema ${String(raw.schema).slice(0, 20)}).`], ok: false };
  if (raw.catalogVersion !== data.catalog.version) {
    warnings.push(`Assessed against catalog ${text(raw.catalogVersion, 40) || "unknown"}; this tool uses ${data.catalog.version}. Matching actions were kept.`);
  }
  state.updatedAt = typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt.slice(0, 40) : null;
  state.details = {
    organisation: text(raw.details?.organisation, LIMITS.short),
    assessor: text(raw.details?.assessor, LIMITS.short),
    date: validDate(raw.details?.date),
  };
  for (const domain of data.domains) {
    if (!own(raw.scope, domain.id)) continue;
    const entry = raw.scope[domain.id];
    state.scope[domain.id] = { inScope: entry?.inScope !== false, justification: text(entry?.justification, LIMITS.justification) };
  }
  const known = new Set(data.controls.map((c) => c.id));
  if (raw.actions && typeof raw.actions === "object") {
    const unknown = Object.keys(raw.actions).filter((id) => !known.has(id)).length;
    if (unknown) warnings.push(`${unknown} unrecognised action${unknown === 1 ? "" : "s"} ignored.`);
  }
  for (const control of data.controls) {
    if (!own(raw.actions, control.id)) continue;
    const entry = raw.actions[control.id];
    if (entry == null || typeof entry !== "object") continue;
    const ids = new Set(Object.values(control.indicators).flat().map((i) => i.id));
    const indicators = Array.isArray(entry.indicators) ? [...new Set(entry.indicators.filter((i) => typeof i === "string" && ids.has(i)))] : [];
    const rating = RATINGS.includes(entry.rating) ? entry.rating : null;
    const clean = {
      indicators,
      rating,
      evidence: text(entry.evidence, LIMITS.long),
      owner: text(entry.owner, LIMITS.short),
      date: validDate(entry.date),
      ref: text(entry.ref, LIMITS.short * 2),
    };
    if (clean.indicators.length || clean.rating || clean.evidence || clean.owner || clean.date || clean.ref) state.actions[control.id] = clean;
  }
  return { state, warnings, ok: true };
}

// Spreadsheets run cells that start with these characters as formulas.
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

export function toCsv(data, state) {
  const header = [
    "Action ID", "Principle", "Action", "Domains", "In scope", "Rating", "Suggested rating",
    "Indicators observed", "Evidence", "Owner", "Date", "Evidence reference", "Catalog version",
  ];
  const rows = data.controls.map((control) => {
    const entry = actionEntry(state, control.id);
    const suggested = suggestRating(control, new Set(entry.indicators));
    const principle = data.principles.find((p) => p.id === control.principleId);
    return [
      control.id,
      `${principle.id} ${principle.title}`,
      control.action,
      control.domains.map((d) => data.domains.find((x) => x.id === d).title).join("; "),
      appliesInScope(control, state) ? "Yes" : "No",
      RATING_LABELS[effectiveRating(control, entry)],
      suggested ? RATING_LABELS[suggested] : "",
      entry.indicators.join("; "),
      entry.evidence,
      entry.owner,
      entry.date,
      entry.ref,
      data.catalog.version,
    ];
  });
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function percent(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}
