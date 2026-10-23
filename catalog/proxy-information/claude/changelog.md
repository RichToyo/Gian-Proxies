# Claude Code: Version history

Generated from the structured changelog, newest Proxy version first. Original publication and later repository distributions are recorded separately; missing historical details are not invented.

Release combination snapshot: Proxy **0.3.13**, Runtime **2.1.309**. These are distribution targets, not this machine's installed state.

## 0.3.13

First published: 2026-10-23T19:02:22Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-claude-v0.3.13): 2026-10-23T19:02:22Z.
- CLI: 2.1.309 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to official 2.1.309 (GitHub latest v2.1.309 and npm latest; the vendor /stable pointer still reads 2.1.308 and is recorded as lagging, not as proof of prerelease). Match the official manifest SHA-256 and size and verify the nine selected startup flags. Retain MCP SDK 1.32.0 and bounded HTTP input. The 2.1.309 changelog review found no documented headless spawn/wire compatibility changes. Exact artifacts pass hosted qualification; authenticated Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-claude-v0.3.13) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-claude-v0.3.13/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.12

First published: 2026-10-23T11:48:05Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-claude-v0.3.12): 2026-10-23T11:48:05Z.
- CLI: 2.1.308 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to official 2.1.308, promoted to both latest and stable channels. Match the official manifest SHA-256 and size and verify the selected startup flags. Review the intervening headless, MCP, permission, model and lifecycle changelog changes. Retain MCP SDK 1.32.0 and bounded HTTP input. Exact artifacts pass hosted qualification; authenticated Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-claude-v0.3.12) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-claude-v0.3.12/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.11

First published: 2026-10-21T12:23:15Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-claude-v0.3.11): 2026-10-21T12:23:15Z.
- CLI: 2.1.304 (Manifest compatibility declaration, not local installation state).

### Changed

- Publish an English-only Claude Proxy from RichToyo with MCP SDK 1.32.0 and bounded HTTP input before SDK validation. Retain Claude Code Runtime 2.1.304 and the existing wire protocol. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-claude-v0.3.11) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-claude-v0.3.11/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.10

First published: 2026-10-21T04:53:36Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.10): 2026-10-21T04:53:36Z.
- CLI: 2.1.304 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to 2.1.304 (promoted to /latest and /stable, npm latest and GitHub latest; SHA-256 and size verified against the official manifest). No documented headless spawn/wire compatibility changes were found in the official 2.1.304 changelog; the nine selected startup flags the adapter spawns or parses were verified on the new binary. Authenticated wire/Provider turns are NOT_RUN. The wire protocol range is unchanged. Artifacts pass hosted qualification. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.10) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.10/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.9

First published: 2026-10-20T01:01:03Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.9): 2026-10-20T01:01:03Z.
- CLI: 2.1.303 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to 2.1.303 (promoted to /latest, npm latest and GitHub latest; SHA-256 and size verified against the official manifest). Upstream 2.1.303 is a bug-fix/reliability entry with no wire-protocol or spawn-surface changes; the nine selected startup flags the adapter spawns or parses were re-verified on the new binary. The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.9) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.9/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.8

First published: 2026-10-17T18:11:15Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.8): 2026-10-17T18:11:15Z.
- CLI: 2.1.302 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to 2.1.302 (promoted to /latest, npm latest and GitHub latest on 2026-10-16; SHA-256 and size verified against the official manifest). Upstream 2.1.302 has no wire-protocol or spawn-surface changes; every flag the adapter spawns or parses was re-verified on the new binary. The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.8) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.8/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.7

First published: 2026-10-16T18:19:53Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.7): 2026-10-16T18:19:53Z.
- CLI: 2.1.301 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to 2.1.301 (promoted to /latest, npm latest and GitHub latest on 2026-10-15; SHA-256 and size verified against the official manifest). Upstream 2.1.301 has no wire-protocol or spawn-surface changes; every flag the adapter spawns or parses was re-verified on the new binary. The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.7) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.7/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.6

First published: 2026-10-15T10:55:19Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.6): 2026-10-15T10:55:19Z.
- CLI: 2.1.300 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to 2.1.300 (SHA-256 and size verified against the official 2.1.300 manifest). The adapter is unchanged: 2.1.297–2.1.300 bring no wire-protocol or spawn-surface changes, and every flag the adapter spawns or parses is present on the new binary. The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.6) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.6/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

## 0.3.5

First published: 2026-10-11T16:22:19Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.5): 2026-10-11T16:22:19Z.
- CLI: 2.1.296 (Manifest compatibility declaration, not local installation state).

### Changed

- Fix session-creation effort resolution: apply the default model before checking conditions, omit disabled effort defaults and retain model-specific choices on the live connection. Update the managed Claude Code Runtime to 2.1.296. The wire protocol range is unchanged. Owner-selected direct publication: all tests, Runtime probes and archive self-tests were not run. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.5) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.5/packages/proxies/cc-proxy/src/protocol/v2-adapter.ts)

### Historical evidence limits

- All tests, Runtime probes and archive self-tests are NOT_RUN by Owner instruction.

## 0.3.4

