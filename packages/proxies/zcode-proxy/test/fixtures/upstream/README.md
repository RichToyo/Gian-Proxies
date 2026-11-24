# Reviewed ZCode Test Fixtures

The English protocol-entrypoint derivative was reviewed against commit
`fec975905a2abd4c07e35c40d51fa097a2258ec9` (App tag v3.18.2, CLI 0.17.1), the
entrypoint pinned by the current Runtime source lock. Only comments and one
Registry-ready diagnostic string were translated: a TypeScript scan finds 2839
code tokens in both files and exactly one changed token (that string).

Original derivative source:
https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts

`LICENSE` is unchanged. `NOTICE.md` is the explicitly labeled English
translation of that commit's notice, describing ZCode rather than Gian.
`fixture-provenance.json` records original/derivative hashes.

Tests exercise the integration overlay on the derivative and ensure the strict
production integrator rejects its translated bytes. Production builds fetch
their own original pinned upstream checkout and original notices; the fixture
hash must never replace the production source lock.

`zcode-session-list-params.ts.txt` is the unmodified list-parameter declaration
from commit `3c5b227649371507ddc4eb46ac5133afe6db1cab` (byte-identical at
`fec975905a2abd4c07e35c40d51fa097a2258ec9`) at
`packages/shared/src/zcode-protocol/index.ts`. The strict object removes
`includeArchived`; fake-Runtime and native-history regressions cover that change.
