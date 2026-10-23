# Kimi Code: Version history

Generated from the structured changelog, newest Proxy version first. Original publication and later repository distributions are recorded separately; missing historical details are not invented.

Release combination snapshot: Proxy **0.4.9**, Runtime **2.3.0**. These are distribution targets, not this machine's installed state.

## 0.4.9

First published: 2026-10-23T11:48:09Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-kimi-v0.4.9): 2026-10-23T11:48:09Z.
- CLI: 2.3.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Kimi Code Runtime to official 2.3.0. Compare native OpenAPI and AsyncAPI surfaces against 2.2.0: existing methods and message types remain, with optional fields, new endpoints and session concurrency errors. Preserve native 40931 as SESSION_BUSY and 40932 as CONFLICT without automatic retry. Read the observed KIMI_CODE_HOME/server.token path without relying on a startup banner. Exact artifacts pass hosted qualification; real Provider turns are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-kimi-v0.4.9) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-kimi-v0.4.9/packages/proxies/kimi-proxy/README.md)

## 0.4.8

First published: 2026-10-21T12:23:22Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-kimi-v0.4.8): 2026-10-21T12:23:22Z.
- CLI: 2.2.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Publish an English-only Kimi Proxy from RichToyo. Retain Kimi Code Runtime 2.2.0 and the existing wire protocol. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-kimi-v0.4.8) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-kimi-v0.4.8/packages/proxies/kimi-proxy/README.md)

## 0.4.7

First published: 2026-10-15T10:55:26Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.7): 2026-10-15T10:55:26Z.
- CLI: 2.2.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the Kimi Code Runtime to 2.2.0 (matching the official @moonshot-ai/kimi-code@2.2.0 GitHub asset digest). The published server-api reference diff from 2.1.1 to 2.2.0 is purely additive (Remote Control endpoints, optional fields), and a live 2.2.0 /openapi.json + /asyncapi.json probe confirmed every REST route and WebSocket message type this Proxy uses. The adapter and the wire protocol range are unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.7) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.7/packages/proxies/kimi-proxy/README.md)

## 0.4.6

First published: 2026-10-11T05:51:34Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.6): 2026-10-11T05:51:34Z.
- CLI: 2.1.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Preserve and resume turns across Runtime disconnects: notification counters reset on a new stream binding and events resume from durable cursors, and only a child process exit is treated as runtime-down. Confirmation prompts explicitly declare the action that may omit answers. The standalone package uses public Proxy Protocol SDK 1.0.2; the wire protocol range and Kimi Code Runtime 2.1.1 remain unchanged. Real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.6) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.6/packages/proxies/kimi-proxy/README.md)

## 0.4.5

First published: 2026-10-07T07:19:00Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.5): 2026-10-07T07:19:00Z.
- CLI: 2.1.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Fix native cold-child Side Chat subscription and terminal handling, continuation after Stop, and tool/file-diff projection. Native Question cancellation explicitly declares the actions that may omit answers. The standalone package uses public Proxy Protocol SDK 1.0.2; the wire protocol range and Kimi Code Runtime 2.1.1 remain unchanged. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.5) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.5/packages/proxies/kimi-proxy/README.md)

## 0.4.4

First published: 2026-09-30T08:50:47Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.4): 2026-09-30T08:50:47Z.
- CLI: 2.1.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Project assistant text and thinking separately for each native step, preserve command, file and search tool-result presentation, and fix volatile frames that reuse the durable sequence and usage event identities. Idle sessions after a completed turn support fork and side chat; forking at a specific turn remains unavailable. The Proxy wire protocol and Kimi Code 2.1.1 Runtime pin are unchanged. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.4) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.4/packages/proxies/kimi-proxy/README.md)

## 0.4.3

First published: 2026-09-28T15:28:15Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.3): 2026-09-28T15:28:15Z.
- CLI: 2.1.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Keep previously returned Catalog revisions valid while the Kimi model catalog is unchanged, so switching models can refresh the available reasoning efforts without rejecting a still-valid revision. A changed model catalog requires a new catalog.list. This release does not change the Proxy wire protocol or the Kimi Code 2.1.1 Runtime pin. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.3) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.3/packages/proxies/kimi-proxy/README.md)

## 0.4.2

First published: 2026-09-27T03:23:17Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.2): 2026-09-27T03:23:17Z.
- CLI: 2.1.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Re-issued at 0.4.2: the capability surface is identical to 0.4.1 (Kimi Code 2.1.1 local Server API); version identifiers only, no functional changes. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.2) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.2/packages/proxies/kimi-proxy/README.md)

## 0.4.1

First published: 2026-09-26T12:48:07Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.1): 2026-09-26T12:48:07Z.
- CLI: 2.1.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Use the Kimi Code 2.1.1 local Server API for native session management, steer, structured interactions, and plan and diff events, retiring the ACP child. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.4.1) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.4.1/packages/proxies/kimi-proxy/README.md)

## 0.3.3

First published: 2026-09-24T09:39:35Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.3): 2026-09-24T09:39:35Z.
- CLI: 2.1.0 (Manifest compatibility declaration, not local installation state).

