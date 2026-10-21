# ZCode: basic information review

The basic-information body is three fixed lines. The notes and status samples below are for review, not extra UI fields.

## Display order and source

| Order | Field | Where the value comes from |
| --- | --- | --- |
| 1 | Runtime path | The Host's managed Runtime installation record and verification result |
| 2 | Runtime version | The checked current Runtime version; never substitute latest when installation is unverified |
| 3 | Proxy version | The active Proxy, or a source Proxy explicitly labeled as a development source; otherwise not installed |

The name and icon stay in the title. Installation actions and progress follow the three lines. Verify Runtime files separately from account configuration.

## Current release-target snapshot

This is the 2026-10-21 Catalog 1.33.0 target, not this machine's install state: Proxy **0.4.6**, Runtime **0.17.0**.

Example target location:

```text
The verified zcode/agent/zcode.cjs recorded by Gian's installer
```

Without successful installation verification, show "Runtime not prepared". An example path is not a verified path. The Runtime is built from pinned source and shipped with the Proxy; matching versions do not prove account readiness or successful model requests.

## Status samples

| State | Runtime path | Runtime version | Proxy version | Action or note |
| --- | --- | --- | --- | --- |
| Nothing prepared | Runtime not prepared | Not detected | Not installed | Prepare the matching Proxy and managed Runtime through the signed Catalog |
| Source Proxy present, no Runtime | Actual discovery result or not detected | Not installed | 0.4.6, labeled as a development source | Source existence is not an active certified combination |
| Prepared, configuration unfinished | Host-verified path | Host's current value | Host's current value | Account configuration is separate; do not claim Ready |
| Updating | Keep the old active path | Keep the old current version | Keep the old current version | Show target and progress separately |
| Verification failed | Known path for diagnosis only, not marked executable | Do not claim compatibility | Current known value | Report the failure; never replace current state with latest |

## Do not confuse these

- Proxy, Runtime and Gian App versions are independent.
- Latest published does not mean installed; installation does not prove account or endpoint readiness.
- Multiple Agents do not imply isolated accounts.

Sources: [contract](../CONTRACT.md), [current combination evidence](../evidence/current-combinations.json), [tutorial](tutorial.md).
