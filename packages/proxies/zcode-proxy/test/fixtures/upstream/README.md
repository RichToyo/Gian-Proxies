# Reviewed ZCode Test Fixture

This is an English test derivative of the ZCode protocol entrypoint at commit
`aac4755666d09fdcd70272fcf063c077a639015f` (App tag `v3.15.1`, CLI `0.16.9`).
Gian translated the comments and one Registry-ready diagnostic message.
No executable tokens other than that diagnostic string changed.

Source: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts

Upstream license: Apache-2.0, https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/LICENSE

`LICENSE` is unchanged. `NOTICE.md` is an explicitly labeled English
translation of the upstream notice; its references describe ZCode, not Gian.
`fixture-provenance.json` records the separate original and derivative hashes,
including the diagnostic-token translation reviewed against the pinned source.

The regression case checks these fixture hashes and tests the integration
overlay's routing and MCP edits against this derivative. It also verifies that
the strict production entrypoint function rejects the derivative.

Production Runtime builds do not read this fixture. They fetch the original
pinned upstream source, check the unchanged source-lock SHA-256, and only then
apply the integration overlay. The translated fixture hash must never replace
`packages/proxies/zcode-proxy/src/runtime/source.json`'s original entrypoint hash.
Production Runtime packaging still carries upstream's original license/notices.
