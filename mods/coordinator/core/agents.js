// What an agent runs on (agent, model, effort, speed, context) and how to start it again with other choices: the
// rules both the window's model menu (lib/agent.js, mods/chat-models) and the web app's use. Reading an agent's own
// settings and restarting it run where each side runs commands (lib/agent.js, service/agents.ts).
// Shared core: the source is core/agents.js; bin/sync-shared copies it into the mods in lib/COPIES.
export const NAMES = { claude: "Claude Code", codex: "Codex", omp: "OMP" };

// Claude Code's current models, as its /model menu offers them. `id` is what --model gets;
// `match` the names a running agent may report for it.
const CLAUDE_MODELS = [
  { id: "opus", name: "Opus 5.5", match: ["opus", "claude-opus-5-5"] },
  { id: "opus[1m]", name: "Opus 5.5 · 1M", match: ["opus[1m]", "claude-opus-5-5[1m]"] },
  { id: "claude-fable-5-2", name: "Fable 5.2", match: ["fable", "claude-fable-5-2"] },
  { id: "sonnet", name: "Sonnet 5.5", match: ["sonnet", "claude-sonnet-5-5"] },
  { id: "haiku", name: "Haiku 5.5", match: ["haiku", "claude-haiku-5-5"] },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// OMP's thinking levels (--thinking; also what a model's own list says) and its approval modes.
const OMP_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const OMP_DEFAULT_THINKING = ["low", "medium", "high", "xhigh", "max"];
// Permission modes as each CLI has them (Claude: --permission-mode, or
// --dangerously-skip-permissions for full access; Codex: its sandbox and approvals; OMP: --approval-mode).
const PERMS = {
  claude: [{ id: "manual", label: "Ask" }, { id: "auto", label: "Auto" }, { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Full access" }],
  codex: [{ id: "read-only", label: "Read only" }, { id: "auto", label: "Auto" }, { id: "full", label: "Full access" }],
  omp: [{ id: "always-ask", label: "Ask" }, { id: "always-ask-cached", label: "Ask once cached" },
    { id: "write", label: "Write" }, { id: "yolo", label: "Full access" }],
};
// A permission mode carried to the other agent when the agent is switched: its nearest mode there (auto stays auto,
// full access stays full access, Claude's accept edits is Codex's auto, plan and read only swap), else that agent's
// default (Claude's ask has no Codex match). Never silently drops auto to ask on a round trip (#758).
const PERM_ACROSS = {
  claude: { "read-only": "plan", auto: "auto", full: "bypassPermissions", "always-ask-cached": "auto", write: "acceptEdits", yolo: "bypassPermissions" },
  codex: { plan: "read-only", auto: "auto", acceptEdits: "auto", bypassPermissions: "full", "always-ask-cached": "auto", write: "auto", yolo: "full" },
  omp: { manual: "always-ask", auto: "write", acceptEdits: "write", plan: "always-ask", bypassPermissions: "yolo", "read-only": "always-ask", full: "yolo" },
};
export function permAcross(perm, agent, permDefault) {
  return PERM_ACROSS[agent]?.[perm] ?? (PERMS[agent]?.some((p) => p.id === perm) ? perm : null) ?? permDefault?.[agent] ?? null;
}

// What a model id says, in words: "claude-opus-5-5" → "Opus 5.5", "opus[1m]" → "Opus 1M".
export function modelName(id) {
  if (!id) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
  const a = /^([a-z]+)(\[1m\])?$/.exec(id);
  if (a) return `${a[1][0].toUpperCase()}${a[1].slice(1)}${a[2] ? " 1M" : ""}`;
  return id;
}

// A flag's value in argv: --model x, --model=x, or -m x.
function flag(argv, ...names) {
  for (let i = argv.length - 1; i >= 0; i--) {
    for (const n of names) {
      if (argv[i] === n && i + 1 < argv.length) return argv[i + 1];
      if (argv[i].startsWith(n + "=")) return argv[i].slice(n.length + 1);
    }
  }
  return null;
}
// Codex's -c key=value overrides.
function overrides(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" && argv[i] !== "--config") continue;
    const m = /^([\w.]+)=(.*)$/.exec(argv[i + 1]);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// The agent's own settings on its machine: Claude's settings.json, Codex's config.toml and
// model list. Read once per agent process.
export const DEFAULTS = `
if [ "$1" = claude ]; then
  f="$HOME/.claude/settings.json"
  command -v jq >/dev/null && [ -f "$f" ] && jq -r '"model\\t\\(.model // "")", "effort\\t\\(.effortLevel // "")", "fast\\t\\(if .fastMode == true then "on" else "" end)", "per\\t\\(.modelSettings // {} | with_entries(.value |= (.effortLevel // null)) | tojson)", "mode\\t\\(.permissions.defaultMode // "")"' "$f" 2>/dev/null
elif [ "$1" = omp ]; then
  a="\${PI_CODING_AGENT_DIR:-}"; [ -n "$a" ] || a="\${PI_CONFIG_DIR:+$PI_CONFIG_DIR/agent}"; [ -n "$a" ] || a="$HOME/.omp/agent"
  lim=""; command -v timeout >/dev/null 2>&1 && lim="timeout 15"
  if command -v omp >/dev/null 2>&1; then
    r=$($lim omp config get modelRoles 2>/dev/null)
    [ -n "$r" ] && printf 'roles\\t%s\\n' "$r"
    t=$($lim omp config get defaultThinkingLevel 2>/dev/null | head -1)
    [ -n "$t" ] && printf 'thinking\\t%s\\n' "$t"
    v=$($lim omp config get tools.approvalMode 2>/dev/null | head -1)
    [ -n "$v" ] && printf 'mode\\t%s\\n' "$v"
    m=$($lim omp models --json 2>/dev/null)
    [ -n "$m" ] && printf 'models\\t%s\\n' "$m"
  else
    # Its own files when the CLI isn't on this shell's PATH (herdr-task's machine, another user).
    f="$a/config.yml"
    if [ -f "$f" ]; then
      r=$(awk '/^[^[:space:]#][^:]*:/{ s=$1; sub(/:.*/, "", s) }
        s=="modelRoles" && $1=="default:" { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^["\\047]|["\\047]$/, ""); print; exit }' "$f")
      [ -n "$r" ] && printf 'roles\\t{"default":"%s"}\\n' "$r"
      v=$(sed -n 's/^[[:space:]]*approvalMode:[[:space:]]*//p' "$f" 2>/dev/null | head -1 | sed 's/[[:space:]]*#.*//; s/^["\\047]//; s/["\\047]$//')
      [ -n "$v" ] && printf 'mode\\t%s\\n' "$v"
    fi
  fi
else
  f="$HOME/.codex/config.toml"
  for k in model model_reasoning_effort service_tier sandbox_mode approval_policy; do
    printf '%s\\t%s\\n' "$k" "$(sed -n "s/^$k[[:space:]]*=[[:space:]]*\\"\\{0,1\\}\\([^\\"]*\\)\\"\\{0,1\\}.*/\\1/p" "$f" 2>/dev/null | head -1)"
  done
  c="$HOME/.codex/models_cache.json"
  [ -f "$c" ] && { printf 'models\\t'; tr -d '\\n' < "$c"; echo; }
fi
true`;

function parsePer(text) {
  try { return JSON.parse(text || "{}") ?? {}; } catch { return {}; }
}

// The agent's own settings, from DEFAULTS' output on its machine.
export function parseDefaults(kind, stdout) {
  const out = {};
  for (const line of (stdout ?? "").split("\n")) {
    const t = line.indexOf("\t");
    if (t > 0) out[line.slice(0, t)] = line.slice(t + 1);
  }
  let models = null;
  if (out.models) {
    try {
      models = (JSON.parse(out.models).models ?? []).filter((m) => m.visibility !== "hide").map((m) => ({
        id: m.slug, label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
        fast: (m.service_tiers ?? []).length > 0,
        defaultEffort: m.default_reasoning_level ?? null,
      }));
    } catch {}
  }
  if (kind === "omp") {
    // OMP's config names a role's model as provider/model:thinking (the level being optional).
    let raw = String(out.roles ?? "");
    try { const roles = JSON.parse(raw); raw = String(roles?.default ?? ""); } catch {}
    const role = /^(.*):(off|minimal|low|medium|high|xhigh|max|auto)$/.exec(raw);
    const model = role ? role[1] : raw || null;
    const effort = role?.[2] || out.thinking || null;
    // OMP's own model catalog (omp models --json): its selector is what --model takes.
    let all = null;
    if (out.models) {
      try {
        const rows = JSON.parse(out.models).models ?? [];
        const seen = new Set();
        all = rows.filter((m) => !m.kind || m.kind === "chat").flatMap((m) => {
          const id = String(m.selector ?? `${m.provider}/${m.id}`);
          if (!id || seen.has(id)) return [];
          seen.add(id);
          return [{ id, label: m.name || m.id || id, efforts: Array.isArray(m.thinking) && m.thinking.length ? m.thinking : OMP_DEFAULT_THINKING,
            defaultEffort: effort, fast: false, window: m.contextWindow ?? null }];
        });
      } catch {}
    }
    return { model, effort, mode: out.mode || "yolo", models: all };
  }
  return kind === "claude"
    ? { model: out.model || null, effort: out.effort || null, fast: Boolean(out.fast), per: parsePer(out.per), mode: out.mode || null }
    : { model: out.model || null, effort: out.model_reasoning_effort || null, fast: ["fast", "priority"].includes(out.service_tier),
      sandbox: out.sandbox_mode || null, approval: out.approval_policy || null, models };
}

// What the agent runs on now: { agent, model, effort, fast, used, window, alias }.
export function current(kind, argv, meta, dflt) {
  argv = argv ?? [];
  meta = meta ?? {};
  dflt = dflt ?? {};
  if (kind === "claude") {
    // a /model in place (SHEP-181) names the row it switched to, its 1M too, which the log's turns don't say
    const alias = meta.alias ?? flag(argv, "--model") ?? dflt.model;
    let fast = dflt.fast;
    const s = flag(argv, "--settings");
    if (s && /"fastMode"\s*:\s*(true|false)/.test(s)) fast = /"fastMode"\s*:\s*true/.test(s);
    if (meta.speed) fast = meta.speed === "fast";
    const big = /\[1m\]/.test(alias ?? "") || (meta.used ?? 0) > 200000;
    // Claude keeps an effort per model (modelSettings), known once the log names the model.
    const per = meta.model ? dflt.per?.[meta.model] ?? dflt.per?.[meta.model.replace(/-\d+$/, "")] : null;
    const perm = argv.includes("--dangerously-skip-permissions") ? "bypassPermissions" : flag(argv, "--permission-mode") ?? dflt.mode ?? "manual";
    return { agent: "claude", model: meta.model ?? alias, alias, effort: meta.effort ?? flag(argv, "--effort") ?? per ?? dflt.effort,
      fast: Boolean(fast), perm: perm === "default" ? "manual" : perm, used: meta.used ?? null, window: meta.window ?? (big ? 1000000 : 200000) };
  }
  if (kind === "omp") {
    const model = meta.model ?? flag(argv, "--model") ?? dflt.model;
    const known = dflt.models?.find((m) => m.id === model) ?? null;
    const perm = argv.includes("--auto-approve") ? "yolo"
      : flag(argv, "--approval-mode") ?? dflt.mode ?? "yolo";
    return { agent: "omp", model, label: known?.label ?? null, perm,
      effort: meta.effort ?? flag(argv, "--thinking") ?? dflt.effort,
      fast: false, used: meta.used ?? null, window: meta.window ?? known?.window ?? null };
  }
  const o = overrides(argv);
  const tier = o.service_tier;
  const model = meta.model ?? flag(argv, "-m", "--model") ?? o.model ?? dflt.model;
  const sandbox = flag(argv, "-s", "--sandbox") ?? o.sandbox_mode ?? dflt.sandbox;
  const perm = argv.includes("--dangerously-bypass-approvals-and-sandbox") || sandbox === "danger-full-access" ? "full"
    : sandbox === "read-only" ? "read-only" : "auto";
  return { agent: "codex", model, label: dflt.models?.find((m) => m.id === model)?.label ?? null, perm,
    effort: meta.effort ?? o.model_reasoning_effort ?? dflt.effort,
    fast: meta.speed ? meta.speed === "fast" : tier ? ["fast", "priority"].includes(tier) : Boolean(dflt.fast), used: meta.used ?? null, window: meta.window ?? null };
}

// An effort level as the person reads it: "xhigh" -> "Extra high". The CLIs still get the raw value.
const LEVELS = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", auto: "Auto", none: "None" };
export function levelName(e) {
  return e ? LEVELS[e] ?? e[0].toUpperCase() + e.slice(1) : null;
}

// "Claude Code · Opus 5.5 · High · Fast"
export function line(c) {
  if (!c) return "";
  return [NAMES[c.agent], c.label ?? modelName(c.model), levelName(c.effort), c.fast ? "Fast" : null].filter(Boolean).join(" · ");
}

// How full the context window is: "38% context", or null.
export function contextWords(c) {
  if (!c?.used || !c.window) return null;
  return `${Math.min(100, Math.round((c.used / c.window) * 100))}% context`;
}

// What the model picker (mods/chat-models, the web's restart.tsx) shows for one agent, as plain data:
// { name, models: [{ id, name, efforts, defaultEffort, fast }], perms }: every model the CLI
// offers (Codex: its own models_cache.json; Claude Code: its /model menu), the picker searches them.
// `dflt` is that agent's settings (defaults()); `current` its running model, kept in the list.
export function menuFor(agent, dflt, current = null) {
  if (agent === "claude") {
    const models = CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name, efforts: CLAUDE_EFFORTS,
      defaultEffort: dflt?.per?.[m.match[1].replace(/\[1m\]$/, "")] ?? dflt?.effort ?? null, fast: m.id.startsWith("opus") }));
    // a model typed by id (an older one it still takes) stays in the list while it runs
    if (current && !models.some((m) => m.id === current)) models.unshift({ id: current, name: modelName(current), efforts: CLAUDE_EFFORTS, defaultEffort: dflt?.effort ?? null, fast: false });
    return { name: NAMES.claude, perms: PERMS.claude, models };
  }
  if (agent === "omp") {
    // Its own catalog (omp models --json); a model typed by id stays while it runs.
    const all = (dflt?.models ?? []).map((m) => ({ id: m.id, name: m.label ?? m.id, efforts: m.efforts?.length ? m.efforts : OMP_DEFAULT_THINKING,
      defaultEffort: m.defaultEffort ?? dflt?.effort ?? null, fast: false }));
    if (current && !all.some((m) => m.id === current)) all.unshift({ id: current, name: current, efforts: OMP_DEFAULT_THINKING, defaultEffort: dflt?.effort ?? null, fast: false });
    return { name: NAMES.omp, perms: PERMS.omp, models: all };
  }
  const all = (dflt?.models ?? []).map((m) => ({ id: m.id, name: m.label, efforts: m.efforts?.length ? m.efforts : ["low", "medium", "high", "xhigh"],
    defaultEffort: m.defaultEffort ?? dflt?.effort ?? null, fast: m.fast }));
  if (current && !all.some((m) => m.id === current)) all.unshift({ id: current, name: current, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: dflt?.effort ?? null, fast: false });
  return { name: NAMES.codex, perms: PERMS.codex, models: all };
}

// The levels a model typed by id gets: its agent's usual ones.
export function typedModel(agent, id) {
  const efforts = agent === "claude" ? CLAUDE_EFFORTS : agent === "omp" ? OMP_DEFAULT_THINKING : ["low", "medium", "high", "xhigh"];
  return { id, name: agent === "claude" ? modelName(id) : id, efforts, defaultEffort: null, fast: false, typed: true };
}

// The person's picks in the model menus (the window's and the web's alike), in PICKS_FILE under the
// home of the machine the menu runs on: { pinned: ["codex:gpt-6-sol"], recent: [...] }, recent newest first.
export const PICKS_FILE = ".herdr/model-picks.json";
const RECENT = 5;
export const pickKey = (agent, id) => `${agent}:${id}`;
export function parsePicks(text) {
  let d = {};
  try { d = JSON.parse(text || "{}") ?? {}; } catch {}
  const list = (x) => (Array.isArray(x) ? x.filter((k) => typeof k === "string" && k.includes(":")) : []);
  return { pinned: list(d.pinned), recent: list(d.recent).slice(0, RECENT) };
}
// Restarted on it: first among the recent ones.
export function withRecent(picks, key) {
  return { ...picks, recent: [key, ...picks.recent.filter((k) => k !== key)].slice(0, RECENT) };
}
// The star: pinned to the top of its agent's list, or not any more.
export function withPin(picks, key) {
  return { ...picks, pinned: picks.pinned.includes(key) ? picks.pinned.filter((k) => k !== key) : [...picks.pinned, key] };
}

// Every word typed is in the model's name or id somewhere, any case ("op 1m" finds Opus 5.5 · 1M).
export function modelMatches(m, q) {
  const hay = `${m.name ?? ""} ${m.id}`.toLowerCase().replace(/[^a-z0-9.\[\] ]+/g, " ");
  return String(q ?? "").toLowerCase().split(/[^a-z0-9.\[\]]+/).filter(Boolean).every((w) => hay.includes(w));
}

// The model list as the picker shows it: sections of rows, at most CAP rows each (`more` counts the rest).
// Nothing typed: the agent shown (`agent`), its pinned models, then its recent ones, then all the rest in the
// CLI's order. Typed: every agent's matches, an agent to a section (its pinned and recent first), and, for one
// word no model of an agent has as its id, a row per such agent to start it on that id (`typed`).
// Each row: { agent, ...model, pinned }; a section: { key, title, agent, rows, more }.
export const CAP = 200;
export function modelSections(menus, agent, picks, q) {
  picks = picks ?? { pinned: [], recent: [] };
  const query = String(q ?? "").trim();
  const order = (k, models) => {
    const rank = (m) => {
      const key = pickKey(k, m.id), p = picks.pinned.indexOf(key), r = picks.recent.indexOf(key);
      return p >= 0 ? p : r >= 0 ? 1000 + r : 2000;
    };
    return models.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ m }) => ({ agent: k, ...m, pinned: picks.pinned.includes(pickKey(k, m.id)) }));
  };
  // a pinned or recent model typed by id (no CLI lists it) stays on offer
  const saved = (k) => {
    const models = menus?.[k]?.models ?? [], known = new Set(models.map((m) => m.id));
    const ids = [...new Set([...picks.pinned, ...picks.recent].filter((x) => x.startsWith(`${k}:`)).map((x) => x.slice(k.length + 1)))];
    return [...models, ...ids.filter((id) => !known.has(id)).map((id) => ({ ...typedModel(k, id), typed: false }))];
  };
  const capped = (key, title, k, rows) => ({ key, title, agent: k, rows: rows.slice(0, CAP), more: Math.max(0, rows.length - CAP) });
  if (!query) {
    const rows = order(agent, saved(agent));
    const pinned = rows.filter((r) => r.pinned);
    const recent = rows.filter((r) => !r.pinned && picks.recent.includes(pickKey(agent, r.id)));
    const rest = rows.filter((r) => !r.pinned && !picks.recent.includes(pickKey(agent, r.id)));
    return [
      ...(pinned.length ? [capped("pinned", "Pinned", agent, pinned)] : []),
      ...(recent.length ? [capped("recent", "Recent", agent, recent)] : []),
      ...(rest.length ? [capped("all", pinned.length || recent.length ? "All models" : "Models", agent, rest)] : []),
    ];
  }
  const out = [];
  // the agent shown first, then the others in their usual order
  for (const k of [agent, ...Object.keys(menus ?? {}).filter((x) => x !== agent)]) {
    const m = menus?.[k];
    if (!m) continue;
    const rows = order(k, saved(k).filter((x) => modelMatches(x, query)));
    if (rows.length) out.push(capped(k, m.name, k, rows));
  }
  // one word that could be an id, and no model has it: start any agent on it as typed
  if (/^[\w.\[\]-]{2,60}$/.test(query)) {
    const rows = [agent, ...Object.keys(menus ?? {}).filter((x) => x !== agent)]
      .filter((k) => menus?.[k] && !saved(k).some((m) => m.id === query)).map((k) => ({ agent: k, ...typedModel(k, query), pinned: false }));
    if (rows.length) out.push({ key: "typed", title: "Use the id typed", agent, rows, more: 0 });
  }
  return out;
}

