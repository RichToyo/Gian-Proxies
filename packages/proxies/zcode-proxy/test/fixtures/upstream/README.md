# Reviewed ZCode Test Fixtures

The English protocol-entrypoint derivative was reviewed against commit
`aac4755666d09fdcd70272fcf063c077a639015f` (App tag v3.15.1, CLI 0.16.9).
Only comments and one Registry-ready diagnostic string were translated.
Its original entrypoint SHA-256 is identical to the entrypoint pinned by the
current App-source 3.16.2 / CLI 0.17.0 Runtime at
`3c5b227649371507ddc4eb46ac5133afe6db1cab`.

Original derivative source:
https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts

`LICENSE` is unchanged. `NOTICE.md` is the explicitly labeled English
translation of that fixture origin's notice, describing ZCode rather than Gian.
`fixture-provenance.json` records original/derivative hashes and the separately
reviewed Runtime commits that pin the same original entrypoint bytes.

Tests exercise the integration overlay on the derivative and ensure the strict
production integrator rejects its translated bytes. Production builds fetch
their own original pinned upstream checkout and original notices; the fixture
hash must never replace the production source lock.

`zcode-session-list-params.ts.txt` is the unmodified list-parameter declaration
from commit `3c5b227649371507ddc4eb46ac5133afe6db1cab` at
`packages/shared/src/zcode-protocol/index.ts`. The strict object removes
`includeArchived`; fake-Runtime and native-history regressions cover that change.
