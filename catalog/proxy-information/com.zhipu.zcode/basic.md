# ZCode: basic information review

The basic-information body is three fixed lines. The notes and status samples below are for review. They are not all shown as extra UI fields.

## Display order and source

| Order | Field | Where the value comes from |
| --- | --- | --- |
| 1 | Runtime path | The Host's external-app discovery and verification result |
| 2 | Runtime version | The checked version of the Runtime that is actually current. Do not fill in the latest version when there is no install or valid discovery |
| 3 | Proxy version | The active Proxy, or a source Proxy explicitly labeled as a development source. Otherwise show not installed |

The name and icon stay in the title. Install and update actions and progress come after the three lines. ZCode does not show a Gian-managed HOME or a Custom HOME control.

## Current release-target snapshot

This is the 2026-09-20 Catalog 1.7.0 target, not this machine's install state: Proxy **0.3.2**, Runtime **0.16.5**.

Example target location:

```text
The ZCode.app embedded entry actually discovered and verified by the Host
```

When the App is not detected, show "ZCode.app was not detected". Do not treat an example path as a verified path. CLI 0.16.5 by itself does not prove the current App build is compatible. See the known upstream limits in the tutorial.

## Status samples

| State | Runtime path | Runtime version | Proxy version | Action or note |
| --- | --- | --- | --- | --- |
| Nothing prepared | ZCode.app was not detected | Not detected | Not installed | Discover and prepare an existing App and Proxy. Do not promise to download the external App |
| Source Proxy present, no Runtime | The actual discovery result, or not detected | Not installed | 0.3.2, labeled as a development source | Source on disk is not an active certified combination |
| Prepared, user configuration unfinished | Path checked by the Host | Host's current value | Host's current value | Configuration and sign-in are a separate checkpoint. Do not report Ready |
| Update in progress | Keep the old active path | Keep the old current version | Keep the old current version | Target changes and progress appear in the action area |
| Verification failed | A known path may be used for diagnosis, but it is not marked executable | Do not pretend it is compatible | Current known value | State the failure. Do not overwrite current state with latest |

## Do not confuse these

- ZCode's Proxy version, Runtime version, and Gian App version are not the same number.
- The latest published version is not the installed version. An installed program is not a finished account or endpoint configuration.
- External App state is not a Gian-owned HOME. Several Agents do not mean several isolated accounts.

Sources: [contract](../CONTRACT.md), [current combination evidence](../evidence/current-combinations.json), [tutorial](tutorial.md).