// The picker row that is what runs now (`c` from current()), or the model as it is.
export function rowFor(agent, c) {
  if (agent !== "claude") return c?.model ?? null;
  const has = (m, x) => (m.match ?? [m.id]).includes(x);
  // What runs (the log's model) wins; the alias it was started with only tells which row of
  // that model (Opus or Opus 1M), since the log names both alike.
  const byAlias = c?.alias ? CLAUDE_MODELS.find((m) => has(m, c.alias)) : null;
  const byModel = c?.model ? CLAUDE_MODELS.find((m) => has(m, c.model)) : null;
  const same = byAlias && (!c?.model || (byAlias.match ?? [byAlias.id]).some((x) => x.replace(/\[1m\]$/, "") === c.model));
  return (same ? byAlias : byModel ?? byAlias)?.id ?? c?.model ?? null;
}

// Flags that are about what to resume, which model, effort or speed: set again by a restart.
const CLAUDE_DROP = new Set(["--model", "--effort", "--settings", "--session-id", "--resume", "-r", "--permission-mode"]);
const CLAUDE_BARE = new Set(["--continue", "-c", "--fork-session", "--dangerously-skip-permissions"]);
// Flags whose next word is their value (so it isn't taken for a first message).
const CLAUDE_VALUE = new Set(["--add-dir", "--mcp-config", "--append-system-prompt", "--system-prompt",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--agent", "--agents", "--plugin-dir",
  "--fallback-model", "--output-format", "--input-format", "--name", "--setting-sources", "--betas", "--debug-file"]);
