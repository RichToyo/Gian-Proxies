# Codex: Version history

Generated from the structured changelog, newest Proxy version first. Original publication and later repository distributions are recorded separately; missing historical details are not invented.

Release combination snapshot: Proxy **0.3.8**, Runtime **0.164.0**. These are distribution targets, not this machine's installed state.

## 0.3.8

First published: 2026-10-23T19:02:29Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-codex-v0.3.8): 2026-10-23T19:02:29Z.
- CLI: 0.164.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Codex CLI to official stable 0.164.0, matching the GitHub release asset digest. Exact old/new app-server schema comparison: ServerRequest byte-identical, Proxy-used methods unchanged, and imageGeneration output now allows a durable fileId instead of a required inline result (plus optional inputImages); a new fixture regression projects both shapes. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-codex-v0.3.8) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-codex-v0.3.8/packages/proxies/codex-proxy/README.md)

## 0.3.7

First published: 2026-10-21T12:23:19Z (UTC).

- [RichToyo/Gian-Proxies distribution](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-codex-v0.3.7): 2026-10-21T12:23:19Z.
- CLI: 0.163.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Publish an English-only Codex Proxy from RichToyo, including the managed gian-session Skill. Retain Codex CLI 0.163.0 and the existing wire protocol. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed. [Source 1](https://github.com/RichToyo/Gian-Proxies/releases/tag/proxy-codex-v0.3.7) [Source 2](https://github.com/RichToyo/Gian-Proxies/blob/proxy-codex-v0.3.7/packages/proxies/codex-proxy/README.md)

## 0.3.6

First published: 2026-10-16T18:19:57Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.6): 2026-10-16T18:19:57Z.
- CLI: 0.163.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Codex CLI to 0.163.0 (first stable of the 0.163 line, published 2026-10-15; matching the official rust-v0.163.0 GitHub asset digest). Exact old/new app-server schema comparison shows additive-only changes across every Proxy-used protocol surface (optional fields, new read-state notifications), a byte-identical ServerRequest, and no removed or changed method the Proxy calls (unrelated realtime voice enums also changed; the Proxy does not use them); no-credential initialize handshakes are identical on 0.162.1 and 0.163.0. The wire contract is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.6) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-codex-v0.3.6/packages/proxies/codex-proxy/README.md)

## 0.3.5

First published: 2026-10-15T10:55:23Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.5): 2026-10-15T10:55:23Z.
- CLI: 0.162.1 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Codex CLI to 0.162.1 (matching the official rust-v0.162.1 GitHub asset digest). Upstream 0.162.x changes are additive for the app-server surface; the adapter and the gian.proxy wire contract are unchanged. Artifacts pass hosted qualification; real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.5) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-codex-v0.3.5/packages/proxies/codex-proxy/README.md)

## 0.3.4

First published: 2026-10-11T05:51:31Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.4): 2026-10-11T05:51:31Z.
- CLI: 0.161.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Codex CLI to 0.161.0; long native histories page through disk with stable Fork ancestry and event identity, and the Proxy reports its real package version to the Runtime. The app-server bridge and gian.proxy wire contract are unchanged. Real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.4) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-codex-v0.3.4/packages/proxies/codex-proxy/README.md)

## 0.3.3

First published: 2026-09-30T07:54:56Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.3): 2026-09-30T07:54:56Z.
- CLI: 0.159.2 (Manifest compatibility declaration, not local installation state).

### Changed

- Update the managed Codex CLI to 0.159.2 without changing the Proxy app-server bridge or gian.proxy wire contract. Real model turns were not run for this release. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.3) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/proxy-codex-v0.3.3/packages/proxies/codex-proxy/README.md)

## 0.3.2

First published: 2026-09-24T09:39:25Z (UTC).

- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.2): 2026-09-24T09:39:25Z.
- CLI: 0.156.1 (Manifest compatibility declaration, not local installation state).

### Fixed

- Support Codex CLI 0.156.1 history and Fork formats, clean up Runtime descendants, and close isolated translation threads without reading ephemeral history. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.2) [Source 2](https://github.com/RichLogic/Gian-Proxies/blob/4740fab7dc3370cc812984519b5e9509bbcad2c0/CHANGELOG.md)

## 0.3.1

First published: 2026-09-17T00:56:25Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.3.1): 2026-09-17T00:56:25Z.
- CLI: 0.153.4 (Manifest compatibility declaration, not local installation state).
- [RichLogic/Gian-Proxies distribution](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.1): 2026-09-20T09:48:19Z.
- CLI: 0.153.4 (Manifest compatibility declaration, not local installation state).

### Changed

