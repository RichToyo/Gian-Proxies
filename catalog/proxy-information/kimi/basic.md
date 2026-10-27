# Kimi Code: basic information review

The basic-information body is three fixed lines. The notes and status samples below are for review. They are not all shown as extra UI fields.

## Display order and source

| Order | Field | Where the value comes from |
| --- | --- | --- |
| 1 | Runtime path | The Host's current activation receipt. When it is not installed, the planned location returned by the Host |
| 2 | Runtime version | The checked version of the Runtime that is actually current. Do not fill in the latest version when there is no install or valid discovery |
| 3 | Proxy version | The active Proxy, or a source Proxy explicitly labeled as a development source. Otherwise show not installed |

The name and icon stay in the title. Install and update actions and progress come after the three lines. HOME belongs to the Agent. It is not part of Proxy Basic, and it does not enter the signed Catalog.

## Current release-target snapshot

The current certified release target is Proxy **0.4.13**, Runtime **2.3.2**. This is a publication target, not this machine's install state. Actual coordinates and certification evidence are in ../evidence/current-combinations.json. The version on a user's machine still comes from the Host receipt.

Example target location:

```text
<dataDir>/runtimes/kimi/2.3.1/<artifact-sha256>/kimi
```

`<dataDir>` comes from the running environment. `<artifact-sha256>` comes from the current signed combination. The UI should consume the Host install plan. The Web does not assemble the path itself. Full coordinates are in ../evidence/current-combinations.json.

## Status samples

| State | Runtime path | Runtime version | Proxy version | Action or note |
| --- | --- | --- | --- | --- |
| Nothing prepared | Install location: the planned location returned by the Host | Not installed | Not installed | Install the full integration |
| Source Proxy present, no Runtime | Install location: the planned location returned by the Host | Not installed | The Host's current source version, labeled as a development source | Source on disk is not an active certified combination |
| Prepared, user configuration unfinished | Path checked by the Host | Host's current value | Host's current value | Configuration and sign-in are a separate checkpoint. Do not report Ready |
| Update in progress | Keep the old active path | Keep the old current version | Keep the old current version | Target changes and progress appear in the action area |
| Verification failed | A known path may be used for diagnosis, but it is not marked executable | Do not pretend it is compatible | Current known value | State the failure. Do not overwrite current state with latest |

## Do not confuse these

- Kimi Code's Proxy version, Runtime version, and Gian App version are not the same number.
- The latest published version is not the installed version. An installed program is not a finished account or endpoint configuration.
- HOME isolation is not an operating-system sandbox. Choosing an existing HOME shares that vendor's state.

Sources: [contract](../CONTRACT.md), [current combination evidence](../evidence/current-combinations.json), [tutorial](tutorial.md).