const CODEX_VALUE = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval",
  "-C", "--cd", "--add-dir", "-i", "--image", "--enable", "--disable", "--local-provider", "--oss"]);
// OMP: what a restart chooses again, what it keeps, and which flags' next word is their value.
const OMP_DROP = new Set(["--model", "--thinking", "--approval-mode", "--resume", "-r", "--session", "--fork", "--restore"]);
const OMP_BARE = new Set(["--continue", "-c", "--auto-approve"]);
const OMP_VALUE = new Set(["--smol", "--slow", "--plan", "--prewalk-into", "--plan-yolo-into", "--provider", "--api-key",
  "--system-prompt", "--system-prompt-template", "--append-system-prompt", "--profile", "--alias", "--cwd", "--mode", "--config",
  "--add-dir", "--session-dir", "--models", "--tools", "--service-tier", "--hook", "--extension", "-e", "--skills", "--export",
  "--spinner-interval", "--max-fps", "--motion", "--max-time", "--warn-cost", "--max-cost"]);

// Where the agent's own word (claude, codex, omp) is in argv: a terminal's argv starts with what launched it (nice,
// sh -c, env, the person's `bash -ic`), whose words are no agent flags (#1001: its -ic was Codex's `-i c`, an image).
function agentAt(argv) {
  return argv.findIndex((a, i) => (i === 0 || !String(a).startsWith("-")) && /^(claude|codex|omp)$/.test(String(a).split("/").pop()));
}