- Align version identities in the Proxy package, Manifest and embedded self-test; the CLI compatibility declaration remains 0.153.4. [Source 1](https://github.com/RichLogic/Gian/commit/c9b037a72c881eefa2ec2474a2591b1c142de563)

### Notes

- Distributed from Gian-Proxies on 2026-09-20. This records a distribution source and artifact, not a separate Proxy version. [Source 1](https://github.com/RichLogic/Gian-Proxies/releases/tag/proxy-codex-v0.3.1)

## 0.3.0

First published: 2026-09-16T03:41:37Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.3.0): 2026-09-16T03:41:37Z.
- CLI: 0.153.4 (Manifest compatibility declaration, not local installation state).

### Added

- Provide Proxy-owned runtime.install.plan v1, shipping the managed Runtime installation recipe with the Proxy. [Source 1](https://github.com/RichLogic/Gian/commit/593ca856393a48aaabfbcfa49657f28c268e57b1)

## 0.2.16

First published: 2026-09-14T03:54:07Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.16): 2026-09-14T03:54:07Z.
- CLI: 0.153.4 (Manifest compatibility declaration, not local installation state).

### Changed

- Declare and deliver Codex CLI 0.153.4 with support for the newer model catalog, replacing the previous 0.146.0 target. [Source 1](https://github.com/RichLogic/Gian/commit/a30d42a33d7665f2f809841a99d643a0459b63a1)

## 0.2.15

First published: 2026-09-13T09:22:54Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.15): 2026-09-13T09:22:54Z.
- CLI: 0.146.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.1 <3.0 to >=2.2 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.12/gian-proxy-codex-0.2.12-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.15/gian-proxy-codex-0.2.15-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 3 to Schema 4. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.12/gian-proxy-codex-0.2.12-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.15/gian-proxy-codex-0.2.15-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.12

First published: 2026-09-02T05:31:19Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.12): 2026-09-02T05:31:19Z.
- CLI: 0.146.0 (Manifest compatibility declaration, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.11

First published: 2026-09-01T07:21:48Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.11): 2026-09-01T07:21:48Z.
- CLI: 0.146.0 (Manifest compatibility declaration, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.10

First published: 2026-08-28T08:43:40Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.10): 2026-08-28T08:43:40Z.
- CLI: 0.146.0 (Manifest compatibility declaration, not local installation state).

### Changed

- Change the Manifest protocol range from >=2.0 <3.0 to >=2.1 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.3/gian-proxy-codex-0.2.3-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.10/gian-proxy-codex-0.2.10-darwin-arm64.tar.gz.manifest.json)
- Move the Manifest from Schema 2 to Schema 3. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.3/gian-proxy-codex-0.2.3-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.10/gian-proxy-codex-0.2.10-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.

## 0.2.3

First published: 2026-08-25T08:08:20Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.3): 2026-08-25T08:08:20Z.
- CLI: 0.146.0 (historical recommendation, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.2.1

First published: 2026-08-24T09:36:43Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.1): 2026-08-24T09:36:43Z.
- CLI: 0.146.0 (historical recommendation, not local installation state).

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.2.0

First published: 2026-08-23T04:13:01Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.2.0): 2026-08-23T04:13:01Z.
- CLI: 0.146.0 (historical recommendation, not local installation state).

### Changed

- Change the Manifest protocol range from >=1.0 <2.0 to >=2.0 <3.0. [Source 1](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.1.0/gian-proxy-codex-0.1.0-darwin-arm64.tar.gz.manifest.json) [Source 2](https://github.com/RichLogic/Gian/releases/download/proxy-codex-v0.2.0/gian-proxy-codex-0.2.0-darwin-arm64.tar.gz.manifest.json)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- This historical Runtime value comes from recommendedCliVersion. It is a recommendation, not certification of a complete combination.

## 0.1.0

First published: 2026-08-12T09:07:02Z (UTC).

- [RichLogic/Gian distribution](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.1.0): 2026-08-12T09:07:02Z.
- CLI: not recorded (CLI version not recorded, not local installation state).

### Added

- The first independent Proxy release in the retained public records. [Source 1](https://github.com/RichLogic/Gian/releases/tag/proxy-codex-v0.1.0)

### Historical evidence limits

- The original Release does not provide complete, independently attributable user-facing notes. Only confirmed distribution and Manifest facts are recorded; repository-wide comparisons are not presented as this Proxy's features or fixes.
- The public Manifest for this version does not record a CLI version. The current CLI version must not be attributed to it retrospectively.

## Withdrawn versions

- 0.4.0: withdrawn on 2026-09-20; not installable. [Source](https://github.com/RichLogic/Gian-Proxies/blob/51dc9e3ac2aa8a1430abf353b898de2e0df6f1d2/CHANGELOG.md)
