# E4EIT Assurance

A private, in-browser tool for assessing an organisation against the [ASD Essentials for enterprise IT](https://www.cyber.gov.au/publication/essentials-for-enterprise-it). It loads ASD's OSCAL catalog of actions and indicators of good practice, lets you scope the eight domains, record what you observe against each action, and shows gaps by priority phase, domain and principle. GitHub Pages serves the static site.

Assessments never leave the browser. They are saved in local storage and can be exported as JSON or CSV, or printed as a report. The page's content security policy blocks all network requests (`connect-src 'none'`).

This is a working aid, not an ASD product. Priority phases are a sequencing mechanism and not a maturity rating, so the tool reports counts of actions by rating and never a composite score. Ratings are the assessor's own judgement and are not an IRAP assessment.

## What it does

- **Scope**: mark each domain in or out of scope, with a reason. Actions count only where one of their domains is in scope.
- **Assess**: for each action, tick the Not effective, Partially effective and Fully effective indicators you have evidence for. A suggested rating is derived cautiously (any Not effective indicator gives Not effective, then any Partially effective indicator gives Partially effective, then all Fully effective indicators gives Fully effective); the assessor can override it. Each action also records an owner, date, evidence reference and notes.
- **Summarise**: progress by phase, domain and principle, plus a gap list ordered worst first, then by phase.
- **Browse**: filter actions by domain, phase, principle group, rating and MITRE ATT&CK technique, or search the wording.
- **Export and import**: JSON (full fidelity, re-importable), CSV (one row per action; cells starting with a formula character are neutralised), and a printable report.

## Data source and licence

`data/oscal/E4EIT_catalog.json` is a copy of ASD's OSCAL catalog (catalog version 2026.10.15, OSCAL 1.2.3) from the ACSC mirror at https://github.com/AustralianCyberSecurityCentre/e4eit-oscal. The authoritative source is https://www.cyber.gov.au/e4eit/oscal.

The catalog and the descriptions of domains are material from ASD Essentials for enterprise IT, &copy; Commonwealth of Australia 2026, used under the [Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/). This project has been changed from the original by flattening the catalog into a compact JSON file for display. ASD does not endorse this project.

## Updating the catalog

The catalog is vendored, not fetched at build time.

1. Download the new `E4EIT_catalog.json` from the ASD mirror over the file in `data/oscal/`.
2. Run `cd site && npm run prepare-data`. It fails with a descriptive error if the structure has changed (unknown domain, missing action, unresolved technique link).
3. Run `npm test` and review the diff of expected counts in `site/tests/prepare-data.test.mjs`.
4. Saved assessments record the catalog version. Importing an assessment made against another version keeps actions with matching IDs and warns about the mismatch.

## Local use

Requires Node.js 22.12 or newer.

~~~sh
cd site
npm install
npm run dev
~~~

Then open http://localhost:4321/e4eit-assurance/. Run the checks with:

~~~sh
cd site
npm run check
~~~

`npm run check` runs the unit tests, builds the site and verifies the build output. The `site/src/data/e4eit.json` file is generated from the catalog before `dev`, `build` and `test`, and is not committed.

## GitHub Pages

In the repository settings, set Pages source to GitHub Actions. `.github/workflows/deploy.yml` tests, builds and deploys on every push to main. The site is served under `/e4eit-assurance/` on the organisation's custom domain.

## Project contents

- data/oscal/ holds the vendored ASD OSCAL catalog.
- scripts/prepare-data.mjs validates the catalog and writes the compact JSON the site bundles.
- site/src/lib/model.js has the pure assessment logic (ratings, scope, summaries, import validation, CSV).
- site/src/scripts/app.js wires the page to local storage and the export controls.
- site/ contains the Astro site in the EmDash Cyber theme.
