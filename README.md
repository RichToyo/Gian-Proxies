# Gian Proxies

Official independently released Gian Proxy packages and the signed Proxy Catalog.
Development is integrated in GianDev; this public repository is a reproducible
source export, not a copy of private Git history.

## Contents

- Seven independently versioned shipping Proxies: Claude, Codex, Kimi,
  Grok, DSH, ZCode and Antigravity.
- Release versions come from each Proxy package on GianDev main. Export does
  not assign a repository-wide version or automatically bump Proxy versions.
- DSH Proxy includes its exact Bridge rather than relying on an App-bundled copy.
- Catalog source, Markdown documentation, logos, compiler and signing workflows.
- Exact public `@gian/proxy-protocol` archive dependency from its verified
  publication repository. Existing pins stay on their published digests.
  New Proxy product publishes use RichToyo/Gian-Proxies.
- Shared support source and the production Runtime extractor snapshot. No Host,
  Web, Desktop or private protocol checkout is needed to build this product.

## Build and release

Use Node 24.14.0 and the pinned pnpm version. `pnpm install --frozen-lockfile` followed
by `pnpm build` builds the standalone product. No Provider credentials are needed.

`release-selection.json` explicitly selects the Proxies to build, qualify and
publish, plus the signed base Catalog repository and tag. The current pin is
`RichToyo/Gian-Proxies` at the already published `catalog-v1.43.0`.
Publication stays on `RichToyo/Gian-Proxies`. The base is verified against the
existing pinned key; its artifact URLs, digests and certificate stay as signed.
Unselected Proxies retain their complete immutable executable and certificate
coordinates. A subset release never rebuilds, retags or republishes an excluded
Proxy. The final Catalog must retain every base plugin and every excluded stable
tuple exactly. A new plugin may be added only when it is explicitly selected,
has complete Catalog source, and matches actual PASS-qualified artifacts and
shipping metadata. A failed or NOT_RUN qualification cannot admit an addition.
Update the selection in GianDev before exporting source.

This batch selects Kimi Proxy 0.4.14 with official Kimi Code CLI 2.3.3.
Plan updates retain distinct native tool-call identities when their content
returns to an earlier state, so subsequent output and completion remain
deliverable. All other Proxies keep their complete base tuples and are not
rebuilt or republished. The new archive must qualify before the next signed
Catalog can replace the Kimi tuple.

1. Dispatch **Qualify Proxy Artifacts** on main. The hosted macOS ARM64 workflow
   audits production dependencies, verifies source provenance, compiles, exercises Proxy contracts with fake
   Runtimes, verifies exact managed Runtime candidates with the production
   extractor, builds archives once and self-tests their extracted entry points.
2. Create each immutable `proxy-<releaseId>-v<version>` tag at that qualified
   public commit. Dispatch **Publish Certified Proxies** with its run ID. The
   publisher authenticates the run and rehashes the downloaded artifact; it does
   not rebuild. Existing releases must match byte-for-byte or publication fails.
3. Create `catalog-v1.<sequence>.0` at the intended main source commit. Dispatch
   **Publish Signed Catalog** with the qualification run, sequence and explicit
   issue time. It checks published assets, compiles the Catalog and verifies the
   signature with the pinned App public key before publication.

The Catalog-production environment requires the existing
`GIAN_CATALOG_SIGNING_KEY_PEM` Secret. Never regenerate the signing key, put it
in a repository or send it through chat. Proxy build jobs do not receive it.
The next Catalog sequence must exceed legacy sequence 6, the verified selected
base, and every published `catalog-v1.*` generation on both
`RichToyo/Gian-Proxies` and `RichLogic/Gian-Proxies`. Missing release metadata
fails closed. An empty new repository does not restart the sequence at 1.
Catalog consumers select `catalog-v1.*`; they must not use the repository's
generic latest release as a Proxy version. Proxy releases use `--latest=false`.

Certificates bind actual bytes and explicitly exclude App/Desktop acceptance,
Host/Web journeys and real Provider turns. Those are separate consumer checks,
not invented successful stages in this product's certificate. ZCode's managed
CLI is built from the full Git commit in its `src/runtime/source.json`, using
the pinned toolchain and frozen dependency lock. Its complete distribution and
source provenance are repacked as a Host-compatible archive. Qualification
checks the extracted entry, Provider resources and app-server catalog boundary;
an upstream protocol mismatch blocks publication even when `--version` works.
Published Runtime archives are copied from qualification, never rebuilt by
the publisher. Updating the source pin requires a new Proxy release.

ZCode Proxy 0.4.7 pins reviewed App-source 3.16.2 at 3c5b227, with CLI
0.17.0. Its versioned integration provides model metadata and standalone
authentication, and native MCP form answers retain free text, optional fields
and indexed identity. Proxy requests use complete model/reasoning selections.
The input source hash and resulting source digests are checked and recorded;
upstream changes require renewed review and exact hosted qualification.
Real-provider acceptance remains separate from artifact qualification.
Before Catalog publication, capture the newly published release/Manifest and
Runtime coordinate in `catalog/proxy-information/evidence/` and author its
history entry. Historical snapshots must not be filled with invented hashes.

## Updates

Claude Proxy 0.3.4 and its 0.3.5 creation/CLI follow-up have explicit
Owner-selected direct-publication exceptions:
dispatch qualification with `owner_no_tests=true`, then publish the exact
artifacts and dispatch Catalog publication with the same input. The receipt
records `status: NOT_RUN`; contracts, Runtime probes, archive self-tests and
documentation tests are skipped. This exception accepts only the single
Claude selection for these versions. It reuses the signed base Runtime or
hash-checks the pinned current official Claude CLI without executing it, and
retains provenance, artifact digests, immutable tags and Catalog signatures.
It does not claim successful qualification or authorize another version.

Change source in GianDev and export an integrated commit with
`node scripts/export-proxies.mjs --ref main --output <new-empty-directory>`.
The exporter uses the platform Ruby YAML parser to retain locked dependency
versions and writes standard YAML-compatible JSON. Never hand-edit generated
snapshot files in this repository or overwrite an existing immutable release.
Catalog publication that introduces executable changes requires fresh Proxy
qualification. A documentation-only refresh instead uses **Publish Catalog
Documentation** with an already published signed Catalog from its explicit base
repository: verify the pinned signature, recheck public artifact and certificate
digests, recompile English descriptions, tutorials and version histories, require
every complete stable/executable tuple to remain identical, and sign a higher
sequence. Legacy locale keys stay only for wire compatibility. This path cannot
add/remove a Proxy or change Runtime, Manifest, artifact or certificate
coordinates. It does not renew or rewrite the old certificate; the normal Proxy
publication freshness checks remain unchanged.

Author tutorials and structured history in `catalog/proxy-information/`. Catalog
publication validates that source and its certified Runtime snapshot, then
projects nine chapters into v1 setup/usage/troubleshooting and history Markdown
into overview in the temporary compilation input. The signed wire schema and
existing immutable Proxy coordinates stay unchanged. A dedicated App history
view is a separate consumer change; basic.md contains review examples, not
installed-state data. Publication runs the focused projection checks in CI.

Old Gian and Gian-Proxy-Catalog releases remain available during migration.
Publishing here does not change any installed App's trusted source or data.
