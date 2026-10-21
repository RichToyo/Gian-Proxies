# ZCode: Version history

Generated from the structured changelog, newest Proxy version first. Original publication and later repository distributions are recorded separately; missing historical details are not invented.

Release combination snapshot: Proxy **0.4.6**, Runtime **0.17.0**. These are distribution targets, not this machine's installed state.

## 0.4.6

First published: 2026-10-21T05:17:04Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.6): 2026-10-21T05:17:04Z.
- CLI: 0.17.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Runtime to reviewed App-source 3.16.2 at immutable commit 3c5b227; CLI remains 0.17.0. The dependency lock, protocol entrypoint and database migration source are unchanged. Incorporate upstream temporary Bash-output preparation, fallback, cancellation and retention fixes, plugin-read concurrency improvements and read-only workflow children; retain the existing history-list fix and Gian capability boundaries. Selected source regressions pass and artifacts are hosted-qualified; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.6) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.4.6/packages/proxies/zcode-proxy/README.md)

## 0.4.5

First published: 2026-10-20T01:35:37Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.5): 2026-10-20T01:35:37Z.
- CLI: 0.17.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Runtime to reviewed App-source 3.16.1 / CLI 0.17.0 at immutable commit 0a1fc56, retaining hash-bound standalone authentication and model catalog integration. Isolated database checks cover historical checksums, synthetic history preservation, table backup restore and re-upgrade; upstream restore retains additive schema, and unavailable backups produce a notice while migration continues. Fix native history listing by omitting includeArchived, removed from the strict 0.17.0 session/list schema. Correct native soft-delete capability explanations; Gian session close only detaches and never invokes native deletion. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.5) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.4.5/packages/proxies/zcode-proxy/README.md)

## 0.4.4

First published: 2026-10-15T02:24:58Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.4): 2026-10-15T02:24:58Z.
- CLI: 0.16.9 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Runtime to reviewed ZCode v3.15.1 source aac4755 (upstream CLI still reports 0.16.9), retaining standalone authentication and model catalog integration. Fix native MCP forms: free-text inputs, optional fields, indexed answers for repeated questions, and exact string preservation. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.4) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.4.4/packages/proxies/zcode-proxy/README.md)

## 0.4.2

First published: 2026-09-26T14:05:47Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.2): 2026-09-26T14:05:47Z.
- CLI: 0.16.9 (Manifest compatibility declaration, not local installation state).

### Changed

- Keep the pinned ZCode CLI 0.16.9 source and capabilities; shorten only the managed Runtime asset name so the official GitHub CDN redirect fits Gian 0.6.3 URL bounds. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.2) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.4.2/packages/proxies/zcode-proxy/README.md)

## 0.4.1

First published: 2026-09-26T12:21:03Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.1): 2026-09-26T12:21:03Z.
- CLI: 0.16.9 (Manifest compatibility declaration, not local installation state).

### Changed

- Build and manage ZCode CLI 0.16.9 from pinned upstream source, exposing the model catalog, file and image input, steer, fork, structured interactions, and native events. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.4.1) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.4.1/packages/proxies/zcode-proxy/README.md)

## 0.3.2

First published: 2026-09-20T09:48:30Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.3.2): 2026-09-20T09:48:30Z.
- CLI: 0.16.5 (Manifest compatibility declaration, not local installation state).

### Fixed

- Report explicit readiness diagnostics when built-in Provider configuration required for standalone startup is missing, rather than exposing only repeated exits. [Source 1](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.3.2/packages/proxies/zcode-proxy/src/runtime/discover.ts)

### Notes

- This does not fix ZCode.app 3.12.3 native-method or standalone Provider initialization problems, or guarantee restoration of missing models. [Source 1](https://github.com/RichLogic/Gian-Proxies/blob/proxy-zcode-v0.3.2/packages/proxies/zcode-proxy/src/runtime/discover.ts)
- Distributed from Gian-Proxies on 2026-09-20. This records a distribution source and artifact, not a separate Proxy version. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-zcode-v0.3.2)

## 0.3.1

First published: 2026-09-17T00:57:02Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.3.1): 2026-09-17T00:57:02Z.
- CLI: 0.16.5 (Manifest compatibility declaration, not local installation state).

### Changed

- Restore official Z.ai branding and synchronize asset digests; the external Runtime still requires the corresponding App build. [Source 1](https://github.com/RichLogic/Gian/commit/9683495bfcc8980a3b48886b88d30e24b5f0df9e)

## 0.3.0

First published: 2026-09-16T03:41:28Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.3.0): 2026-09-16T03:41:28Z.
- CLI: 0.16.5 (Manifest compatibility declaration, not local installation state).

### Added

- Provide Proxy-owned runtime.install.plan v1, shipping the managed Runtime installation recipe with the Proxy. [Source 1](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.1.2

First published: 2026-09-15T06:07:43Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.2): 2026-09-15T06:07:43Z.
- CLI: 0.16.5 (Manifest compatibility declaration, not local installation state).

### Changed

- Publish a new patch identity for managed installation without overwriting existing immutable artifacts. [Source 1](https://github.com/RichLogic/Gian/commit/45b222b7ae789b1f92ae6424090a8b6bd11b6545)

## 0.1.1

First published: 2026-09-13T09:32:18Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.1): 2026-09-13T09:32:18Z.
- CLI: 0.16.5 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.1 <3.0 to >=2.2 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.0/gian-proxy-zcode-0.1.0-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.1/gian-proxy-zcode-0.1.1-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 3 to Schema 4. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.0/gian-proxy-zcode-0.1.0-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-zcode-v0.1.1/gian-proxy-zcode-0.1.1-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.1.0

First published: 2026-09-01T07:22:19Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.0): 2026-09-01T07:22:19Z.
- CLI: 0.16.5 (Manifest compatibility declaration, not local installation state).

### Added

- The first independent Proxy release in the retained public records. [Source 1](https://github.com/RichLogic/Gian/releases/tag/proxy-zcode-v0.1.0)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## Withdrawn versions

- 0.4.0: withdrawn on 2026-09-20; not installable. [Source](https://github.com/RichLogic/Gian-Proxies/blob/51dc9e3ac2aa8a1430abf353b898de2e0df6f1d2/CHANGELOG.md)