First published: 2026-10-11T15:03:28Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.4): 2026-10-11T15:03:28Z.
- CLI: 2.1.285 (Manifest compatibility declaration, not local installation state).

### Changed

- Read the native Claude /model catalog and each model's effort levels through an initialize-only control handshake. A configured default no longer hides other choices; preserve existing configuration ids and gateway menu priority, and clean up discovery on timeout or shutdown. Claude Code Runtime 2.1.285 and the wire protocol range are unchanged. Owner-selected direct publication: all tests, Runtime probes and archive self-tests were not run. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.4) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.4/packages/proxies/cc-proxy/src/runtime/native-model-catalog.ts)

### Historical evidence limits

- The Owner explicitly requested publication without tests, Runtime probes or archive self-tests.

## 0.3.3

First published: 2026-10-11T05:51:28Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.3): 2026-10-11T05:51:28Z.
- CLI: 2.1.285 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Claude Code Runtime to 2.1.285; keep and resume the Claude session across interrupts, fail an active turn honestly with the exit code and signal on CLI exit, and discover the model catalog from the wrapper HOME and settings. The wire protocol range is unchanged. Real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.3) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-claude-v0.3.3/packages/proxies/claude-proxy/README.md)

## 0.3.2

First published: 2026-09-24T09:39:21Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.2): 2026-09-24T09:39:21Z.
- CLI: 2.1.280 (Manifest compatibility declaration, not local installation state).

### Fixed

- Support Claude Code 2.1.280, preserve inherited Fork turn identities, and make Side Chat resume idempotent. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.2) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/4740fab7dc3370cc812984519b5e9509bbcad2c0/CHANGELOG.md)

## 0.3.1

First published: 2026-09-17T00:56:19Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.3.1): 2026-09-17T00:56:19Z.
- CLI: 2.1.159 (Manifest compatibility declaration, not local installation state).
- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.1): 2026-09-20T09:48:17Z.
- CLI: 2.1.159 (Manifest compatibility declaration, not local installation state).

### Changed

- Align version identities in the Proxy package, Manifest and embedded self-test; the CLI compatibility declaration remains 2.1.159. [Source 1](https://github.com/RichLogic/Gian/commit/c9b037a72c881eefa2ec2474a2591b1c142de563)

### Notes

- Distributed from Gian-Proxies on 2026-09-20. This records a distribution source and artifact, not a separate Proxy version. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-claude-v0.3.1)

## 0.3.0

First published: 2026-09-16T03:41:14Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.3.0): 2026-09-16T03:41:14Z.
- CLI: 2.1.159 (Manifest compatibility declaration, not local installation state).

### Added

- Provide Proxy-owned runtime.install.plan v1, shipping the managed Runtime installation recipe with the Proxy. [Source 1](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.2.5

First published: 2026-09-15T06:09:32Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.5): 2026-09-15T06:09:32Z.
- CLI: 2.1.159 (Manifest compatibility declaration, not local installation state).

### Changed

- Publish a new patch identity for managed installation without overwriting existing immutable artifacts. [Source 1](https://github.com/RichLogic/Gian/commit/45b222b7ae789b1f92ae6424090a8b6bd11b6545)

## 0.2.4

First published: 2026-09-13T09:17:22Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.4): 2026-09-13T09:17:22Z.
- CLI: 2.1.159 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.1 <3.0 to >=2.2 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 3 to Schema 4. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.3

First published: 2026-08-28T08:43:43Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.3): 2026-08-28T08:43:43Z.
- CLI: 2.1.159 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.0 <3.0 to >=2.1 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.2/gian-proxy-claude-0.2.2-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 2 to Schema 3. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.2/gian-proxy-claude-0.2.2-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.3/gian-proxy-claude-0.2.3-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.2

First published: 2026-08-25T08:08:22Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.2): 2026-08-25T08:08:22Z.
- CLI: 2.1.159 (historical recommendation, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.2.0

First published: 2026-08-23T04:13:08Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.2.0): 2026-08-23T04:13:08Z.
- CLI: 2.1.159 (historical recommendation, not local installation state).

### Changed

- Change the Manifest protocol range from >=1.0 <2.0 to >=2.0 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.1.1/gian-proxy-claude-0.1.1-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.0/gian-proxy-claude-0.2.0-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.1.1

First published: 2026-08-14T14:12:59Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.1.1): 2026-08-14T14:12:59Z.
- CLI: 2.1.159 (historical recommendation, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.1.0

First published: 2026-08-12T09:07:19Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.1.0): 2026-08-12T09:07:19Z.
- CLI: not recorded (CLI version not recorded, not local installation state).

### Added

- The first independent Proxy release in the retained public records. [Source 1](https://github.com/RichLogic/Gian/releases/tag/proxy-claude-v0.1.0)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- The public Manifest for this version does not record a CLI version. The current CLI version must not be attributed to it retrospectively.

## Withdrawn versions

- 0.4.0: withdrawn on 2026-09-20; not installable. [Source](https://github.com/RichLogic/Gian-Proxies/blob/51dc9e3ac2aa8a1430abf353b898de2e0df6f1d2/CHANGELOG.md)
