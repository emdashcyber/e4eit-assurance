// Flattens the vendored ASD OSCAL catalog into the compact JSON the site bundles.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const DOMAIN_NS = "https://www.cyber.gov.au/ns/essentials/oscal/1.0";

// Domain descriptions follow Table 1 of "Essentials for enterprise IT" (cyber.gov.au, CC BY 4.0).
const DOMAINS = [
  { id: "boundary-services", title: "Boundary services", kind: "technical", phase: 1,
    summary: "Assets at network boundaries that broker connectivity between environments of different trust levels, including internet-facing services and edge devices.",
    risk: "Internet-facing and boundary systems are routinely exposed to adversary scanning and exploitation making them common targets for initial access." },
  { id: "identity-services", title: "Identity services", kind: "technical", phase: 1,
    summary: "Enterprise-wide identity, credential and access management services such as directories, authentication and authorisation services or credential stores.",
    risk: "Compromise of enterprise-wide identity services can enable an adversary to gain persistent or privileged access across the enterprise." },
  { id: "critical-processes-and-services", title: "Critical processes and services", kind: "technical", phase: 2,
    summary: "Core processes and services that are critical to delivering primary organisational outcomes.",
    risk: "Compromise or loss of these systems can disrupt the organisation's ability to deliver critical outcomes or services." },
  { id: "privileged-environments", title: "Privileged environments", kind: "technical", phase: 2,
    summary: "Systems and services that support privileged activities, management services and high-impact administrative functions.",
    risk: "Compromise of privileged systems can give an adversary extensive control over systems, services and security controls." },
  { id: "business-systems", title: "Business systems", kind: "technical", phase: 3,
    summary: "Supporting enterprise functions that collectively enable organisational operations.",
    risk: "Compromise can disrupt day-to-day operations and provide pathways to more sensitive or critical systems." },
  { id: "user-devices", title: "User devices", kind: "technical", phase: 3,
    summary: "Endpoints issued to the workforce, including desktops and laptops.",
    risk: "Widespread use and exposure make user devices common entry points for adversaries seeking access to the environment." },
  { id: "governance-and-culture", title: "Governance and culture", kind: "capability", phase: null,
    summary: "Policies, risk management processes, roles and security culture that underpin cyber security program.",
    risk: "Unclear ownership and accountability can lead to inconsistent security decisions and outcomes degrading over time." },
  { id: "visibility-and-response", title: "Visibility and response", kind: "capability", phase: null,
    summary: "Procedures and capabilities for detecting, analysing and responding to cyber security events and incidents.",
    risk: "Limited visibility and response can delay the detection, analysis and containment of intrusions." },
];

const PHASES = [
  { id: 1, title: "Phase 1", domains: ["boundary-services", "identity-services"] },
  { id: 2, title: "Phase 2", domains: ["critical-processes-and-services", "privileged-environments"] },
  { id: 3, title: "Phase 3", domains: ["business-systems", "user-devices"] },
];

const LEVELS = [
  { key: "not", title: "Not effective", cls: "not-effective-indicator-statement" },
  { key: "partial", title: "Partially effective", cls: "partially-effective-indicator-statement" },
  { key: "fully", title: "Fully effective", cls: "fully-effective-indicator-statement" },
];

const fail = (message) => {
  throw new Error(`E4EIT catalog: ${message}`);
};

const part = (parent, cls) => (parent.parts ?? []).find((p) => p.class === cls);

export function buildData(doc) {
  const catalog = doc?.catalog ?? fail("missing catalog");
  const meta = catalog.metadata ?? fail("missing metadata");
  const domainIds = new Set(DOMAINS.map((d) => d.id));
  const resources = new Map((catalog["back-matter"]?.resources ?? []).map((r) => [r.uuid, r]));

  const families = [];
  const principles = [];
  const controls = [];
  const seen = new Set();

  for (const family of catalog.groups ?? fail("missing groups")) {
    families.push({ id: family.id, title: String(family.title ?? "").replace(/ principles$/i, "") });
    for (const group of family.groups ?? []) {
      if (group.class !== "essentials-principle") fail(`unexpected group ${group.id}`);
      const overview = (group.parts ?? []).find((p) => p.name === "overview")?.prose ?? fail(`${group.id} has no overview`);
      const principle = {
        id: group.id,
        family: family.id,
        title: String(group.title).replace(new RegExp(`^${group.id}\\s+-\\s+`), ""),
        statement: overview,
        controlIds: [],
      };
      for (const control of group.controls ?? []) {
        if (seen.has(control.id)) fail(`duplicate control ${control.id}`);
        seen.add(control.id);
        const domains = control.props.filter((p) => p.name === "domain" && p.ns === DOMAIN_NS).map((p) => p.value);
        if (!domains.length) fail(`${control.id} has no domain`);
        for (const d of domains) if (!domainIds.has(d)) fail(`${control.id} has unknown domain ${d}`);
        const action = part(control, "essentials-action")?.prose ?? fail(`${control.id} has no action`);
        const good = part(control, "indicators-of-good-practice") ?? fail(`${control.id} has no indicators`);
        const indicators = {};
        for (const level of LEVELS) {
          const items = (good.parts ?? []).find((g) => g.title === level.title)?.parts ?? [];
          indicators[level.key] = items.map((item) => {
            if (item.class !== level.cls || !item.id || !item.prose) fail(`${control.id} has a malformed ${level.title} indicator`);
            return { id: item.id, text: item.prose };
          });
        }
        if (!indicators.fully.length) fail(`${control.id} has no fully effective indicators`);
        const techniques = (control.links ?? []).filter((l) => l.rel === "mitigated-technique").map((l) => {
          const resource = resources.get(String(l.href).replace(/^#/, "")) ?? fail(`${control.id} links to an unknown technique`);
          const url = resource.rlinks?.[0]?.href ?? "";
          if (!url.startsWith("https://attack.mitre.org/")) fail(`${control.id} has an unexpected technique URL`);
          return { name: resource.title, url };
        });
        controls.push({ id: control.id, principleId: group.id, action, domains, techniques, indicators });
        principle.controlIds.push(control.id);
      }
      if (!principle.controlIds.length) fail(`${group.id} has no actions`);
      principles.push(principle);
    }
  }

  const used = new Set(controls.flatMap((c) => c.domains));
  for (const d of domainIds) if (!used.has(d)) fail(`domain ${d} has no actions`);

  return {
    catalog: {
      title: meta.title,
      version: meta.version,
      published: meta.published,
      oscalVersion: meta["oscal-version"],
      source: "https://github.com/AustralianCyberSecurityCentre/e4eit-oscal",
    },
    phases: PHASES,
    domains: DOMAINS,
    families,
    principles,
    controls,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = new URL("data/oscal/E4EIT_catalog.json", root);
  const output = new URL("site/src/data/e4eit.json", root);
  const data = buildData(JSON.parse(readFileSync(input, "utf8")));
  mkdirSync(dirname(fileURLToPath(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(data)}\n`);
  console.log(`Wrote ${data.controls.length} actions in ${data.principles.length} principles (catalog ${data.catalog.version}).`);
}
