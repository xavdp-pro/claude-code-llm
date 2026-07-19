#!/usr/bin/env node
/**
 * claude-bridge — pilotage HTTP + SSE de Claude Code en headless.
 *
 * Une conversation = une SESSION Claude Code (persistée via --session-id /
 * --resume). Chaque inject lance `claude -p --output-format stream-json` en
 * mode auto-approbation (--dangerously-skip-permissions) et streame les
 * événements de l'agent vers /api/events.
 *
 *   GET  /api/health
 *   GET  /api/status
 *   GET  /api/conversations            -> { registered: [...] }
 *   POST /api/inject { conversation, message }
 *   GET  /api/events                   -> SSE (inject, response, response_complete, tool, result)
 *   POST /api/conversations/delete { conversation }
 *
 * Auth : Bearer token (~/.config/claude-bridge/token, auto-créé).
 * Backend modèle : via env ANTHROPIC_BASE_URL (proxy LiteLLM -> Ollama).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Charge .env (clés API) si présent — n'écrase jamais l'environnement existant.
try {
  const envFile = path.join(path.dirname(new URL(import.meta.url).pathname), '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de .env */ }

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 4100);
const BIND = process.env.CLAUDE_BRIDGE_BIND || '127.0.0.1';
const CFG_DIR = path.join(os.homedir(), '.config/claude-bridge');
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(CFG_DIR, 'token');
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(CFG_DIR, 'sessions.json');
const WS_BASE = process.env.CLAUDE_WS_BASE || path.join(os.homedir(), 'Bureau/CLAUDE-WS');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'or-kimi-k3';
const AVAILABLE_MODELS = (process.env.CLAUDE_MODELS || 'or-kimi-k3|Kimi K3,minimax-m3|MiniMax M3,gpt-oss-20b|GPT-OSS 20B,nemotron-30b|Nemotron 30B,minimax-m2.5|MiniMax M2.5,or-qwen-coder|Qwen Coder,or-kimi-k2.7-code|Kimi K2.7 Code,or-glm-5.2|GLM 5.2')
  .split(',')
  .map((part) => {
    const [id, label] = part.split('|').map((s) => s.trim());
    return id ? { id, label: label || id } : null;
  })
  .filter(Boolean);

// Environnement NON-INTERACTIF : les commandes bash lancées par l'agent ne
// doivent jamais bloquer sur un [Y/n] ou un pager. Couvre apt, pip, npm, git,
// debconf, pagers, etc.
const NONINTERACTIVE_ENV = {
  DEBIAN_FRONTEND: 'noninteractive',
  DEBIAN_PRIORITY: 'critical',
  APT_CONFIG: process.env.APT_CONFIG || `${os.homedir()}/.config/noninteractive.apt.conf`,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  SYSTEMD_PAGER: 'cat',
  LESS: '-FRX',
  PIP_NO_INPUT: '1',
  PIP_EXISTS_ACTION: 'w',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  NPM_CONFIG_YES: 'true',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_AUDIT: 'false',
  COMPOSER_NO_INTERACTION: '1',
  PYTHONUNBUFFERED: '1',
  CI: '1',
  NONINTERACTIVE: '1',
};

// Environnement passé à Claude Code (backend Ollama via proxy LiteLLM).
const CLAUDE_ENV = {
  ...process.env,
  ...NONINTERACTIVE_ENV,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:4000',
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || 'sk-claude-bridge-local',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL || 'nemotron-30b',
  DISABLE_TELEMETRY: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_ERROR_REPORTING: '1',
};

fs.mkdirSync(CFG_DIR, { recursive: true });
fs.mkdirSync(WS_BASE, { recursive: true });

