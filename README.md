# claude-code-llm

Run **Claude Code CLI** against **Ollama Cloud** and **OpenRouter** via a local **LiteLLM** Anthropic-compatible gateway.

```
Claude Code  →  LiteLLM :4000  →  Ollama Cloud (ollama.com)
                              └→  OpenRouter (openrouter.ai)

Optional:     claude-bridge :4100  (HTTP inject + SSE for automation / web UIs)
```

## Requirements

- Linux (or macOS)
- Node.js 20+
- Python 3.10+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (installed locally by this repo via npm)
- API keys:
  - [Ollama Cloud](https://ollama.com/settings/keys)
  - [OpenRouter](https://openrouter.ai/keys) (for `or-*` models)

## Quick start

```bash
git clone https://github.com/xavdp-pro/claude-code-llm.git
cd claude-code-llm
./install.sh
# edit .env → OLLAMA_API_KEY / OPENROUTER_API_KEY
./start-litellm.sh
```

Wire any project so Claude Code uses the gateway:

```bash
./bin/use-in-project.sh /path/to/your/project
cd /path/to/your/project
claude
```

Inside Claude Code:

```text
/model minimax-m3
/model or-qwen-coder
/model or-kimi-k2.7-code
```

See [docs/MODELS.md](docs/MODELS.md) for the full alias list.

## Install options

```bash
./install.sh                 # venv + npm + .env
./install.sh --systemd       # also enable user services
./install.sh --systemd --no-bridge   # LiteLLM only
```

Manual start:

```bash
./start-litellm.sh           # gateway only (enough for Claude CLI)
./start-bridge.sh            # optional HTTP API on :4100
./start-all.sh               # both
```

## Use Claude Code without the HTTP bridge

You only need LiteLLM running. Project settings (written by `use-in-project.sh`) set:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`
- `ANTHROPIC_AUTH_TOKEN=sk-claude-bridge-local`
- default model aliases (`minimax-m3`, etc.)

Or export the same vars in your shell before `claude`.

### Native Ollama (no LiteLLM)

If you only want Ollama Cloud and your Ollama version speaks Anthropic:

```bash
export ANTHROPIC_BASE_URL=https://ollama.com
export ANTHROPIC_AUTH_TOKEN=<OLLAMA_API_KEY>
export ANTHROPIC_MODEL=gpt-oss:20b
claude
```

## Optional HTTP bridge

`server.mjs` exposes a small API to inject prompts and stream SSE events (thinking, tools, response) — useful for headless / web frontends.

```bash
TOKEN=$(cat ~/.config/claude-bridge/token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/api/status
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"conversation":"demo","message":"List files in the current directory"}' \
  http://127.0.0.1:4100/api/inject
```

## Environment

| Variable | Default | Role |
|----------|---------|------|
| `OLLAMA_API_KEY` | — | Ollama Cloud |
| `OPENROUTER_API_KEY` | — | OpenRouter (`or-*`) |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Points Claude Code at LiteLLM |
| `ANTHROPIC_MODEL` | `minimax-m3` | Default model alias |
| `LITELLM_PORT` | `4000` | Gateway port |
| `CLAUDE_BRIDGE_PORT` | `4100` | Optional bridge port |

## Security notes

- Do not commit `.env`.
- The bridge binds to `127.0.0.1` by default.
- Project template uses `bypassPermissions` for unattended coding — review before production use.

## License

MIT
