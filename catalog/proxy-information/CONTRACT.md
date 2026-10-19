# Proxy information and publication contract

Status: content-maintenance contract. The authoring schema here is a maintenance format. It does not change a published Catalog wire schema on its own. The signed assets of older Catalog releases stay as published. An English source cleanup is not a new signed Catalog.

Compatible publication projects the nine-chapter tutorial into setup (chapters 1–4), usage (chapters 5–8), and troubleshooting (chapter 9), and places the full history Markdown in overview. Before publication, verify that changelog.json matches its Markdown, that history order and the nine chapters are intact, and that the certified Runtime combination is the real one. Body files stay on the v1 signed asset list. A new wire-level version index, a separate history view, and Host basic-information status changes are outside this content publication. Later integration requirements still apply to those follow-on capabilities.

## 1. Single source of information

| Information | Authority | Do not maintain it by |
| --- | --- | --- |
| pluginId, name, Proxy version, process scope, protocol range | That Proxy's Manifest and package, checked at publication | Typing a second version into a README, a Web constant, or the Catalog by hand |
| This machine's current Runtime path and version, and current Proxy | The Host's active generation and install receipt; source-development state must be labeled | Treating the Catalog's latest version as the installed version |
| Runtime to install, and download coordinates | The signed Catalog's certified combination and the Proxy install plan | Deriving them from an upstream latest tag, PATH, or prose |
| First-install target location | The Host, from the current dataDir and the certified install plan | The Web concatenating a user-editable CLI path |
| Tutorial, operational notes, troubleshooting | Hand-maintained tutorial.md, checked against source and behavior evidence | Copying a stale README or a design-draft example |
| Version history | One record per Proxy version in changelog.json | Presenting the App changelog, or a cross-Proxy compare link, as a complete history |
| HOME | The Host's Agent and Home records; ZCode uses the external application's state boundary | Writing it into the signed Catalog, or mixing it into the Runtime program identity |

Current tutorials must not enumerate a model table that never changes. Available models, reasoning levels, modes, and actions come from the current Runtime and Proxy. Capability lists must separate what the protocol implements, what the runtime condition allows, and what the user can use right now.

## 2. Basic information display

The body is three lines, in this order: Runtime path, Runtime version, Proxy version. Name and icon stay in the panel title. Do not put platform, Plugin ID, process scope, Bridge, or the certification matrix back into those three lines.

- Active: show the current values from the Host receipt. Do not overwrite them with latest.
- Not installed: the Runtime version says "Not installed". The path shows the planned location returned by the Host and is labeled as an install location. If there is no Proxy, the Proxy version says "Not installed". A target version belongs in the install preview. It is not marked installed.
- Source development: the source Proxy's real version may be shown, labeled as a development source. That does not mean the certified Runtime combination is active.
- Update: current values still show the old combination. Version changes and Update sit in the action area after the three lines. An inactive new value must not replace the current value early.
- ZCode: show the embedded program location discovered in the real App. When it is not found, show "ZCode.app was not detected". Do not invent a verified path or download target.
- Paths are read-only. Copy copies the full canonical path. Opening a file location is done by the Host. The Web does not accept an arbitrary path.

basic.md is a status sample, not a static machine state to publish. Target display data should at least distinguish current, candidate, origin, and availability, instead of a single version field.

## 3. Tutorial content

Product copy is English. The Catalog still carries `en` and `zh-CN` locale keys so existing clients can select a locale. Both keys use the same English name, tagline, and documents. The Web does not hard-code Provider copy, and it does not call a model to translate Catalog documents. The compatible v1 localization extension uses the optional `catalog-localizations-v1.json`, signed with the original asset list. Its `en` and `zh-CN` entries declare the name, tagline, and the path, size, and digest of four documents. Files belong to the same signed generation. Reference paths are fixed as `docs/<pluginId>/<locale>/<document>.md`. HTML, paths that escape the tree, a missing locale, and a mismatched digest are rejected. Old clients keep reading the original four documents. Unknown fields are not added to the strict v1 index.

The Host returns the localized projection. The document endpoint selects already-verified content with an explicit locale parameter. The Web follows the language setting directly. Language and generation both isolate the cache. An old Catalog with no localization asset falls back to its original content. Unpublished English text must not be labeled as already provided. Brand names, versions, paths, and evidence URLs do not change with language.

Each tutorial.md has nine fixed second-level chapters:

1. What it does in Gian.
2. Capabilities and limitations.
3. Runtime architecture.
4. Installation and dependencies.
5. First use.
6. HOME and isolation.
7. Reverse proxies and custom endpoints.
8. Operational notes.
9. Troubleshooting.