/** Claude Code writes $HOME/.claude/session-env — must exist and be writable (turbinobash). */
function ensureClaudeRuntimeDirs() {
  const home = process.env.HOME || os.homedir();
  for (const dir of [
    path.join(home, '.claude'),
    path.join(home, '.claude', 'session-env'),
    path.join(home, '.claude', 'sessions'),
    WS_BASE,
    CFG_DIR,
  ]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`[claude-bridge] cannot mkdir ${dir}:`, err.message);
    }
  }
}
ensureClaudeRuntimeDirs();

function token() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
    return t;
  }
}
const TOKEN = token();

function loadSessions() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (d && d.conversations) return d;
  } catch { /* absent */ }
  return { conversations: {} };
}
function saveSessions(d) {
  const tmp = `${SESSIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_FILE);
}
function normalizeName(n) {
  return String(n || '').trim();
}
function safeDir(n) {
  return normalizeName(n).replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

// ---- bus SSE ----
const clients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { /* client parti */ }
  }
}

// ---- crédits OpenRouter (poll toutes les 15 s, broadcast SSE) ----
const CREDITS_POLL_MS = Number(process.env.CREDITS_POLL_MS || 15000);
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
let lastCredits = null;

async function pollCredits() {
  if (!OR_KEY) return;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${OR_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const c = (d && d.data) || {};
    const usage = typeof c.usage === 'number' ? c.usage : null;
    const total = typeof c.total_credits === 'number' ? c.total_credits : null;
    const remaining = (total != null && usage != null) ? Math.max(0, total - usage) : null;
    const prevRemaining = lastCredits && lastCredits.remaining;
    lastCredits = {
      type: 'credits', ok: true, ts: Date.now(),
      total_credits: total, usage,
      remaining,
      usage_daily: typeof c.usage_daily === 'number' ? c.usage_daily : null,
      usage_weekly: typeof c.usage_weekly === 'number' ? c.usage_weekly : null,
      usage_monthly: typeof c.usage_monthly === 'number' ? c.usage_monthly : null,
      delta: (prevRemaining != null && remaining != null) ? remaining - prevRemaining : null,
    };
  } catch (err) {
    lastCredits = { type: 'credits', ok: false, ts: Date.now(), error: String(err) };
  }
  broadcast(lastCredits);
}
if (OR_KEY) {
  pollCredits();
  setInterval(pollCredits, CREDITS_POLL_MS).unref();
}

// ---- lancement d'une session Claude Code ----
function attachmentsDir(name) {
  return path.join(WS_BASE, safeDir(name), '_attachments');
}

/** Sauve une pièce jointe (base64 ou data URL) dans le workspace de la conv. */
function saveAttachment(name, filename, data) {
  const dir = attachmentsDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || `file-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const b64 = String(data || '').replace(/^data:[^;]+;base64,/, '');
  const abs = path.join(dir, safe);
  fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
  return { abs, rel: path.join('_attachments', safe) };
}

/** Préfixe le message avec les pièces jointes à analyser (chemins relatifs au cwd). */
function withAttachments(message, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return message;
  const list = attachments.map((a) => `- ${a}`).join('\n');
  return `Pièces jointes à analyser (dans le dossier courant) :\n${list}\n\n${message}`;
}

const IMG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const VISION_MODEL = process.env.CLAUDE_VISION_MODEL || 'minimax-m2.5';

/**
 * VISION pour Claude Code : le CLI ne sait pas mettre une image dans le message
 * utilisateur en headless, et l'image passée via l'outil Read (tool_result) est
 * perdue à la traduction Anthropic->Ollama. On pré-décrit donc l'image avec le
 * modèle vision (image dans le message user = OK via LiteLLM) et on injecte la
 * description en texte dans le prompt de l'agent.
 */
