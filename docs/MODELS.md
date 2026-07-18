# Model aliases (`/model` in Claude Code)

LiteLLM must be running (`./start-litellm.sh`).

## Daily drivers

| Usage | Command |
|-------|---------|
| Default (Ollama Cloud) | `/model minimax-m3` |
| Fast (Ollama) | `/model nemotron-30b` |
| Light (Ollama) | `/model gpt-oss-20b` |
| Free coder (OpenRouter) | `/model or-qwen-coder` |
| Premium coder (OpenRouter) | `/model or-kimi-k2.7-code` |
| Premium (OpenRouter) | `/model or-glm-5.2` |

## Ollama Cloud (needs `OLLAMA_API_KEY`)

| Alias | Backend |
|-------|---------|
| `minimax-m3` | `minimax-m3` |
| `minimax-m2.5` | `minimax-m2.5` |
| `gpt-oss-20b` | `gpt-oss:20b` |
| `nemotron-30b` | `nemotron-3-nano:30b` |
| `claude-ollama` | → `gpt-oss:20b` |
| `claude-ollama-fast` | → `nemotron-3-nano:30b` |

## OpenRouter free (`:free`, needs `OPENROUTER_API_KEY`)

| Alias | Backend |
|-------|---------|
| `or-qwen-coder` | `qwen/qwen3-coder:free` |
| `or-qwen` | `qwen/qwen3-next-80b-a3b-instruct:free` |
| `or-deepseek` | `tencent/hy3:free` |
| `or-gemini` | `google/gemma-4-31b-it:free` |
| `or-llama` | `meta-llama/llama-3.3-70b-instruct:free` |

Free models can be rate-limited. Prefer Ollama Cloud for reliable coding.

## OpenRouter paid (coding)

| Alias | Backend |
|-------|---------|
| `or-kimi-k3` | `moonshotai/kimi-k3` |
| `or-kimi-k2.7-code` | `moonshotai/kimi-k2.7-code` |
| `or-kimi-k2.6` | `moonshotai/kimi-k2.6` |
| `or-glm-5.2` | `z-ai/glm-5.2` |
| `or-glm-4.7-flash` | `z-ai/glm-4.7-flash` |

## Claude-looking aliases

These names look like Anthropic models but route through LiteLLM:

```text
/model claude-3-5-sonnet-20241022   # → minimax-m3
/model claude-3-5-haiku-20241022    # → gpt-oss:20b
/model claude-minimax-m3
/model claude-or-qwen-coder
```