The nine chapters are one continuous document. Navigation only scrolls. It does not hide other chapters. Chapter 3 must match the current source. Chapter 7 must not assume that vendors share URLs, authentication headers, or protocols. Chapter 9 must give symptom, check, and next step. "Check the configuration" alone is not enough.

Tutorials must not request or display credentials, must not offer a remote shell command that runs automatically, and must not promise an upstream version, model, platform, or rollback that has not been verified.

## 4. History data format

changelog.json contains schemaVersion, pluginId, currentVersion, entries, and withdrawnVersions at the top level. Each entries item:

| Field | Type and requirement | Meaning |
| --- | --- | --- |
| version | Stable SemVer, required and unique | Proxy version, not the App or CLI version |
| firstPublishedAt | UTC ISO time, required | When that Proxy version was first published |
| distributions | Non-empty array | Tag, date, URL, Manifest and archive digests, and the CLI declaration for each repository distribution |
| changes | Array | category, text, and evidence; only evidenced additions, changes, fixes, and notes |
| evidenceCoverage | detailed or metadata-only | Whether the historical notes can be attributed precisely |
| unknowns | Array of strings | What retained material cannot prove; show it, do not invent it |

Runtime declarations in distributions use basis values verified-declaration, recommended-declaration, and unrecorded. None of those declarations is automatically promoted to a full certified combination. The actual current managed combination cites the Catalog coordinate in current-combinations.json. A historical combination is certified only when the certification or Catalog evidence from that time is found.

The same version distributed from Gian and from Gian-Proxies keeps one entries item. Each distribution has its own publication date and SHA-256. The newer DeepSeek Harness 0.3.1 distribution carries a Bridge. That distribution difference must be stated. Do not claim that bytes from different origins of the same version are identical.

Version records are ordered by SemVer, newest first. Dates keep their original values. Do not rewrite a publication date to change sort order. Withdrawn versions are listed only in withdrawnVersions and are not installable. Empty Added, Changed, and Fixed sections are not rendered.

## 5. Errors that compilation and publication must block

1. The current Manifest or package version is missing from history, or appears more than once.
2. A duplicate version under one pluginId, an invalid SemVer, a dateless source, or a duplicate distribution URL.
3. The current combination's Proxy, CLI, or Bridge disagrees with the certified asset.
4. A recommendedCliVersion or a historical compatibility declaration is labeled as the currently installed or certified combination.
5. Withdrawn 0.4.0, a draft, a prerelease, or a mutable latest or branch URL is treated as a stable install coordinate.
6. A tutorial is missing a chapter, or Markdown contains HTML, script, or style, an escaping path, a dangerous URL, or oversized content.
7. A new version history has no factual notes. A historical migration may be metadata-only, but it must list unknowns. It must not be shown as a complete changelog.
8. A historical backfill overwrites an existing publication record. A correction keeps the original source and adds a correction note. Published assets are not rewritten.

Use the existing SemVer and Markdown parser. Do not implement this with string sorting or HTML concatenation. Compiler output binds both the tutorial and the release-indexed changelog to the signed asset manifest. The Web renders only content that is verified and bounded.

## 6. Integration order

1. Review this directory's prose, historical facts, and field ownership.
2. Implement the authoring compile input. Generate one tutorial and a bounded, version-indexed history projection. The old four documents may remain during migration, but they are not a separate maintenance source.
3. Choose an explicit Catalog schema compatibility plan. If old clients reject unknown fields, consumer support must exist first. Do not force new fields into the old strict schema.
4. The Host returns this machine's current and candidate state. The Web keeps the three-line Basic view, loads the full tutorial and history, and removes the changelogPending placeholder.
5. Add checks for structured data, signatures, history order, current-version uniqueness, migration compatibility, render safety, and path display. The Owner chooses where those checks run.
6. Publish a new Catalog sequence only after review and the selected verification pass. A documentation revision does not by itself change a Proxy version. If consumers must change, the App release is separate.

## 7. File review acceptance

- Each shipping Proxy has a complete nine-chapter tutorial. DeepSeek Harness and ZCode are not renamed copies of a generic CLI page.
- A user can tell the Proxy program, the vendor Runtime, HOME, and an LLM API proxy apart.
- The current real version comes only from the structured record. "The source runs" is not written as "the release combination is installed".
- History is bounded to one Proxy. Distributions of the same version are merged. Versions, dates, and features are not invented.
- There are concrete samples for the location before first install, signed-out after install, waiting on an update, and retained state after failure.
- A read-only document and a passing validator are not real-Provider, install, or Desktop acceptance.
