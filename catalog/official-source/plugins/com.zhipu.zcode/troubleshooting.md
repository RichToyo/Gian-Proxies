# Troubleshooting

- The Agent cannot start: the error shows the ZCode Runtime's own startup
  output. Reinstall the managed Runtime from the Catalog if files are
  missing; Gian does not accept a custom executable path for ZCode.
- Sign-in required: run `zcode login` (Z.ai or BigModel) under the Agent's
  HOME, or fix the API key of the selected Provider in
  `.zcode/v2/provider_config.json`, then retry.
- Keychain message: allow access to "ZCode Credential Encryption" when macOS
  asks, or unlock the login keychain, then retry.
- A turn shows a Provider error: the message is ZCode's own; the native
  error code stays in the details.
- Behind a proxy: start Gian with `HTTPS_PROXY`/`NO_PROXY` set. The Runtime
  inherits them, as well as `SHELL` and your `PATH`.
