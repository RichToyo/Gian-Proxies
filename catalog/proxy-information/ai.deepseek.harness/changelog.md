# DeepSeek Harness: Version history

Generated from the structured changelog, newest Proxy version first. Original publication and later repository distributions are recorded separately; missing historical details are not invented.

Release combination snapshot: Proxy **0.3.10**, Runtime **0.2.1-rc.2**. These are distribution targets, not this machine's installed state.

## 0.3.10

First published: 2026-10-30T16:00:56Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.10): 2026-10-30T16:00:56Z.
- CLI: 0.2.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.9-Dev (source package corresponding to this archive).

### Changed

- Isolate the managed DSH profile and restore Agent presets. Use Proxy Protocol SDK 1.0.4 and the bundled Bridge 0.1.9-Dev with DeepSeek Harness 0.2.1-rc.2. Exact artifacts pass hosted qualification; real account, Provider and Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.10) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-dsh-v0.3.10/packages/proxies/dsh-proxy/README.md)

## 0.3.9

First published: 2026-10-27T13:44:00Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.9): 2026-10-27T13:44:00Z.
- CLI: 0.2.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.8 (source package corresponding to this archive).

### Changed

- Add official DeepSeek balance inspection and step-level usage identity for local Token statistics. Use Proxy Protocol SDK 1.0.4 and bundled Bridge 0.1.8; retain the dependency-repaired DeepSeek Harness 0.2.1-rc.2 Runtime. Exact artifacts pass hosted qualification; real account, Provider and Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.9) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-dsh-v0.3.9/packages/proxies/dsh-proxy/README.md)

## 0.3.8

First published: 2026-10-25T04:45:27Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.8): 2026-10-25T04:45:27Z.
- CLI: 0.2.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.7 (source package corresponding to this archive).

### Changed

- Republish the DeepSeek Harness Proxy at 0.3.8 with the shared security repair set: Proxy Protocol SDK 1.0.3 (zod exactly 4.6.6, wire unchanged) and a dependency-repaired managed Runtime whose lock resolves a single zod 4.6.7 and undici 8.12.2 (CLI stays 0.2.1-rc.2; the repaired bytes live under the new 0.3.8 tag, never overwriting 0.3.7). Bundled Bridge remains 0.1.7. Exact artifacts pass hosted qualification; real Provider turns are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.8) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-dsh-v0.3.8/packages/proxies/dsh-proxy/README.md)

## 0.3.7

First published: 2026-10-21T12:23:44Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.7): 2026-10-21T12:23:44Z.
- CLI: 0.2.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.7 (source package corresponding to this archive).

### Changed

- Publish an English-only DeepSeek Harness Proxy from RichToyo with the existing Bridge 0.1.7. Retain Runtime 0.2.1-rc.2 and the existing wire protocol. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-dsh-v0.3.7) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-dsh-v0.3.7/packages/proxies/dsh-proxy/README.md)

## 0.3.6

First published: 2026-10-20T01:01:21Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.6): 2026-10-20T01:01:21Z.
- CLI: 0.2.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.7 (source package corresponding to this archive).

### Changed

- Update the managed DeepSeek Harness to 0.2.1-rc.2 (now the npm latest dist-tag; upstream tag dsh-v0.2.1-rc.2). Exact npm package-payload comparison of the bridge-used surfaces: SESSION_FORMAT_VERSION stays 4 (no data migration), KNOWN_SESSION_EVENT_TYPES only gains job/registered, job/settled and working-directory/change (unknown durable events already project through the generic activity path), and cordis moves patch-only. The bundled Bridge moves to 0.1.7 (its peer range now explicitly admits both the 0.2.0 and 0.2.1 RC lines). Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.6) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-dsh-v0.3.6/packages/proxies/dsh-proxy/README.md)

## 0.3.5

First published: 2026-10-11T05:51:54Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.5): 2026-10-11T05:51:54Z.
- CLI: 0.2.0-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.6 (source package corresponding to this archive).

### Changed

- Support DeepSeek Harness 0.2.0-rc.2: session logs move to V4, a saved model that is no longer advertised falls back to the current default with a prompt to reselect, and Side Chat plus native session fork are now available. Bundled Bridge is 0.1.6. Real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.5) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-dsh-v0.3.5/packages/proxies/dsh-proxy/README.md)

## 0.3.3

First published: 2026-09-26T12:20:54Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.3): 2026-09-26T12:20:54Z.
- CLI: 0.1.5-rc.3 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.5 (source package corresponding to this archive).

### Changed

- Adapt the full DeepSeek Harness 0.1.5-rc.3 capability surface: file and image input, steer, fork, structured questions, and plan and diff events, with bundled Bridge 0.1.5. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.3) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-dsh-v0.3.3/packages/proxies/dsh-proxy/README.md)

