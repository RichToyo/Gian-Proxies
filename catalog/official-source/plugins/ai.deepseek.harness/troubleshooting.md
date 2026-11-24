# Troubleshooting

If the Agent cannot start, read the error: it ends with DSH's own stderr. If sessions report that a credential is required, add the Provider key to the Agent HOME's `.credentials.yaml`; settings saved in DSH Web's `web` profile are not used by Gian.
