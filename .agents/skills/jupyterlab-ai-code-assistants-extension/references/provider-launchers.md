# Claude Code on Kimi K3 or DeepSeek

Both providers expose an Anthropic-compatible endpoint. Token goes in environment, never on command line. Each launcher refuses to start without its token, so Claude Code never sends its own credentials to the provider.

Both launchers are plain `sh` wrappers. Save one in a directory on `PATH`, `chmod +x`, run it by name. The guard `: "${VAR:?message}"` stops startup when the token is missing.

## Kimi K3

- `ANTHROPIC_AUTH_TOKEN` - Moonshot API key; Kimi CLI reads same key as `KIMI_API_KEY`
- Endpoint: `https://api.moonshot.ai/anthropic`
- Model name: `kimi-k3[1m]`

Launcher, same shape as `claude-deepseek`:

```bash
#!/bin/sh
: "${KIMI_API_KEY:?KIMI_API_KEY is not set}"
export ANTHROPIC_AUTH_TOKEN="$KIMI_API_KEY"
export ANTHROPIC_BASE_URL='https://api.moonshot.ai/anthropic'
export ANTHROPIC_MODEL='kimi-k3[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='kimi-k3[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='kimi-k3[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='kimi-k3[1m]'
export ANTHROPIC_DEFAULT_FABLE_MODEL='kimi-k3[1m]'
export CLAUDE_CODE_SUBAGENT_MODEL='kimi-k3[1m]'
export CLAUDE_CODE_AUTO_COMPACT_WINDOW='1048576'
export CLAUDE_CODE_EFFORT_LEVEL='max'
export ENABLE_TOOL_SEARCH='true'
exec claude "$@"
```

## DeepSeek

- Save the wrapper below on `PATH` and run `claude-deepseek`
- Token variable: `DEEPSEEK_AUTH_TOKEN`
- Endpoint: `https://api.deepseek.com/anthropic`

Wrapper, same shape as the Kimi launcher:

```bash
#!/bin/sh
: "${DEEPSEEK_AUTH_TOKEN:?DEEPSEEK_AUTH_TOKEN is not set}"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_AUTH_TOKEN"
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export ANTHROPIC_MODEL='deepseek-flash[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-flash[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-flash[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='deepseek-flash'
export CLAUDE_CODE_SUBAGENT_MODEL='deepseek-flash'
export CLAUDE_CODE_EFFORT_LEVEL='max'
export CLAUDE_CODE_AUTO_COMPACT_WINDOW='786432'
exec claude "$@"
```

- No `ANTHROPIC_DEFAULT_FABLE_MODEL` and no `ENABLE_TOOL_SEARCH` in this wrapper
- `deepseek-flash[1m]` for main, Opus and Sonnet; `deepseek-flash` for Haiku and subagents