async function describeImage(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const media = IMG_EXT[ext];
  if (!media) return null;
  const b64 = fs.readFileSync(absPath).toString('base64');
  const body = {
    model: VISION_MODEL, max_tokens: 700,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Décris cette image en détail et transcris TOUT le texte visible mot pour mot. Sois exhaustif et précis.' },
      { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
    ] }],
  };
  const r = await fetch(`${CLAUDE_ENV.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_ENV.ANTHROPIC_AUTH_TOKEN, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Pré-décrit les images jointes et préfixe le message avec leur contenu visuel. */
async function withVision(name, message, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return message;
  const cwd = path.join(WS_BASE, safeDir(name));
  const blocks = [];
  for (const rel of attachments) {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    if (!IMG_EXT[path.extname(abs).toLowerCase()]) continue;
    try {
      const desc = await describeImage(abs);
      if (desc) blocks.push(`[Contenu visuel de l'image ${rel} :\n${desc}\n]`);
    } catch { /* vision indispo : l'agent lira le fichier lui-même */ }
  }
  return blocks.length ? `${blocks.join('\n\n')}\n\n${message}` : message;
}

function resolveModel(name, requested) {
  const reg = loadSessions();
  const entry = reg.conversations[name];
  return String(requested || (entry && entry.model) || DEFAULT_MODEL || '').trim();
}

function mapToolName(name) {
  const n = String(name || 'tool');
  if (n === 'Bash' || n === 'bash') return 'shell';
  return n.charAt(0).toLowerCase() + n.slice(1);
}

function toolMeta(input) {
  const args = input && typeof input === 'object' ? input : {};
  return {
    command: args.command || args.cmd || null,
    cwd: args.workingDirectory || args.cwd || args.working_directory || null,
    path: args.file_path || args.path || args.file || null,
  };
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return p.text || p.content || JSON.stringify(p);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    return content.text || content.stdout || content.output || JSON.stringify(content, null, 2);
  }
  return String(content);
}

function runClaude(name, message, modelId) {
  ensureClaudeRuntimeDirs();
  const reg = loadSessions();
  const entry = reg.conversations[name];
  const cwd = path.join(WS_BASE, safeDir(name));
  fs.mkdirSync(cwd, { recursive: true });

  const model = resolveModel(name, modelId);
  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];
  // Groq free tier rate-limits hard under full Claude Code tool loops.
  // --bare keeps a single completion path so chat actually replies.
  if (String(model || '').startsWith('groq-') || process.env.CLAUDE_BARE === '1') {
    args.push('--bare');
  }
  if (model) args.push('--model', model);
  const useBare = String(model || '').startsWith('groq-')
    || String(model || '').startsWith('or-')
    || process.env.CLAUDE_BARE === '1';
  let sessionId;
  // Bare/Groq runs are short completions — resume often breaks ("No conversation found").
  if (!useBare && entry && entry.session_id && entry.started) {
    sessionId = entry.session_id;
    args.push('--resume', sessionId);
  } else {
    sessionId = crypto.randomUUID();
    args.push('--session-id', sessionId);
  }

  reg.conversations[name] = {
    ...(entry || {}),
    session_id: sessionId,
    model: model || (entry && entry.model) || DEFAULT_MODEL || null,
    cwd,
    started: true,
    created_at: (entry && entry.created_at) || new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  saveSessions(reg);

  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: { ...CLAUDE_ENV, ANTHROPIC_MODEL: model || CLAUDE_ENV.ANTHROPIC_MODEL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = {
    fullText: '',
    thinkingText: '',
    streamedText: false,
    streamedThinking: false,
    tools: new Map(), // tool_use_id → { name, input }
    pendingToolJson: '', // accumulate input_json_delta
    pendingToolId: null,
    pendingToolName: null,
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      handleClaudeEvent(name, sessionId, evt, state);
    }
  });
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.trim()) {
      broadcast({
        type: 'log', conversation: name, session_id: sessionId, composer_id: sessionId,
        text: s.slice(0, 500),
      });
    }
  });
  child.on('close', (code) => {
    if (state.streamedThinking) {
      broadcast({
        type: 'thinking', subtype: 'completed',
        conversation: name, session_id: sessionId, composer_id: sessionId,
      });
    }
    broadcast({
      type: 'response_complete',
      conversation: name,
      session_id: sessionId,
      composer_id: sessionId,
      text: state.fullText,
      exit: code,
    });
    broadcast({
      type: 'run_complete',
      conversation: name,
      session_id: sessionId,
      composer_id: sessionId,
    });
  });

  return sessionId;
}

