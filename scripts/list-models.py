#!/usr/bin/env python3
"""Liste les modèles LiteLLM groupés par fournisseur (Anthropic / Ollama / OpenRouter)."""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "litellm-config.yaml"
LITELLM_URL = "http://127.0.0.1:4000"
LITELLM_KEY = "sk-claude-bridge-local"

FILTER = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()


def parse_config(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    blocks = re.split(r"\n\s*-\s*model_name:\s*", text)[1:]
    rows: list[dict] = []
    for block in blocks:
        name_m = re.match(r"([^\n]+)", block)
        if not name_m:
            continue
        name = name_m.group(1).strip()
        model_m = re.search(r"model:\s*(\S+)", block)
        base_m = re.search(r"api_base:\s*(\S+)", block)
        rows.append({
            "alias": name,
            "backend": model_m.group(1) if model_m else "?",
            "api_base": base_m.group(1) if base_m else "",
        })
    return rows


def provider(row: dict) -> str:
    backend = row["backend"]
    alias = row["alias"]
    if alias.startswith("claude-"):
        return "anthropic"
    if backend.startswith("openrouter/"):
        return "openrouter"
    if backend.startswith("ollama") or "ollama.com" in row["api_base"]:
        return "ollama"
    if backend.startswith("anthropic/"):
        return "anthropic"
    return "other"


def tier(row: dict) -> str:
    backend = row["backend"]
    if provider(row) != "openrouter":
        return ""
    if ":free" in backend or backend.endswith(":free"):
        return "gratuit"
    return "payant"


def backend_label(row: dict) -> str:
    b = row["backend"]
    if b.startswith("ollama_chat/"):
        return b.split("/", 1)[1]
    if b.startswith("openrouter/"):
        return b.split("/", 1)[1]
    return b


def litellm_live() -> tuple[bool, list[str]]:
    req = urllib.request.Request(
        f"{LITELLM_URL}/v1/models",
        headers={"Authorization": f"Bearer {LITELLM_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode())
        return True, sorted(m["id"] for m in data.get("data", []))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return False, []


def print_section(title: str, items: list[dict]) -> None:
    if not items:
        return
    print(f"\n=== {title} ===")
    for row in sorted(items, key=lambda r: r["alias"]):
        tag = tier(row)
        suffix = f"  [{tag}]" if tag else ""
        print(f"  /model {row['alias']:<28} →  {backend_label(row)}{suffix}")


def main() -> int:
    if not CONFIG.exists():
        print(f"Config introuvable: {CONFIG}", file=sys.stderr)
        return 1

    rows = parse_config(CONFIG)
    groups = {"anthropic": [], "ollama": [], "openrouter_free": [], "openrouter_paid": [], "other": []}

    for row in rows:
        p = provider(row)
        if p == "anthropic":
            groups["anthropic"].append(row)
        elif p == "ollama":
            groups["ollama"].append(row)
        elif p == "openrouter":
            (groups["openrouter_free"] if tier(row) == "gratuit" else groups["openrouter_paid"]).append(row)
        else:
            groups["other"].append(row)

    if FILTER:
        mapping = {
            "anthropic": ["anthropic"],
            "ollama": ["ollama"],
            "openrouter": ["openrouter_free", "openrouter_paid"],
            "or": ["openrouter_free", "openrouter_paid"],
        }
        keys = mapping.get(FILTER)
        if not keys:
            print(f"Filtre inconnu: {FILTER} (anthropic | ollama | openrouter)", file=sys.stderr)
            return 1
        for k in groups:
            if k not in keys:
                groups[k] = []

    live, live_ids = litellm_live()
    print("Modèles configurés (mds/claude-bridge/litellm-config.yaml)")
    if live:
        print(f"LiteLLM :4000 — OK ({len(live_ids)} alias actifs)")
    else:
        print("LiteLLM :4000 — OFF (lancer: cd mds/claude-bridge && ./start-litellm.sh)")

    print_section("ANTHROPIC (alias gateway — routés via LiteLLM)", groups["anthropic"])
    print_section("OLLAMA CLOUD (noms directs)", groups["ollama"])
    print_section("OPENROUTER — gratuit (:free)", groups["openrouter_free"])
    print_section("OPENROUTER — payant (Kimi / GLM)", groups["openrouter_paid"])
    print_section("AUTRES", groups["other"])

    print("\nChanger de modèle : /model <alias>")
    print("Exemples : /model minimax-m3   /model or-qwen-coder   /model claude-ollama")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