// The old agent's flags worth keeping (permissions, folders, ...), without what is chosen again
// or a first message.
function kept(kind, argv) {
  const out = [];
  const rest = argv.slice(Math.max(agentAt(argv), 0) + 1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (kind === "claude") {
      if (CLAUDE_BARE.has(a)) continue;
      if (CLAUDE_DROP.has(a)) { if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if ([...CLAUDE_DROP].some((f) => a.startsWith(f + "="))) continue;
      if (CLAUDE_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    } else if (kind === "omp") {
      if (OMP_BARE.has(a)) continue;
      if (OMP_DROP.has(a)) { if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if ([...OMP_DROP].some((f) => a.startsWith(f + "="))) continue;
      if (OMP_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    } else {
      if (i === 0 && (a === "resume" || a === "fork")) { if (rest[1] && !rest[1].startsWith("-")) i++; continue; }
      if (a === "--no-daemon" || a === "--dangerously-bypass-approvals-and-sandbox" || a === "--full-auto") continue;
      if (["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval"].includes(a)) { i++; continue; }
      if ((a === "-c" || a === "--config") && /^(model|model_reasoning_effort|service_tier)=/.test(rest[i + 1] ?? "")) { i++; continue; }
      if (CODEX_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    }
  }
  return out.filter((x) => x !== undefined);
}

// The same agent, model and flags as `argv`, without what resumed a conversation (and without a
// first message), or null when argv resumed none: for a fresh start once that session is gone.
export function freshArgv(kind, argv) {
  const s = stripSession(kind, argv);
  return s?.resumed ? s.out : null;
}

// argv without its session (a resume, fork, session id or first message): { out, resumed }, or null when no
// claude/codex word is in it.
function stripSession(kind, argv) {
  argv = argv ?? [];
  const at = agentAt(argv);
  if (at < 0) return null;
  const rest = argv.slice(at + 1), out = [argv[at]];
  let resumed = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (kind === "claude") {
      if (a === "--resume" || a === "-r" || a === "--session-id") { resumed ||= a !== "--session-id"; if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if (/^--(resume|session-id)=/.test(a)) { resumed ||= a.startsWith("--resume"); continue; }
      if (a === "--continue" || a === "-c") { resumed = true; continue; }
      if (a === "--fork-session") continue;
      if (CLAUDE_VALUE.has(a) || ["--model", "--effort", "--settings", "--permission-mode"].includes(a)) { out.push(a, rest[++i]); continue; }
    } else if (kind === "omp") {
      if (a === "--resume" || a === "-r" || a === "--session" || a === "--fork" || a === "--restore") { resumed = true; if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if (/^--(resume|session|fork|restore)=/.test(a)) { resumed = true; continue; }
      if (a === "--continue" || a === "-c") { resumed = true; continue; }
      if (OMP_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a === "--model" || a === "--thinking" || a === "--approval-mode") { out.push(a, rest[++i]); continue; }
    } else {
      if (i === 0 && (a === "resume" || a === "fork")) { resumed = true; continue; }
      if (a === "--last") continue;
      if (CODEX_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
    }
    // A word that isn't a flag or a flag's value: the session's id or a first message.
    if (a.startsWith("-")) out.push(a);
  }
  return { out: out.filter((x) => x !== undefined), resumed };
}

// How to start the chosen agent: { argv, resume } (resume: argv already continues the session).
// `session`: the old conversation's id when it can be resumed (same agent only).
export function argvFor(pick, old) {
  const same = pick.agent === old.agent;
  const flags = same ? kept(pick.agent, old.argv ?? []) : [];
  if (pick.agent === "claude") {
    const a = ["claude", ...flags];
    if (pick.model) a.push("--model", pick.model);
    if (pick.effort) a.push("--effort", pick.effort);
    a.push("--settings", JSON.stringify({ fastMode: Boolean(pick.fast) }));
    if (pick.perm === "bypassPermissions") a.push("--dangerously-skip-permissions");
    else if (pick.perm) a.push("--permission-mode", pick.perm === "manual" ? "default" : pick.perm);
    if (same && old.session) return { argv: [...a, "--resume", old.session], resume: true, base: a };
    return { argv: a, resume: false, base: a };
  }
  if (pick.agent === "omp") {
    const a = ["omp", ...flags];
    if (pick.model) a.push("--model", pick.model);
    if (pick.effort) a.push("--thinking", pick.effort);
    if (pick.perm) a.push("--approval-mode", pick.perm);
    if (same && old.session) return { argv: [...a, "--resume", old.session], resume: true, base: a };
    return { argv: a, resume: false, base: a };
  }
  // Codex runs its commands outside hc without --no-daemon (as herdr-task and restart.sh add).
  const a = [...flags, "--no-daemon"];
  if (pick.model) a.push("-m", pick.model);
  if (pick.effort) a.push("-c", `model_reasoning_effort="${pick.effort}"`);
  // always said, so Fast off wins over a service_tier in config.toml (default: the standard tier)
  a.push("-c", `service_tier="${pick.fast ? "fast" : "default"}"`);
  if (pick.perm === "full") a.push("--dangerously-bypass-approvals-and-sandbox");
  else if (pick.perm === "read-only") a.push("-s", "read-only", "-a", "on-request");
  else if (pick.perm) a.push("-s", "workspace-write", "-a", "on-request");
  if (same && old.session) return { argv: ["codex", "resume", ...a, old.session], resume: true, base: ["codex", ...a] };
  return { argv: ["codex", ...a], resume: false, base: ["codex", ...a] };
}

// The conversation's id, from its log's file name (OMP: <timestamp>_<uuid>.jsonl).
export function sessionOf(kind, path) {
  const m = kind === "claude" ? /([0-9a-f-]{36})\.jsonl$/.exec(path ?? "") : /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path ?? "");
  return m ? m[1] : null;
}

// The same conversation again, after its agent ended (an Assistant's /exit, GitHub #1039): its own flags, model, effort
// and speed, resuming `session`.
export function resumeArgv(kind, argv, session) {
  const out = stripSession(kind, argv)?.out ?? [kind];
  if (kind === "claude") return [...out, "--resume", session];
  if (kind === "omp") return [...out, "--resume", session];
  return [out[0], "resume", ...out.slice(1), session];
}

// A copy of the conversation in a new tab beside this one, through the CLI's own fork. OMP 18 has no fork flag:
// Shepherdr doesn't offer one (canFork), and this returns null rather than inventing a new conversation.
export const canFork = (kind) => kind === "claude" || kind === "codex";
// The CLI's own rewind on one of the person's messages: Claude Code's /rewind, Codex's Esc Esc. OMP has neither.
export const canRewind = (kind) => kind === "claude" || kind === "codex";
export function forkArgv(kind, argv, session) {
  if (!canFork(kind)) return null;
  argv = argv ?? [];
  // The same model, effort and speed as the original.
  const same = kind === "claude"
    ? ["--model", "--effort", "--settings"].flatMap((f) => { const v = flag(argv, f); return v ? [f, v] : []; })
    : (() => {
      const m = flag(argv, "-m", "--model"), o = overrides(argv);
      return [...(m ? ["-m", m] : []), "--no-daemon",
        ...["model_reasoning_effort", "service_tier"].flatMap((k) => (o[k] ? ["-c", `${k}="${o[k]}"`] : []))];
    })();
  const flags = [...kept(kind, argv), ...same];
  return kind === "claude" ? ["claude", ...flags, "--resume", session, "--fork-session"] : ["codex", "fork", ...flags, session];
}

// #1050: a fork of a task's conversation while the task's agent runs works in the same folder, so two agents would
// edit one worktree. The task's live agent (a terminal record from `all`, reviewers and helpers aside) when `t` is a
// task's terminal, else null: the fork then asks first (FORK_LIVE).
const AGENT_APPS = new Set(["claude-code", "claude", "codex", "omp", "oh-my-pi"]);
export function liveTaskAgent(t, all) {
  const task = t?.labels?.["herdr.task"];
  if (!task) return null;
  return [...(all ?? [])].find((k) => k?.state === "live" && k.labels?.["herdr.task"] === task
    && !["reviewer", "helper"].includes(k.labels?.["herdr.role"])
    // an agent runs there (a record that doesn't say what runs counts: better to ask once too often)
    && (AGENT_APPS.has(k.status?.app) || AGENT_APPS.has(k.foreground?.name) || (!k.status?.app && !k.foreground))) ?? null;
}
// The ask, in the window's confirm and the web's alike: keep the live agent (Cancel) or fork anyway.
export const FORK_LIVE = {
  title: "This task's agent is still running",
  detail: "A fork starts a second agent in the task's folder, and both would edit the same files. Keep working with the live one, or fork anyway.",
  verb: "Fork anyway",
  cancel: "Keep the live one",
};
