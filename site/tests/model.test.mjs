import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  csvCell, effectiveRating, emptyState, gaps, normaliseState, suggestRating, summarise, toCsv,
} from "../src/lib/model.js";

const data = JSON.parse(readFileSync(new URL("../src/data/e4eit.json", import.meta.url), "utf8"));
const control = (id) => data.controls.find((c) => c.id === id);
const ticks = (c, level, n = Infinity) => c.indicators[level].slice(0, n).map((i) => i.id);

test("suggestion is cautious: not > partial > fully, and null with no evidence", () => {
  const c = control("IT.PRO-06.2");
  assert.equal(suggestRating(c, new Set()), null);
  assert.equal(suggestRating(c, new Set(ticks(c, "fully"))), "fully");
  assert.equal(suggestRating(c, new Set(ticks(c, "fully", 1))), "partial");
  assert.equal(suggestRating(c, new Set([...ticks(c, "fully"), ...ticks(c, "partial", 1)])), "partial");
  assert.equal(suggestRating(c, new Set([...ticks(c, "fully"), ...ticks(c, "not", 1)])), "not");
});

test("an explicit rating overrides the suggestion", () => {
  const c = control("IT.PRO-06.2");
  assert.equal(effectiveRating(c, { indicators: ticks(c, "fully"), rating: "not" }), "not");
  assert.equal(effectiveRating(c, { indicators: ticks(c, "fully"), rating: null }), "fully");
  assert.equal(effectiveRating(c, { indicators: [], rating: null }), "unassessed");
  assert.equal(effectiveRating(c, { indicators: [], rating: "bogus" }), "unassessed");
});

test("summary counts only in-scope actions and shares actions across domains once in totals", () => {
  const state = emptyState(data);
  assert.equal(summarise(data, state).overall.total, data.controls.length);
  state.scope["user-devices"].inScope = false;
  state.scope["business-systems"].inScope = false;
  const s = summarise(data, state);
  const expected = data.controls.filter((c) => c.domains.some((d) => !["user-devices", "business-systems"].includes(d))).length;
  assert.equal(s.overall.total, expected);
  assert.equal(s.domainRows.find((r) => r.id === "user-devices").tally, null);
  assert.equal(s.phaseRows[2].tally, null);
  const boundary = s.domainRows.find((r) => r.id === "boundary-services").tally.total;
  assert.equal(boundary, data.controls.filter((c) => c.domains.includes("boundary-services")).length);
});

test("gaps list worst first, then phase, and leave out unassessed and fully effective actions", () => {
  const state = emptyState(data);
  const a = control("IT.PRO-06.2");
  const b = control("IT.GOV-01.1");
  const d = control("IT.PRO-10.1");
  state.actions[a.id] = { indicators: [], rating: "partial", evidence: "", owner: "", date: "", ref: "" };
  state.actions[b.id] = { indicators: [], rating: "not", evidence: "", owner: "", date: "", ref: "" };
  state.actions[d.id] = { indicators: [], rating: "fully", evidence: "", owner: "", date: "", ref: "" };
  const list = gaps(data, state);
  assert.deepEqual(list.map((g) => g.control.id), [b.id, a.id]);
  assert.equal(list[0].phase, 0);
  assert.equal(list[1].phase, 1);
});

test("import keeps only known keys and bounds values", () => {
  const poisoned = JSON.parse(`{
    "schema": 1, "catalogVersion": "old",
    "details": { "organisation": "${"x".repeat(500)}", "assessor": 5, "date": "2026-02-30" },
    "scope": { "user-devices": { "inScope": false, "justification": "n/a" }, "__proto__": { "inScope": false }, "nope": {} },
    "actions": {
      "IT.PRO-06.2": { "indicators": ["IT.PRO-06.2.FE-1", "IT.PRO-06.2.FE-1", "bogus"], "rating": "fully", "evidence": "ok", "date": "2026-10-17", "owner": 3 },
      "IT.PRO-10.1": { "rating": "excellent" },
      "constructor": { "rating": "not" },
      "__proto__": { "rating": "not" },
      "UNKNOWN": { "rating": "not" }
    }
  }`);
  const { state, warnings, ok } = normaliseState(poisoned, data);
  assert.ok(ok);
  assert.equal(state.details.organisation.length, 200);
  assert.equal(state.details.assessor, "");
  assert.equal(state.details.date, "");
  assert.equal(state.scope["user-devices"].inScope, false);
  assert.equal(state.scope["business-systems"].inScope, true);
  assert.deepEqual(state.actions["IT.PRO-06.2"].indicators, ["IT.PRO-06.2.FE-1"]);
  assert.equal(state.actions["IT.PRO-06.2"].owner, "");
  assert.deepEqual(Object.keys(state.actions), ["IT.PRO-06.2"]);
  assert.equal(({}).inScope, undefined);
  assert.ok(warnings.some((w) => w.includes("catalog old")));
  assert.ok(warnings.some((w) => w.includes("unrecognised")));
});

test("import rejects non-assessments and other schemas", () => {
  for (const raw of [null, [], "x", 3, { schema: 2 }, {}]) assert.equal(normaliseState(raw, data).ok, false);
});

test("export then import round-trips", () => {
  const state = emptyState(data);
  state.details.organisation = "Example Pty Ltd";
  state.scope["user-devices"] = { inScope: false, justification: "BYOD only" };
  state.actions["IT.PRO-06.2"] = { indicators: ["IT.PRO-06.2.FE-1"], rating: "partial", evidence: "Scan report", owner: "SecOps", date: "2026-10-17", ref: "DOC-1" };
  const again = normaliseState(JSON.parse(JSON.stringify(state)), data);
  assert.deepEqual(again.state, state);
  assert.deepEqual(again.warnings, []);
});

test("csv cells are quoted and neutralise spreadsheet formulas", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) assert.ok(csvCell(bad).startsWith(`"'`), bad);
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(csvCell(null), '""');
});

test("csv has one row per action and records ratings, evidence and scope", () => {
  const state = emptyState(data);
  state.scope["governance-and-culture"].inScope = false;
  state.actions["IT.PRO-06.2"] = { indicators: [], rating: "fully", evidence: "=HYPERLINK(\"x\")", owner: "", date: "", ref: "" };
  const lines = toCsv(data, state).trimEnd().split("\r\n");
  assert.equal(lines.length, data.controls.length + 1);
  const row = lines.find((l) => l.startsWith('"IT.PRO-06.2"'));
  assert.ok(row.includes('"Fully effective"'));
  assert.ok(row.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines.find((l) => l.startsWith('"IT.GOV-01.1"')).includes('"No"'));
});
