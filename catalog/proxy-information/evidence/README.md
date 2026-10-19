# Evidence notes

Collected on 2026-09-20, with later publication records appended in the same files. This directory stores public release metadata, public Manifests, and facts from a signature-checked Catalog. It does not store accounts, HOME contents, credentials, or signing private keys.

- releases.json: public Release pages for the shipping Proxies, excluding drafts and prereleases. Distribution records remain the captured RichLogic/Gian and RichLogic/Gian-Proxies coordinates.
- manifests.json: Manifest sidecars for those records, each checked against the SHA-256 published with the GitHub asset. Old recommended CLI fields and newer verifiedVersions are both kept, and they stay distinct.
- current-combinations.json: the managed-target basis taken from a previously downloaded and signature-checked Catalog. It is not this machine's active state.
- dsh-bridge-versions.json: versions read from dsh-bridge/package.json at the corresponding old public Git tag. That proves a source combination only. It does not replace archive integrity or a real run.

Old Release bodies are often generated cross-Proxy compare links, for example from a Claude tag to a Codex tag. That link is not Codex's user-facing changelog. changelog.json uses only attributable Manifest differences, confirmed source fixes, and public release facts. Everything else is metadata-only.

Current source references:

- Capabilities: each Proxy's protocol/v2-adapter.ts; ZCode's identity.ts and adapter.ts.
- HOME: packages/host/src/agents/home.ts.
- Install layout: packages/proxy-protocol/src/runtime-install.ts and each Proxy's runtime/install.ts.
- Real target combinations: current-combinations.json.
- Kimi 0.3.2: 4f145332, b6191ced, 763ed833, and the public source at that time.
- ZCode 0.3.2: 6af05744 and Issue #163.
- DeepSeek Harness Bridge in the newer repository distribution: 9b39f25c, bundlePackages in packages/proxies/dsh-proxy/package.json, and runtime/profile.ts.

The tutorials describe capabilities and limits that the source implements. They do not claim that installation, model calls, history recovery, or UI tests were rerun for this documentation pass. Statements in old READMEs such as "protocol only 2.1" or "current ZCode 0.1.1" are not current version facts.

These evidence files record already published coordinates. They are not retargeted at a repository that does not hold those assets.
