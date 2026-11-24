# Setup

Install DeepSeek Harness from the Catalog; Gian installs the Proxy, its bundled Bridge and the managed DSH Runtime as one signed combination. You can instead point the saved Agent at an existing DSH binary of a version the Proxy admits.

Give the Agent's HOME a Provider credential: `DEEPSEEK_API_KEY` under `refs:` in `<HOME>/.credentials.yaml`, or another Provider route in `<HOME>/cordis.patch.yml` plus its key. Until then sessions report that a credential is required.