function emitToolStart(name, sessionId, state, toolId, toolName, input) {
  if (!toolId) return;
  if (state.tools.has(toolId) && state.tools.get(toolId).emitted) return;
  const args = input && typeof input === 'object' ? input : {};
  const meta = toolMeta(args);
  const mapped = mapToolName(toolName);
  state.tools.set(toolId, { name: mapped, input: args, emitted: true });
  broadcast({
    type: 'tool',
    conversation: name,
    session_id: sessionId,
    composer_id: sessionId,
    call_id: toolId,
    tool: mapped,
    input: JSON.stringify(args).slice(0, 2000),
    command: meta.command,
    cwd: meta.cwd,
  });
}

function handleClaudeEvent(name, sessionId, evt, state) {
  // Partial Anthropic stream (token-by-token)
  if (evt.type === 'stream_event' && evt.event) {
    const ev = evt.event;
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      if (cb.type === 'tool_use') {
        state.pendingToolId = cb.id || null;
        state.pendingToolName = cb.name || 'tool';
        state.pendingToolJson = '';
      }
      return;
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'thinking_delta' && d.thinking) {
        state.thinkingText += d.thinking;
        state.streamedThinking = true;
        broadcast({
          type: 'thinking',
          conversation: name,
          session_id: sessionId,
          composer_id: sessionId,
          delta: d.thinking,
          text: state.thinkingText,
        });
      } else if (d.type === 'text_delta' && d.text) {
        state.fullText += d.text;
        state.streamedText = true;
        broadcast({
          type: 'response',
          conversation: name,
          session_id: sessionId,
          composer_id: sessionId,
          delta: d.text,
          text: state.fullText,
        });
      } else if (d.type === 'input_json_delta' && d.partial_json) {
        state.pendingToolJson += d.partial_json;
      }
      return;
    }
    if (ev.type === 'content_block_stop') {
      // Si on a le JSON complet de l'outil avant le message assistant, on l'émet ici
      if (state.pendingToolId) {
        let parsed = {};
        if (state.pendingToolJson) {
          try { parsed = JSON.parse(state.pendingToolJson); } catch { /* ignore */ }
        }
        emitToolStart(
          name, sessionId, state,
          state.pendingToolId,
          state.pendingToolName,
          parsed,
        );
      }
      state.pendingToolId = null;
      state.pendingToolName = null;
      state.pendingToolJson = '';
      return;
    }
    return;
  }

  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id) {
      const reg = loadSessions();
      if (reg.conversations[name]) {
        reg.conversations[name].session_id = evt.session_id;
        saveSessions(reg);
      }
      sessionId = evt.session_id;
    }
    broadcast({
      type: 'system', subtype: 'init',
      conversation: name,
      session_id: sessionId,
      composer_id: sessionId,
      model: evt.model,
    });
    return;
  }

  // Complete assistant messages (fallback + tool_use with full input)
  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'thinking' && block.thinking && !state.streamedThinking) {
        state.thinkingText += block.thinking;
        broadcast({
          type: 'thinking',
          conversation: name,
          session_id: sessionId,
          composer_id: sessionId,
          delta: block.thinking,
          text: state.thinkingText,
        });
      } else if (block.type === 'text' && block.text && !state.streamedText) {
        state.fullText += block.text;
        broadcast({
          type: 'response',
          conversation: name,
          session_id: sessionId,
          composer_id: sessionId,
          delta: block.text,
          text: state.fullText,
        });
      } else if (block.type === 'tool_use') {
        emitToolStart(name, sessionId, state, block.id, block.name, block.input || {});
      }
    }
    return;
  }

  // Tool results
  if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block.type !== 'tool_result') continue;
      const callId = block.tool_use_id;
      const result = toolResultText(block.content);
      broadcast({
        type: 'tool_complete',
        conversation: name,
        session_id: sessionId,
        composer_id: sessionId,
        call_id: callId,
        result,
        // Compat UI Cursor : faux tool_call shell-like
        tool_call: {
          shellToolCall: {
            result: { stdout: result, output: result },
          },
        },
      });
    }
    return;
  }

  if (evt.type === 'result') {
    if (state.streamedThinking) {
      broadcast({
        type: 'thinking', subtype: 'completed',
        conversation: name, session_id: sessionId, composer_id: sessionId,
      });
      state.streamedThinking = false;
    }
  }
}