## 0.3.2

First published: 2026-09-24T09:39:31Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.2): 2026-09-24T09:39:31Z.
- CLI: 0.1.5-rc.3 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.4 (source package corresponding to this archive).

### Fixed

- Support DeepSeek Harness 0.1.5-rc.3 with bundled Bridge 0.1.4, restore streaming text and reasoning, and keep handshake identity aligned with the released package. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.2) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/4740fab7dc3370cc812984519b5e9509bbcad2c0/CHANGELOG.md)

## 0.3.1

First published: 2026-09-17T00:57:06Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.3.1): 2026-09-17T00:57:06Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.3 (source package at this public tag).
- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.1): 2026-09-20T09:48:24Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.3 (source package corresponding to this archive).

### Changed

- Use deepseek-harness as the managed Runtime identifier with content-addressed directories. [Source 1](https://github.com/RichLogic/Gian/commit/9683495bfcc8980a3b48886b88d30e24b5f0df9e)
- Prepare and verify the gian profile before starting DSH; launch its JavaScript entry with Node. [Source 1](https://github.com/RichLogic/Gian-Proxies/blob/proxy-dsh-v0.3.1/packages/proxies/dsh-proxy/src/runtime/profile.ts)

### Notes

- The 2026-09-20 distribution from the new repository bundles Bridge 0.1.3 and prefers the bundled Bridge. This archive and the same version from the old repository have independent digests; identical bytes are not assumed. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-dsh-v0.3.1)

## 0.3.0

First published: 2026-09-16T03:41:20Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.3.0): 2026-09-16T03:41:20Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.3 (source package at this public tag).

### Added

- Provide Proxy-owned runtime.install.plan v1, shipping the managed Runtime installation recipe with the Proxy. [Source 1](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.1.7

First published: 2026-09-15T06:09:34Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.7): 2026-09-15T06:09:34Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.3 (source package at this public tag).

### Changed

- Publish a new patch identity for managed installation without overwriting existing immutable artifacts. [Source 1](https://github.com/RichLogic/Gian/commit/45b222b7ae789b1f92ae6424090a8b6bd11b6545)

## 0.1.6

First published: 2026-09-13T09:17:12Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.6): 2026-09-13T09:17:12Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.3 (source package at this public tag).

### Changed

- Change the Manifest protocol range from >=2.1 <3.0 to >=2.2 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.5/gian-proxy-dsh-0.1.5-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.6/gian-proxy-dsh-0.1.6-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 3 to Schema 4. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.5/gian-proxy-dsh-0.1.5-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.6/gian-proxy-dsh-0.1.6-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.1.5

First published: 2026-09-02T05:39:38Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.5): 2026-09-02T05:39:38Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.2 (source package at this public tag).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.1.4

First published: 2026-09-01T10:18:41Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.4): 2026-09-01T10:18:41Z.
- CLI: 0.1.1-rc.2 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.1 (source package at this public tag).

### Changed

- Update DSH Provider routing and declare Runtime 0.1.1-rc.2. [Source 1](https://github.com/RichLogic/Gian/commit/de9e3b6363968eea35b4969933aa91ec1db17c7d)

## 0.1.3

First published: 2026-08-28T08:43:41Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.3): 2026-08-28T08:43:41Z.
- CLI: 0.1.0-rc.7 (Manifest compatibility declaration, not local installation state). Bridge: 0.1.0 (source package at this public tag).

### Changed

- Change the Manifest protocol range from >=2.0 <3.0 to >=2.1 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.1/gian-proxy-dsh-0.1.1-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.3/gian-proxy-dsh-0.1.3-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 2 to Schema 3. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.1/gian-proxy-dsh-0.1.1-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-dsh-v0.1.3/gian-proxy-dsh-0.1.3-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.1.1

First published: 2026-08-24T09:36:37Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.1): 2026-08-24T09:36:37Z.
- CLI: 0.1.0-rc.7 (historical recommendation, not local installation state). Bridge: 0.1.0 (source package at this public tag).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.1.0

First published: 2026-08-23T04:04:31Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.0): 2026-08-23T04:04:31Z.
- CLI: 0.1.0-rc.7 (historical recommendation, not local installation state). Bridge: 0.1.0 (source package at this public tag).

### Added

- The first independent Proxy release in the retained public records. [Source 1](https://github.com/RichLogic/Gian/releases/tag/proxy-dsh-v0.1.0)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## Withdrawn versions

- 0.4.0: withdrawn on 2026-09-20; not installable. [Source](https://github.com/RichLogic/Gian-Proxies/blob/51dc9e3ac2aa8a1430abf353b898de2e0df6f1d2/CHANGELOG.md)