### Fixed

- Support Kimi Code 2.1.0, correct model-dependent thinking choices and replay turn identities, and stop advertising unsupported native rename. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.3) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/4740fab7dc3370cc812984519b5e9509bbcad2c0/CHANGELOG.md)

## 0.3.2

First published: 2026-09-20T09:48:27Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.2): 2026-09-20T09:48:27Z.
- CLI: 0.41.0, 2.0.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Stop rejecting sessions solely on the old session-store minimum version. Restoration failures remain diagnosable; compatibility with all older history is not claimed. [Source 1](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.3.2/packages/proxies/kimi-proxy/src/runtime/session-store.ts)

### Fixed

- Bound waiting for Session-level ACP requests and handle invalid native attach bindings. [Source 1](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.3.2/packages/proxies/kimi-proxy/src/runtime/kimi-acp-client.ts)
- Do not carry the legacy role field into new Turn configuration options. [Source 1](https://github.com/RichLogic/Gian-Proxies/blob/proxy-kimi-v0.3.2/packages/proxies/kimi-proxy/src/protocol/v2-adapter.ts)

### Notes

- The Manifest declares 0.41.0 and 2.0.0; Catalog 1.7.0 selects 2.0.0. Compatibility declarations do not describe the currently installed version. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/catalog-v1.7.0)
- Distributed from Gian-Proxies on 2026-09-20. This records a distribution source and artifact, not a separate Proxy version. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-kimi-v0.3.2)

## 0.3.1

First published: 2026-09-17T00:56:47Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.3.1): 2026-09-17T00:56:47Z.
- CLI: 0.41.0 (Manifest compatibility declaration, not local installation state).

### Fixed

- Correct CLI 0.41 usage reading and context accounting without relying solely on legacy /status text. [Source 1](https://github.com/RichLogic/Gian/commit/9683495bfcc8980a3b48886b88d30e24b5f0df9e)

## 0.3.0

First published: 2026-09-16T03:41:22Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.3.0): 2026-09-16T03:41:22Z.
- CLI: 0.41.0 (Manifest compatibility declaration, not local installation state).

### Added

- Provide Proxy-owned runtime.install.plan v1, shipping the managed Runtime installation recipe with the Proxy. [Source 1](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.2.10

First published: 2026-09-13T09:24:28Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.10): 2026-09-13T09:24:28Z.
- CLI: 0.41.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.1 <3.0 to >=2.2 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.7/gian-proxy-kimi-0.2.7-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.10/gian-proxy-kimi-0.2.10-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 3 to Schema 4. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.7/gian-proxy-kimi-0.2.7-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.10/gian-proxy-kimi-0.2.10-darwin-arm64.tar.gz.manifest.json)

### Fixed

- Drain remaining output after terminal exit so trailing content is not lost. [Source 1](https://github.com/RichLogic/Gian/commit/2e76e40342846c977c23bae74246ee4bba78a37c)

## 0.2.7

First published: 2026-09-02T05:32:33Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.7): 2026-09-02T05:32:33Z.
- CLI: 0.38.0 (Manifest compatibility declaration, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.6

First published: 2026-09-01T07:22:30Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.6): 2026-09-01T07:22:30Z.
- CLI: 0.38.0 (Manifest compatibility declaration, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.3

First published: 2026-08-28T08:43:44Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.3): 2026-08-28T08:43:44Z.
- CLI: 0.31.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.0 <3.0 to >=2.1 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.2/gian-proxy-kimi-0.2.2-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.3/gian-proxy-kimi-0.2.3-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 2 to Schema 3. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.2/gian-proxy-kimi-0.2.2-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.3/gian-proxy-kimi-0.2.3-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.2

First published: 2026-08-25T08:08:32Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.2): 2026-08-25T08:08:32Z.
- CLI: 0.31.1 (historical recommendation, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.2.1

First published: 2026-08-24T09:36:37Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.1): 2026-08-24T09:36:37Z.
- CLI: 0.31.1 (historical recommendation, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.2.0

First published: 2026-08-23T04:12:30Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.2.0): 2026-08-23T04:12:30Z.
- CLI: 0.31.1 (historical recommendation, not local installation state).

### Changed

- Change the Manifest protocol range from >=1.0 <2.0 to >=2.0 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.1.0/gian-proxy-kimi-0.1.0-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-kimi-v0.2.0/gian-proxy-kimi-0.2.0-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.1.0

First published: 2026-08-12T09:07:10Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.1.0): 2026-08-12T09:07:10Z.
- CLI: not recorded (CLI version not recorded, not local installation state).

### Added

- The first independent Proxy release in the retained public records. [Source 1](https://github.com/RichLogic/Gian/releases/tag/proxy-kimi-v0.1.0)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- The public Manifest for this version does not record a CLI version. The current CLI version must not be attributed to it retrospectively.

## Withdrawn versions

- 0.4.0: withdrawn on 2026-09-20; not installable. [Source](https://github.com/RichLogic/Gian-Proxies/blob/51dc9e3ac2aa8a1430abf353b898de2e0df6f1d2/CHANGELOG.md)