// ---- HTTP ----

/** Page dashboard temps réel (crédits OpenRouter + flux d'événements). */
function dashboardHtml() {
  const models = AVAILABLE_MODELS.map((m) => m.id).join(', ');
  return `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>clo — crédits OpenRouter en direct</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,sans-serif; background:#0f1115; color:#e6e8ee; }
  header { display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding:14px 18px; background:#161a22; border-bottom:1px solid #262c3a; position:sticky; top:0; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  #dot { width:10px; height:10px; border-radius:50%; background:#666; }
  #dot.on { background:#3fb950; box-shadow:0 0 8px #3fb950; }
  .badge { display:flex; flex-direction:column; align-items:flex-end; margin-left:auto; }
  #credits { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; }
  #credits.ok { color:#3fb950; } #credits.warn { color:#d29922; } #credits.low { color:#f85149; }
  #sub { font-size:12px; color:#8b93a5; }
  #meta { font-size:12px; color:#8b93a5; width:100%; }
  main { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:14px 18px; }
  @media (max-width:800px){ main { grid-template-columns:1fr; } }
  section { background:#161a22; border:1px solid #262c3a; border-radius:10px; padding:12px 14px; min-height:120px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#8b93a5; margin:0 0 8px; }
  #feed { list-style:none; margin:0; padding:0; max-height:60vh; overflow:auto; font-family:ui-monospace,monospace; font-size:12.5px; }
  #feed li { padding:3px 6px; border-radius:6px; white-space:pre-wrap; word-break:break-word; }
  #feed li:nth-child(odd){ background:#1a1f2b; }
  .t-inject{color:#79c0ff} .t-response{color:#e6e8ee} .t-tool{color:#d2a8ff} .t-tool_complete{color:#8b93a5}
  .t-response_complete{color:#3fb950} .t-credits{color:#d29922} .t-log{color:#f0883e} .t-system{color:#56d4dd}
  .bar { height:8px; background:#262c3a; border-radius:99px; overflow:hidden; margin-top:6px; }
  .bar > div { height:100%; background:#3fb950; width:0%; transition:width .5s; }
  #models { font-size:13px; color:#aeb6c6; }
</style></head><body>
<header>
  <span id="dot"></span><h1>claude-code-llm — bridge</h1>
  <div class="badge">
    <span id="credits">…</span>
    <span id="sub">crédit OpenRouter restant</span>
  </div>
  <div id="meta"></div>
  <div class="bar" style="flex-basis:100%"><div id="barfill"></div></div>
</header>
<main>
  <section><h2>Modèles supportés</h2><div id="models">${models}</div></section>
  <section><h2>Flux temps réel (SSE)</h2><ul id="feed"></ul></section>
</main>
<script>
const TOKEN = ${JSON.stringify(TOKEN)};
const $ = (id) => document.getElementById(id);
const fmt = (n) => n == null ? '—' : '$' + n.toFixed(n < 1 ? 4 : 2);
function onCredits(c) {
  const el = $('credits');
  if (!c.ok) { el.textContent = 'erreur'; el.className = ''; $('sub').textContent = c.error || 'OpenRouter injoignable'; return; }
  el.textContent = fmt(c.remaining);
  el.className = c.remaining == null ? '' : c.remaining < 0.5 ? 'low' : c.remaining < 2 ? 'warn' : 'ok';
  const used = c.usage != null ? 'utilisé ' + fmt(c.usage) + (c.total_credits != null ? ' / ' + fmt(c.total_credits) : '') : '';
  const delta = c.delta != null && c.delta !== 0 ? ' · ' + (c.delta < 0 ? '−' : '+') + fmt(Math.abs(c.delta)).slice(1) + ' depuis le dernier relevé' : '';
  $('sub').textContent = used + delta;
  $('meta').textContent = 'mis à jour à ' + new Date(c.ts).toLocaleTimeString() + ' — rafraîchi toutes les 15 s';
  if (c.remaining != null && c.total_credits > 0) $('barfill').style.width = Math.min(100, 100 * c.remaining / c.total_credits) + '%';
  feed('credits', 'crédit restant ' + fmt(c.remaining) + (used ? ' (' + used + ')' : ''));
}
function feed(type, text) {
  const li = document.createElement('li');
  li.className = 't-' + type;
  li.textContent = new Date().toLocaleTimeString() + '  [' + type + '] ' + text;
  const ul = $('feed');
  ul.prepend(li);
  while (ul.children.length > 300) ul.lastChild.remove();
}
function connect() {
  const es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
  es.onopen = () => $('dot').className = 'on';
  es.onerror = () => { $('dot').className = ''; es.close(); setTimeout(connect, 3000); };
  es.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    if (e.type === 'credits') return onCredits(e);
    if (e.type === 'ping' || e.type === 'connected') return;
    if (e.type === 'response') return; // trop verbeux, on attend response_complete
    const conv = e.conversation ? e.conversation + ': ' : '';
    if (e.type === 'tool') return feed('tool', conv + (e.tool || '?') + (e.command ? ' $ ' + e.command : ''));
    if (e.type === 'response_complete') return feed('response_complete', conv + (e.text || '').slice(0, 400));
    if (e.type === 'tool_complete') return feed('tool_complete', conv + String(e.result || '').slice(0, 200));
    if (e.type === 'inject') return feed('inject', conv + 'message injecté');
    feed(e.type, conv + JSON.stringify(e).slice(0, 200));
  };
}
connect();
</script>
</body></html>`;
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function auth(req, url) {
  if ((req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  // EventSource ne peut pas poser de header Authorization : token en query.
  return url && url.searchParams.get('token') === TOKEN;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, service: 'claude-bridge', port: PORT });
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }
  if (!auth(req, url)) return send(res, 401, { ok: false, error: 'Unauthorized' });

  if (p === '/api/credits') {
    return send(res, 200, lastCredits || { ok: false, error: 'pas encore de relevé (OPENROUTER_API_KEY absente ?)' });
  }

  if (p === '/api/status') {
    const orOk = Boolean(OR_KEY && !OR_KEY.includes('your-openrouter'));
    return send(res, 200, {
      ok: true, ready: true, service: 'claude-bridge',
      registry: SESSIONS_FILE, ws_base: WS_BASE, port: PORT,
      model: CLAUDE_ENV.ANTHROPIC_MODEL,
      models: AVAILABLE_MODELS,
      default_model: DEFAULT_MODEL || AVAILABLE_MODELS[0]?.id || null,
      openrouter_configured: orOk,
      openrouter_credits: lastCredits,
    });
  }

  if (p === '/api/models') {
    const orOk = Boolean(OR_KEY && !OR_KEY.includes('your-openrouter'));
    const models = AVAILABLE_MODELS
      .filter((m) => !String(m.id || '').startsWith('groq-'))
      .map((m) => {
      const needsOr = String(m.id || '').startsWith('or-');
      const available = !needsOr || (orOk && lastCredits?.ok !== false);
      let unavailableReason = null;
      if (needsOr && !orOk) unavailableReason = 'Clé OpenRouter manquante';
      else if (needsOr && lastCredits && !lastCredits.ok) {
        unavailableReason = lastCredits.error || 'Crédits OpenRouter insuffisants';
      }
      return { ...m, requiresOpenRouter: needsOr, available, unavailableReason };
    });
    return send(res, 200, {
      ok: true,
      models,
      default_model: DEFAULT_MODEL || AVAILABLE_MODELS[0]?.id || null,
      openrouter_configured: orOk,
    });
  }

  if (p === '/api/conversations/model' && req.method === 'GET') {
    const name = normalizeName(url.searchParams.get('conversation'));
    const reg = loadSessions();
    const entry = reg.conversations[name] || {};
    return send(res, 200, {
      ok: true,
      conversation: name,
      model: entry.model || DEFAULT_MODEL || AVAILABLE_MODELS[0]?.id || null,
    });
  }

  if (p === '/api/conversations/model' && req.method === 'POST') {
    const body = await readBody(req);
    const name = normalizeName(body.conversation);
    const model = String(body.model || '').trim();
    if (!name) return send(res, 400, { ok: false, error: 'conversation requise' });
    if (!model) return send(res, 400, { ok: false, error: 'model requis' });
    const reg = loadSessions();
    const entry = reg.conversations[name] || {};
    reg.conversations[name] = {
      ...entry,
      model,
      created_at: entry.created_at || new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    };
    saveSessions(reg);
    return send(res, 200, { ok: true, conversation: name, model });
  }

  if (p === '/api/conversations') {
    const reg = loadSessions();
    const registered = Object.entries(reg.conversations).map(([name, e]) => ({
      name, title: name, session_id: e.session_id, model: e.model || null,
      created_at: e.created_at, last_used_at: e.last_used_at,
    }));
    return send(res, 200, { ok: true, registered });
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    if (lastCredits) res.write(`data: ${JSON.stringify(lastCredits)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`); } catch { /* */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const name = normalizeName(body.conversation);
    if (!name) return send(res, 400, { ok: false, error: 'conversation requise' });
    if (!body.data) return send(res, 400, { ok: false, error: 'data (base64) requis' });
    try {
      const saved = saveAttachment(name, body.filename, body.data);
      return send(res, 200, { ok: true, ...saved });
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err) });
    }
  }

  if (p === '/api/inject' && req.method === 'POST') {
    const body = await readBody(req);
    const name = normalizeName(body.conversation);
    if (!name) return send(res, 400, { ok: false, error: 'conversation requise' });
    let message = withAttachments(String(body.message || '').trim(), body.attachments);
    if (!message) return send(res, 400, { ok: false, error: 'message vide' });
    // Pré-description des images jointes (vision fiable sur backend Ollama).
    message = await withVision(name, message, body.attachments);
    const id = `inject-${Date.now()}`;
    try {
      const sessionId = runClaude(name, message, body.model);
      const model = resolveModel(name, body.model);
      broadcast({ type: 'inject', ok: true, id, conversation: name, session_id: sessionId, model });
      return send(res, 200, { ok: true, id, conversation: name, session_id: sessionId, composer_id: sessionId, model });
    } catch (err) {
      return send(res, 502, { ok: false, error: String(err), id });
    }
  }

  if (p === '/api/conversations/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const name = normalizeName(body.conversation);
    const reg = loadSessions();
    if (reg.conversations[name]) { delete reg.conversations[name]; saveSessions(reg); }
    return send(res, 200, { ok: true, conversation: name });
  }

  return send(res, 404, { ok: false, error: `route inconnue: ${p}` });
});

server.listen(PORT, BIND, () => {
  console.log(`[claude-bridge] http://${BIND}:${PORT}  sessions=${SESSIONS_FILE}  model=${CLAUDE_ENV.ANTHROPIC_MODEL}`);
});
