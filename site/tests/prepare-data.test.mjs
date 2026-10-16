import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildData } from "../../scripts/prepare-data.mjs";

const catalog = () => JSON.parse(readFileSync(new URL("../../data/oscal/E4EIT_catalog.json", import.meta.url), "utf8"));

test("vendored catalog flattens to the expected shape", () => {
  const data = buildData(catalog());
  assert.equal(data.catalog.version, "2026.10.15");
  assert.equal(data.domains.length, 8);
  assert.equal(data.phases.length, 3);
  assert.deepEqual(data.families.map((f) => f.id), ["GOV", "IDE", "PRO", "DET", "RES"]);
  assert.equal(data.principles.length, 28);
  assert.equal(data.controls.length, 58);
  const ids = new Set(data.controls.map((c) => c.id));
  assert.equal(ids.size, data.controls.length);
  for (const c of data.controls) {
    assert.ok(c.action && c.domains.length, c.id);
    assert.ok(c.indicators.fully.length > 0, c.id);
    for (const t of c.techniques) assert.ok(t.url.startsWith("https://attack.mitre.org/"), c.id);
  }
  const phased = data.phases.flatMap((p) => p.domains).sort();
  assert.deepEqual(phased, data.domains.filter((d) => d.kind === "technical").map((d) => d.id).sort());
});

test("a malformed catalog fails loudly rather than producing partial data", () => {
  const unknownDomain = catalog();
  unknownDomain.catalog.groups[0].groups[0].controls[0].props.find((p) => p.name === "domain").value = "made-up";
  assert.throws(() => buildData(unknownDomain), /unknown domain/);

  const noAction = catalog();
  noAction.catalog.groups[0].groups[0].controls[0].parts = [];
  assert.throws(() => buildData(noAction), /no action/);

  const badLink = catalog();
  const withLink = badLink.catalog.groups.flatMap((f) => f.groups).flatMap((g) => g.controls).find((c) => c.links?.length);
  withLink.links[0].href = "#missing";
  assert.throws(() => buildData(badLink), /unknown technique/);

  assert.throws(() => buildData({}), /missing catalog/);
});
