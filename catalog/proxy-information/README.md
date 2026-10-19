# Proxy information source

This directory holds tutorials and version history. After review, the Gian-Proxies Catalog workflow compiles them. The compatible v1 body projection does not change Proxy versions, signing keys, or a running App. Rewriting this source into English is not a newly signed Catalog. A basic-information sample on this machine is not a static published state.

## Which files to read

| Proxy | Basic information and status samples | Product tutorial | Version history |
| --- | --- | --- | --- |
| Claude Code | [Basic information](claude/basic.md) | [Tutorial](claude/tutorial.md) | [Version history](claude/changelog.md) |
| Codex | [Basic information](codex/basic.md) | [Tutorial](codex/tutorial.md) | [Version history](codex/changelog.md) |
| Kimi Code | [Basic information](kimi/basic.md) | [Tutorial](kimi/tutorial.md) | [Version history](kimi/changelog.md) |
| DeepSeek Harness | [Basic information](ai.deepseek.harness/basic.md) | [Tutorial](ai.deepseek.harness/tutorial.md) | [Version history](ai.deepseek.harness/changelog.md) |
| ZCode | [Basic information](com.zhipu.zcode/basic.md) | [Tutorial](com.zhipu.zcode/tutorial.md) | [Version history](com.zhipu.zcode/changelog.md) |
| Grok Build | [Basic information](grok/basic.md) | [Tutorial](grok/tutorial.md) | [Version history](grok/changelog.md) |

Read Claude's full flow first, then DeepSeek Harness dependencies, ZCode's external-app exception, and Grok's per-session Runtime. All six tutorials use the same nine chapters. Capabilities, runtime behavior, and limits follow each implementation. They do not share one capability sheet.

## Boundaries of this draft

- Basic information keeps three fields: Runtime path, Runtime version, and Proxy version. Status samples in each basic.md are for reviewers. They are not extra fields stuffed into the UI as one page.
- Tutorial prose is for people using Gian. Source, evidence, and migration rules stay in this directory's appendix. Users do not need the certification matrix to operate the product.
- The release-combination snapshot uses published Proxy certification records and keeps combinations from the previous signed Catalog that were not updated. It does not mean this machine has that Runtime installed.
- Version history merges old and new repository distributions of the same version. A migration is not a new Proxy version. Withdrawn 0.4.0 is not an available version.
- Most old Releases only have a whole-repository compare link. That is not a detailed changelog for one Proxy. Historical release dates, protocols, and CLI declarations have evidence. Feature changes that cannot be attributed stay unrecorded. Do not invent Added or Fixed notes.
- Grok 0.3.5 completed its own admission. The Catalog declares only capabilities that Grok CLI 1.0.41 actually exposes over stdio.

## Review focus

1. Can a user install, create an Agent, configure HOME, sign in the first time, and update from the tutorial alone?
2. Can they tell a Gian Proxy, a vendor Runtime, and an LLM reverse proxy apart?
3. Can they tell "Proxy present, Runtime not installed", "new HOME not signed in", and "upstream Runtime incompatible" apart?
4. Are the DeepSeek Harness Bridge, Kimi's different distributions, and ZCode's known limits stated clearly?
5. Is version history specific and traceable, and does it leave unknown history unknown?

## Files used by implementation and publication

- `localizations.json`: display name and tagline for the six Proxies. `en` and `zh-CN` locale keys both carry the same English product copy so the signed localization shape stays compatible. `tutorial.md` is the only tutorial. `changelog.json` is the only structured history, including the English notes. There is no `history-copy.en.json` and no `tutorial.en.md`.
- Bilingual compilation still adds the signed assets `catalog-localizations-v1.json` and `docs/<pluginId>/<locale>/*.md`. It does not change old v1 index fields. Gian selects `en` or `zh-CN` from the interface language. Document URLs and caches stay isolated by language. An old Catalog without localization assets keeps its original content. This source does not invent a translation that was not published.
- [Information and publication contract](CONTRACT.md): field sources, the three-line display, validation rules, legacy migration, and acceptance.
- Each Proxy's changelog.json is the only structured history. changelog.md is the review projection. Do not maintain two histories.
- [Content validator](validate.mjs): checks that the current version is unique, history order, real release dates and digests, the nine-chapter structure, and Markdown projection consistency. The Catalog publication workflow runs it. Failure blocks publication.
- [v1 body projection](project.mjs): setup is tutorial chapters 1–4, usage is chapters 5–8, and troubleshooting is chapter 9. The current UI renders them in order as the full tutorial. overview publishes the full version-history Markdown. A separate version-history view still needs a consumer.
- [Evidence notes](evidence/README.md): collection scope, source tiers, and known gaps.
- [Current release combinations](evidence/current-combinations.json).
- [Public Release records](evidence/releases.json), [historical Manifests](evidence/manifests.json), and [DeepSeek Harness Bridge versions](evidence/dsh-bridge-versions.json).

Publication copies official-source into a temporary directory, then this directory generates the four body files and replaces old placeholders. It does not add fields to the old strict schema. The maintenance index for the full history remains changelog.json. The current signed assets carry only its Markdown projection. They do not pretend a new wire-level release index already exists. basic.md, CONTRACT.md, and evidence are maintenance and review material. They are not published as the machine's basic information.

Do not invent unpublished versions to fill gaps in historical numbering. This draft lists 69 unique versions and 72 public distributions. 28 older versions still cannot recover a complete feature changelog. Their evidence limits stay explicit.

The validator is read-only unless `--render` is passed. That flag regenerates changelog.md from changelog.json. It reuses the repository's locked SemVer and Markdown parser. It does not add a new dependency set.

English source text here is not a signed Catalog release. Existing RichLogic release tags, digests, and Manifest URLs stay the published coordinates.
