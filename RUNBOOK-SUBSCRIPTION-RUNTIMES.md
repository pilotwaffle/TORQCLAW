# Subscription ACP runtimes

Subscription agent execution is enabled when `TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED` is unset, empty, whitespace, or one of `1`, `true`, `yes`, `on`. It is disabled by `0`, `false`, `no`, `off`, and every malformed value.

The gateway owns commands, arguments, timeouts, environment, endpoints, and runtime fingerprints. The browser selects only catalog provider and model IDs. Consent is durable only for the exact provider, model, immutable runtime fingerprint, persona revision, and persona SHA-256. Profile, persona, or descriptor changes require new consent.

Approved servers:

- Grok: `grok agent --always-approve stdio`, exact ACP model `grok-build-0.1`. This is not tool-free. The operator accepts Grok vendor built-in tools and the vendor CLI/OS as trusted computing base.
- Kimi: `kimi acp`, exact ACP model `kimi-code/k3`.
- Qwen Max: `qwen --acp -m qwen3.8-max-preview`.
- DeepSeek via operator Qwen: `qwen --acp -m deepseek-v4-pro`, fixed 90-second timeout.
- Z.ai: `claude-agent-acp`, exact model `glm-5.3`, through the fixed `https://api.z.ai/api/anthropic` route. Set `GLM_API_KEY` only on the TORQClaw gateway process. The child receives it only as `ANTHROPIC_AUTH_TOKEN`; the base URL and Claude model aliases are fixed to Z.ai and `glm-5.3`. TORQClaw never reads or copies credentials from another project or shell configuration.

Metadata probes send only ACP initialization and metadata requests. They send no prompt, channel context, MCP servers, client tools, or credential-bearing protocol frames. The Z.ai process receives only its gateway-mapped token and fixed route/model environment; other gateway secrets remain excluded. Unknown, malformed, secret-bearing, and provider reverse-request frames fail closed.

Every turn rechecks STOP/cancellation, principal and membership authority, runtime binding, consent binding, persona binding, and exact model at admission, probe, spawn, session, pre-prompt, atomic commit, recovery, and receipt boundaries. Cancellation must confirm process-tree termination before a terminal result can claim the provider stopped.

Except for the gateway-only `GLM_API_KEY` mapping described above, subscription runtimes do not accept credentials or billing configuration through TORQClaw. Authenticate vendor CLIs outside TORQClaw, then use the readiness catalog.
