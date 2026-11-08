// Claude Activity: reads Claude Code's own local records (session transcripts,
// memory files, agents, scheduled tasks, MCP config) into one summary for the
// dashboard. Read-only: it never writes to ~/.claude. Each transcript is re-parsed
// only when it changes.
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJECTS = path.join(CLAUDE_DIR, "projects");
// Claude Activity's own small data folder (review results, an optional usage snapshot).
const DATA_DIR = process.env.CA_DATA_DIR || path.join(HOME, ".claude-activity");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const REVIEWS_FILE = path.join(DATA_DIR, "reviews.json");

// Anything that looks like a credential is masked before it leaves this module.
const SECRET_PATTERNS = [
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,                 // chat-bot tokens (Telegram style)
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,                      // Anthropic keys
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,                 // GitHub tokens
  /((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)["']?[^\s"'&]{6,}/gi,
];
const redact = (s) => SECRET_PATTERNS.reduce((t, re) => t.replace(re, (m, p1) => (typeof p1 === "string" && /[=:]\s*$/.test(p1) ? `${p1}•••` : "•••redacted•••")), String(s ?? ""));
const clip = (s, n) => { s = redact(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// One line describing what a tool call did.
function describeTool(name, input = {}) {
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === "string" && v);
  if (/^(Write|Edit|Read|NotebookEdit)$/.test(name)) return pick("file_path", "notebook_path") || "";
  if (/^(Bash|PowerShell)$/.test(name)) return pick("description") || pick("command") || "";
  if (/^(Glob|Grep)$/.test(name)) return [pick("pattern"), pick("path")].filter(Boolean).join("  in ");
  if (name === "WebSearch") return pick("query") || "";
  if (name === "WebFetch") return pick("url") || "";
  if (name === "Agent" || name === "Task") return pick("description") || "";
  if (name === "Skill") return pick("skill") || "";
  if (name === "ToolSearch") return pick("query") || "";
  const first = Object.values(input).find((v) => typeof v === "string" && v.length < 400);
  return first || "";
}
const toolCategory = (name) => name.startsWith("mcp__") ? `mcp:${name.split("__")[1]}` : name;
// A project's display name: its folder relative to the home folder ("code/my-app"), worktrees marked.
const projectName = (cwd) => {
  if (!cwd) return "?";
  if (/scratch-workspaces/i.test(cwd)) return "Scratch workspace";
  const rel = path.relative(HOME, cwd);
  const name = (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : cwd).replace(/[\\/]\.claude[\\/]worktrees[\\/]/i, " · worktree ");
  return name || "~";
};
// Claude Code names a project's folder under ~/.claude/projects after its path ("C--Users-me-code-app").
const ENCODED_HOME = HOME.replace(/[:\\/. ]/g, "-");
// Friendly names for the MCP servers built into the Claude desktop app.
const MCP_LABELS = {
  ccd_turn: "Claude app · task list & wrap-up", ccd_session: "Claude app · sessions", ccd_session_mgmt: "Claude app · session management",
  ccd_settings: "Claude app · settings", ccd_directory: "Claude app · folders", ccd_host: "Claude app · host", ccd_view: "Claude app · panes",
  ccd_pr: "Claude app · pull requests", ccd_sidebar: "Claude app · sidebar", ccd_window: "Claude app · windows", ccd_connectors: "Claude app · connectors",
  Claude_Browser: "Built-in browser", terminal: "Terminal panel", "scheduled-tasks": "Scheduled tasks", visualize: "Inline visuals",
  "claude-in-chrome": "Claude in Chrome", "mcp-registry": "Connector registry", voicestudio: "VoiceStudio",
  "1a59c906-04da-521d-bda7-7f71b9f9e01c": "Claude Docs",
};

// ---------- code changes (Edit / Write / MultiEdit / NotebookEdit) ----------
const CODE_MAX = 16000; // characters kept per side of a change
const keep = (s) => redact(String(s ?? "").slice(0, CODE_MAX)) + (String(s ?? "").length > CODE_MAX ? "\n… (truncated)" : "");
function codeChange(b, at) {
  const i = b.input || {};
  const file = i.file_path || i.notebook_path;
  if (!file) return null;
  const base = { id: b.id, at, tool: b.name, file };
  if (b.name === "Write") return { ...base, parts: [{ old: "", new: keep(i.content) }], write: true };
  if (b.name === "Edit") return { ...base, parts: [{ old: keep(i.old_string), new: keep(i.new_string) }], replaceAll: !!i.replace_all };
  if (b.name === "MultiEdit" && Array.isArray(i.edits)) return { ...base, parts: i.edits.slice(0, 20).map((e) => ({ old: keep(e.old_string), new: keep(e.new_string) })) };
  if (b.name === "NotebookEdit") return { ...base, parts: [{ old: "", new: keep(i.new_source) }] };
  return null;
}
const splitLines = (s) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));
// Line diff (LCS). Big inputs fall back to "all removed, then all added".
function lineDiff(a, b) {
  const A = splitLines(a), B = splitLines(b);
  if (A.length * B.length > 400000) return [...A.map((s) => ({ t: "-", s })), ...B.map((s) => ({ t: "+", s }))];
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) L[x][y] = A[x] === B[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
  const out = []; let x = 0, y = 0;
  while (x < n && y < m) {
    if (A[x] === B[y]) { out.push({ t: " ", s: A[x] }); x++; y++; }
    else if (L[x + 1][y] >= L[x][y + 1]) out.push({ t: "-", s: A[x++] });
    else out.push({ t: "+", s: B[y++] });
  }
  while (x < n) out.push({ t: "-", s: A[x++] });
  while (y < m) out.push({ t: "+", s: B[y++] });
  return out;
}
// Where the new text sits in the file today, so line numbers match the real file.
function startLine(file, text) {
  if (!text) return 1;
  const st = statOf(file);
  if (!st || st.size > 3e6) return null;
  const body = readText(file).replace(/\r\n/g, "\n");
  const at = body.indexOf(text.replace(/\r\n/g, "\n"));
  return at < 0 ? null : body.slice(0, at).split("\n").length;
}
const LANGS = { js: "js", mjs: "js", cjs: "js", ts: "ts", tsx: "ts", jsx: "js", json: "json", html: "html", htm: "html", css: "css", md: "md", py: "py", cmd: "bat", bat: "bat", ps1: "ps", vbs: "vbs", sh: "sh", yml: "yaml", yaml: "yaml" };
const diffCache = new Map();
// Claude Code records the exact patch it applied (real line numbers, 3 lines of context).
// Rewrites, edits and multi-edits all use it; older records fall back to diffing the input.
function patchHunks(patch) {
  return patch.map((h) => ({ start: h.newStart, lines: h.lines.map((l) => ({ t: l[0] === "+" ? "+" : l[0] === "-" ? "-" : "c", s: l.slice(1) })) }));
}
function keepPatch(patch) {
  let budget = 2000;
  const out = [];
  for (const h of patch) {
    if (budget <= 0) break;
    const lines = (h.lines || []).slice(0, budget).map((l) => redact(String(l).slice(0, 1000)));
    budget -= lines.length;
    out.push({ newStart: h.newStart, lines });
  }
  return out;
}
// Fallback for old records: find the change by a distinctive line when the exact text has moved on.
function anchorLine(file, text) {
  const lines = readText(file).replace(/\r\n/g, "\n").split("\n");
  const mine = splitLines(text);
  for (let k = 0; k < mine.length; k++) {
    const t = mine[k];
    if (t.trim().length < 8 || t.includes("•••")) continue;
    const hits = lines.reduce((a, l, i) => (l === t ? [...a, i] : a), []);
    if (hits.length === 1) return hits[0] - k + 1;
  }
  return null;
}
function codeDetail(e) {
  const ck = `${e.id}|${e.patch ? 1 : 0}`; // re-diff once the exact patch is recorded
  if (diffCache.has(ck)) return diffCache.get(ck);
  if (e.patch?.length) {
    const hunks = patchHunks(e.patch);
    const count = (t) => hunks.reduce((n, h) => n + h.lines.filter((l) => l.t === t).length, 0);
    const d = { hunks, added: count("+"), removed: count("-"), lang: LANGS[path.extname(e.file).slice(1).toLowerCase()] || "text" };
    diffCache.set(ck, d);
    return d;
  }
  let fileLines = null;
  const hunks = e.parts.map((p) => {
    const lines = lineDiff(p.old, p.new);
    let start = e.write ? 1 : startLine(e.file, p.new) ?? (statOf(e.file) ? anchorLine(e.file, p.new) : null);
    // Three lines of the real file around the change, dimmed on screen.
    if (start && !e.write) {
      fileLines ??= readText(e.file).replace(/\r\n/g, "\n").split("\n");
      const before = fileLines.slice(Math.max(0, start - 4), start - 1).map((s) => ({ t: "c", s: redact(s) }));
      const end = start - 1 + splitLines(p.new).length;
      const after = fileLines.slice(end, end + 3).map((s) => ({ t: "c", s: redact(s) }));
      start -= before.length;
      return { lines: [...before, ...lines, ...after], start };
    }
    return { lines, start };
  });
  const added = hunks.reduce((n, h) => n + h.lines.filter((l) => l.t === "+").length, 0);
  const removed = hunks.reduce((n, h) => n + h.lines.filter((l) => l.t === "-").length, 0);
  const d = { hunks, added, removed, lang: LANGS[path.extname(e.file).slice(1).toLowerCase()] || "text" };
  diffCache.set(ck, d);
  if (diffCache.size > 500) diffCache.delete(diffCache.keys().next().value);
  return d;
}
const editIndex = new Map(); // id -> {edit, sessionTitle}

// ---------- watched repos: uncommitted git changes ----------
// Changes made outside Claude's Edit/Write tools (git apply, the owner's own edits) never
// appear in a transcript. For these repos, each changed file's uncommitted diff becomes a
// Code screen entry, so it gets reviewed like any other change. Opt in with
// CA_WATCH_REPOS="C:\code\app;C:\code\site" (separate paths with ; or ,).
const WATCHED_REPOS = (process.env.CA_WATCH_REPOS || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  .map((dir) => ({ dir: path.resolve(dir), app: path.basename(path.resolve(dir)) }));
const GIT = [path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe"), "git"].find((g) => g === "git" || statOf(g));
const GIT_SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(png|jpe?g|gif|ico|webp|mp4|woff2?|lock)$/i;
const firstSeen = new Map();  // change id -> when it was first seen
let gitCache = { at: 0, list: [] };

function parseUnified(text) {
  const files = [];
  let cur = null, hunk = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) { cur = { file: null, hunks: [] }; files.push(cur); hunk = null; continue; }
    if (!cur) continue;
    if (line.startsWith("+++ ")) { cur.file = line.slice(4).replace(/^b\//, ""); continue; }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { hunk = { newStart: +m[1], lines: [] }; cur.hunks.push(hunk); continue; }
    if (hunk && /^[ +-]/.test(line) && !line.startsWith("--- ")) hunk.lines.push(line);
  }
  return files.filter((f) => f.file && f.file !== "/dev/null" && f.hunks.length);
}

function gitChanges() {
  if (Date.now() - gitCache.at < 30000) return gitCache.list;
  const { execFileSync } = require("child_process");
  const run = (dir, args) => execFileSync(GIT, ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 15000, windowsHide: true });
  const list = [];
  for (const repo of WATCHED_REPOS) {
    if (!statOf(path.join(repo.dir, ".git"))) continue;
    let changed = [];
    try { changed = parseUnified(run(repo.dir, ["diff", "--no-color", "--no-ext-diff", "--unified=3"])); } catch { continue; }
    // New files git doesn't track yet: the whole file is the change.
    try {
      for (const rel of run(repo.dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((s) => s.trim()).filter(Boolean)) {
        const abs = path.join(repo.dir, rel), st = statOf(abs);
        if (!st || st.size > 200000) continue;
        const text = readText(abs);
        if (text.includes("\u0000")) continue; // binary
        changed.push({ file: rel, hunks: [{ newStart: 1, lines: splitLines(text).map((l) => "+" + l) }], created: true });
      }
    } catch { /* keep the tracked changes */ }
    const add = (f, opts) => {
      if (GIT_SKIP.test(f.file)) return;
      const abs = path.join(repo.dir, f.file.replace(/\//g, path.sep));
      const patch = keepPatch(f.hunks);
      const hash = require("crypto").createHash("sha1").update(JSON.stringify(patch)).digest("hex").slice(0, 12);
      const id = `git:${repo.app}:${opts.commit || "wt"}:${f.file}:${hash}`;
      if (!firstSeen.has(id)) firstSeen.set(id, opts.at || new Date().toISOString());
      list.push({ e: { id, at: firstSeen.get(id), tool: opts.tool, file: abs, patch, parts: [], write: !!f.created, rewrite: false, commit: opts.commit },
        owner: opts.commit ? `git:${repo.app} · commit ${opts.commit}` : `git:${repo.app}`, sub: false });
    };
    for (const f of changed) add(f, { tool: f.created ? "New file" : "Git change" });
    // Recent commits (last 48 h): changes that were committed without passing through Claude's edit tools.
    try {
      const commits = run(repo.dir, ["log", "--since=48.hours", "--no-merges", "--format=%h|%cI", "-n", "10"]).split("\n").filter(Boolean);
      for (const c of commits) {
        const [hash, at] = c.split("|");
        const files = parseUnified(run(repo.dir, ["show", "--no-color", "--no-ext-diff", "--unified=3", "--format=", hash]));
        for (const f of files.slice(0, 40)) add(f, { commit: hash, at: new Date(at).toISOString(), tool: "Commit" });
      }
    } catch { /* not fatal */ }
  }
  gitCache = { at: Date.now(), list };
  return list;
}

// ---------- plan usage: live estimate + per-model split ----------
// Plan limits are cost-based. A turn's weight follows API price ratios: cache reads are
// cheap, output is ~5x input, and Opus-class models cost more than Sonnet or Haiku.
// Only the ratios matter, because the estimate is calibrated against a real reading.
const modelWeight = (m) => /opus|fable/i.test(m || "") ? 5 : /haiku/i.test(m || "") ? 1 : 3;
function turnCost(model, t) {
  if (!model || model === "<synthetic>") return 0;
  return (t.input + 1.25 * t.cacheWrite + 0.1 * t.cacheRead + 5 * t.output) * modelWeight(model);
}
// "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5"
function modelName(id) {
  const m = String(id || "").replace(/^claude-/, "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  const [fam, ...ver] = m.split("-");
  return fam ? fam[0].toUpperCase() + fam.slice(1) + (ver.length ? " " + ver.join(".") : "") : "Unknown";
}
// Between real readings, project each window forward from the cost of Claude Code activity
// since the reading (calibrated: % per unit of cost in that window so far). The projection
// snaps back to the truth whenever a session saves a new reading.
function liveUsage(all, snap) {
  if (!snap?.windows?.length) return snap;
  // AI code reviews keep no transcript; their recorded token use counts too.
  const reviewTurns = (readJson(REVIEWS_FILE, {}).reviews || [])
    .flatMap((r) => Object.entries(r.usage || {}).map(([model, t]) => ({ at: r.finishedAt || r.at, model, cost: turnCost(model, t) })));
  const turns = [...all.flatMap((s) => s.turns), ...reviewTurns].filter((t) => t.cost > 0).map((t) => ({ ...t, ms: new Date(t.at).getTime() }));
  const now = Date.now(), at = new Date(snap.at).getTime();
  const costIn = (a, b) => turns.reduce((n, t) => (t.ms >= a && t.ms < b ? n + t.cost : n), 0);
  const split = (a, b) => {
    const by = {};
    for (const t of turns) if (t.ms >= a && t.ms < b) by[modelName(t.model)] = (by[modelName(t.model)] || 0) + t.cost;
    const total = Object.values(by).reduce((x, y) => x + y, 0);
    return total ? Object.entries(by).map(([model, c]) => ({ model, share: c / total })).sort((x, y) => y.share - x.share) : [];
  };
  const windows = snap.windows.map((w) => {
    const span = /week/i.test(w.label) ? 7 * 864e5 : 5 * 36e5;
    let reset = new Date(w.resetsAt).getTime(), start = reset - span;
    const calib = costIn(start, Math.min(at, reset));
    const rate = calib > 0 && w.percentUsed > 0 ? w.percentUsed / calib : null;
    let pct = w.percentUsed, estimated = false, rolled = false;
    if (now >= reset) {
      // The window has reset since the reading. A 5-hour window restarts at the first message after the reset.
      rolled = true; estimated = true;
      if (span < 864e5) {
        const first = turns.filter((t) => t.ms >= reset).reduce((m, t) => Math.min(m, t.ms), Infinity);
        start = Number.isFinite(first) ? first : now;
        reset = Number.isFinite(first) ? first + span : null;
      } else { start = reset; reset += span; }
      pct = rate ? rate * costIn(start, now) : 0;
    } else if (rate && now > at) {
      const projected = rate * costIn(start, now);
      if (projected - w.percentUsed >= 0.5) { pct = projected; estimated = true; }
    }
    return { ...w, measured: w.percentUsed, measuredAt: snap.at, percentUsed: Math.min(100, Math.round(pct)),
      estimated, rolled, resetsAt: reset ? new Date(reset).toISOString() : null, models: split(start, now) };
  });
  return { ...snap, windows };
}

// ---------- token attribution ----------
// Anthropic's usage records give exact tokens per model turn: input, cache write, cache read,
// output. They don't say which part of a turn was which, so the split below is estimated from
// content sizes and always adds back up to the exact totals:
//   new context (input + cache write) → what was added since the last turn: each tool's results,
//     the owner's messages, system reminders, the previous reply re-sent; what's left over on a
//     session's first turn is its setup (system prompt, tools, memory files)
//   output → the reply text, each tool call's input, and thinking (whatever the visible text
//     doesn't account for: thinking is mostly not stored in the transcript)
//   cache read → re-reading the conversation history (the whole prefix, every turn)
const CHARS_PER_TOKEN = 3.6, IMAGE_TOKENS = 1500;
const estTokens = (chars, images = 0) => chars / CHARS_PER_TOKEN + images * IMAGE_TOKENS;

// After more than ~5 minutes idle the prompt cache has expired, so the next turn re-sends the whole
// conversation as new context: that leftover is "recache", not unexplained.
const CACHE_TTL_MS = 5 * 60000;
function attributeContext(items, t, firstTurn, gapMs = 0) {
  const total = t.input + t.cacheWrite, out = {};
  if (!total) return out;
  const est = items.map((i) => ({ label: i.label, tok: estTokens(i.chars, i.images) }));
  const sum = est.reduce((n, i) => n + i.tok, 0);
  const scale = sum > total ? total / sum : 1;
  for (const i of est) out[i.label] = (out[i.label] || 0) + i.tok * scale;
  const rest = total - Math.min(sum, total);
  const why = firstTurn ? "setup" : gapMs > CACHE_TTL_MS ? "recache" : "other";
  if (rest > 0.5) out[why] = (out[why] || 0) + rest;
  return out;
}
function attributeOutput(outChars, output) {
  const res = {};
  if (!output) return res;
  const visible = Object.entries(outChars).filter(([k]) => k !== "thinking");
  const sum = visible.reduce((n, [, c]) => n + c / CHARS_PER_TOKEN, 0);
  const scale = sum > output ? output / sum : 1;
  for (const [k, c] of visible) res[k] = (c / CHARS_PER_TOKEN) * scale;
  const rest = output - Math.min(sum, output);
  if (rest > 0.5) res.thinking = rest;
  return res;
}

// Exact totals and estimated attribution for one period, grouped every way the panel shows.
function usageBreakdown(all, ownerOf, startMs, bucketMs, reviewTurns) {
  const now = Date.now();
  const nb = Math.max(1, Math.ceil((now - startMs) / bucketMs));
  // Every group keeps tokens and estimated cost per token type (cost = API price ratios × model).
  const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, c: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const totals = empty(), byModel = {}, byProject = {}, bySession = {}, actions = {};
  const buckets = Array.from({ length: nb }, (_, i) => ({ t: new Date(startMs + i * bucketMs).toISOString(), ...empty() }));
  const PRICE = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
  const add = (o, t, cost, w) => {
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) { o[k] += t[k]; o.c[k] += t[k] * PRICE[k] * w; }
    o.cost += cost; o.turns++;
  };
  const act = (key, tool, part, tokens, cost) => {
    const a = (actions[key] ??= { key, tool, output: 0, context: 0, cacheRead: 0, cost: 0, c: { output: 0, context: 0, cacheRead: 0 } });
    a[part] += tokens; a.cost += cost; a.c[part] += cost;
  };
  const visit = (turn, owner) => {
    const ms = new Date(turn.at).getTime();
    if (!(ms >= startMs) || !turn.model || turn.model === "<synthetic>") return;
    const t = turn.t, w = modelWeight(turn.model);
    const cost = turnCost(turn.model, t);
    add(totals, t, cost, w);
    add(byModel[modelName(turn.model)] ??= empty(), t, cost, w);
    add(byProject[owner.project] ??= empty(), t, cost, w);
    const sess = (bySession[owner.id] ??= { ...empty(), title: owner.title, kind: owner.kind, project: owner.project, first: owner.first });
    add(sess, t, cost, w);
    const b = buckets[Math.min(nb - 1, Math.floor((ms - startMs) / bucketMs))];
    if (b) add(b, t, cost, w);
    // Attribution: output, new context and cache reads, each at its own price
    for (const [k, v] of Object.entries(turn.outParts || attributeOutput(turn.out || {}, t.output))) {
      const tool = k.startsWith("tool:") ? k.slice(5) : null;
      act(tool ? `tool:${tool}` : k, tool, "output", v, v * 5 * w);
    }
    const ctxRate = t.input + t.cacheWrite ? ((t.input + 1.25 * t.cacheWrite) / (t.input + t.cacheWrite)) * w : 0;
    for (const [k, v] of Object.entries(turn.ctx || {})) {
      const tool = k.startsWith("result:") ? k.slice(7) : null;
      act(tool ? `tool:${tool}` : k, tool, "context", v, v * ctxRate);
    }
    if (t.cacheRead) act("history", null, "cacheRead", t.cacheRead, t.cacheRead * 0.1 * w);
  };
  for (const s of all) { const owner = ownerOf(s); for (const turn of s.ut) visit(turn, owner); }
  for (const turn of reviewTurns) visit(turn, { id: "ai-reviews", title: "AI code reviews & fixes", kind: "Claude Activity", project: "Claude Activity" });
  const tokensOf = (x) => x.input + x.output + x.cacheRead + x.cacheWrite;
  const list = (o) => Object.entries(o).map(([name, v]) => ({ name, ...v, tokens: tokensOf(v) })).sort((a, b) => b.cost - a.cost);
  return {
    start: new Date(startMs).toISOString(), bucketMs, totals: { ...totals, tokens: tokensOf(totals) },
    byModel: list(byModel), byProject: list(byProject),
    bySession: Object.entries(bySession).map(([id, v]) => ({ id, ...v, tokens: tokensOf(v) })).sort((a, b) => b.cost - a.cost).slice(0, 15),
    actions: Object.values(actions).map((a) => ({ ...a, tokens: a.output + a.context + a.cacheRead })).sort((a, b) => b.cost - a.cost),
    buckets,
  };
}

// ---------- transcripts ----------
const cache = new Map(); // file -> {mtimeMs, size, data}

function listTranscripts() {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== "memory") walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(PROJECTS, 0);
  return out;
}

function parseTranscript(file) {
  const s = { file, id: path.basename(file, ".jsonl"), cwd: null, title: null, aiTitle: null, first: null, last: null,
    models: {}, prompts: [], tools: {}, actions: [], files: new Set(), tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    webSearches: 0, byDay: {}, turns: [], sidechain: false, source: null, edits: [], ut: [] };
  const seen = new Set();
  const editById = new Map();
  // Token attribution (see usageTurn below): what was added to the context since the last
  // model turn, which turn each repeated transcript line belongs to, and tool names by id.
  let pending = [];
  const turnByKey = new Map();
  const toolNameById = new Map();
  for (const line of readText(file).split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd) s.cwd = o.cwd; // the latest folder the session worked in
    if (o.isSidechain) s.sidechain = true;
    if (o.timestamp) { if (!s.first || o.timestamp < s.first) s.first = o.timestamp; if (!s.last || o.timestamp > s.last) s.last = o.timestamp; }
    if (o.type === "custom-title" && o.customTitle) s.title = o.customTitle;
    if (o.type === "ai-title" && o.aiTitle) s.aiTitle = o.aiTitle;
    if (o.type === "user" && o.message) {
      const c = o.message.content;
      // Everything this message adds to the context, by source (sized in characters; images by count).
      const meta = o.isMeta || (typeof c === "string" && /^\s*<(system-reminder|command|local-command|task-notification)/.test(c));
      if (typeof c === "string") pending.push({ label: meta ? "reminders" : "prompt", chars: c.length, images: 0 });
      else if (Array.isArray(c)) for (const b of c) {
        if (b.type === "tool_result") {
          const parts = Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }];
          pending.push({ label: `result:${toolNameById.get(b.tool_use_id) || "unknown"}`,
            chars: parts.reduce((n, p) => n + (p.type === "text" ? (p.text || "").length : 0), 0), images: parts.filter((p) => p.type === "image").length });
        } else if (b.type === "text") {
          pending.push({ label: o.isMeta || /^\s*<(system-reminder|command|local-command|task-notification)/.test(b.text || "") ? "reminders" : "prompt", chars: (b.text || "").length, images: 0 });
        } else if (b.type === "image") pending.push({ label: "prompt", chars: 0, images: 1 });
      }
      // Tool results: drop edits that failed, attach the exact patch to the ones that landed.
      if (Array.isArray(c)) for (const b of c) {
        const edit = b.type === "tool_result" && editById.get(b.tool_use_id);
        if (!edit) continue;
        const r = o.toolUseResult;
        if (b.is_error || typeof r === "string") { s.edits = s.edits.filter((x) => x !== edit); continue; }
        if (Array.isArray(r?.structuredPatch) && r.structuredPatch.length) edit.patch = keepPatch(r.structuredPatch);
        if (edit.write) edit.rewrite = r?.type === "update";
      }
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
      // Fix jobs started from the review bar begin with this tag.
      if (s.source === null) s.source = /^\[Apply review/.test(text) ? "ai-fix" : "session";
      if (text && !o.isMeta && !/^<(command|local-command|system-reminder|task-notification)/.test(text.trim()) && !(Array.isArray(c) && c.some((b) => b.type === "tool_result"))) {
        s.prompts.push({ at: o.timestamp, text: clip(text, 240) });
      }
    }
    if (o.type === "assistant" && o.message) {
      const m = o.message;
      const key = `${m.id || ""}|${o.requestId || ""}`;
      if (m.usage && !seen.has(key)) {
        seen.add(key);
        const u = m.usage;
        const t = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
        for (const k in t) s.tokens[k] += t[k];
        s.webSearches += u.server_tool_use?.web_search_requests || 0;
        const day = localDay(o.timestamp);
        const d = (s.byDay[day] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
        for (const k in t) d[k] += t[k];
        d.turns++;
        s.turns.push({ at: o.timestamp, output: t.output, model: m.model, cost: turnCost(m.model, t) });
        if (m.model && m.model !== "<synthetic>") s.models[m.model] = (s.models[m.model] || 0) + 1;
        const prevAt = s.ut.length ? new Date(s.ut[s.ut.length - 1].at).getTime() : null;
        const ut = { at: o.timestamp, model: m.model, t, out: {},
          ctx: attributeContext(pending, t, s.ut.length === 0, prevAt == null ? 0 : new Date(o.timestamp).getTime() - prevAt) };
        pending = [];
        s.ut.push(ut);
        turnByKey.set(key, ut);
      }
      const cur = turnByKey.get(key); // one turn is spread over several lines, one per content block
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (cur) {
          const label = b.type === "text" ? "reply" : b.type === "thinking" || b.type === "redacted_thinking" ? "thinking" : b.type === "tool_use" ? `tool:${b.name}` : null;
          const chars = b.type === "text" ? (b.text || "").length : b.type === "thinking" ? (b.thinking || "").length : b.type === "tool_use" ? JSON.stringify(b.input || {}).length : 0;
          if (label) cur.out[label] = (cur.out[label] || 0) + chars;
          // Next turn, this output is sent back as part of the context
          if (label && label !== "thinking") pending.push({ label: "resent", chars, images: 0 });
        }
        if (b.type === "tool_use") toolNameById.set(b.id, b.name);
        if (b.type !== "tool_use") continue;
        s.tools[b.name] = (s.tools[b.name] || 0) + 1;
        const summary = clip(describeTool(b.name, b.input), 160);
        s.actions.push({ at: o.timestamp, tool: b.name, summary });
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name) && summary) s.files.add(summary);
        const edit = codeChange(b, o.timestamp);
        if (edit) { s.edits.push(edit); editById.set(b.id, edit); if (s.edits.length > 200) s.edits.shift(); }
      }
    }
  }
  s.files = [...s.files];
  return s;
}

function sessions() {
  const out = [];
  const live = new Set();
  for (const file of listTranscripts()) {
    live.add(file);
    const st = statOf(file);
    if (!st) continue;
    let c = cache.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      c = { mtimeMs: st.mtimeMs, size: st.size, data: parseTranscript(file) };
      cache.set(file, c);
    }
    out.push(c.data);
  }
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  return out;
}

// ---------- config & context ----------
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

function fileCard(p, label) {
  const st = statOf(p);
  if (!st) return null;
  const text = readText(p);
  return { path: p, label: label || path.basename(p), size: st.size, modified: st.mtime, content: redact(text.slice(0, 20000)) };
}

function memoryFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch {}
  for (const d of dirs) {
    const mem = path.join(PROJECTS, d, "memory");
    let files = [];
    try { files = fs.readdirSync(mem).filter((f) => f.endsWith(".md")); } catch { continue; }
    const project = d.slice(d.toLowerCase().startsWith(ENCODED_HOME.toLowerCase()) ? ENCODED_HOME.length : 0).replace(/^-+/, "").replace(/^AppData-Local-Claude-Data-.*scratch-(\d{4}-\d{2}-\d{2}).*/, "scratch workspace $1").replace(/^Claude-/, "");
    for (const f of files) {
      const card = fileCard(path.join(mem, f));
      if (card) out.push({ ...card, scope: `Claude memory · ${project}`, ...frontmatter(card.content).meta });
    }
  }
  return out.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function contextFiles(cwds) {
  const candidates = new Set([path.join(CLAUDE_DIR, "CLAUDE.md")]);
  for (const cwd of cwds) for (const n of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]) candidates.add(path.join(cwd, n));
  return [...candidates].map((p) => fileCard(p, p.replace(HOME, "~"))).filter(Boolean);
}

function agents(cwds) {
  const dirs = [path.join(CLAUDE_DIR, "agents"), ...cwds.map((c) => path.join(c, ".claude", "agents"))];
  const out = [];
  for (const dir of new Set(dirs)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      const text = readText(path.join(dir, f));
      const { meta, body } = frontmatter(text);
      out.push({ ...meta, path: path.join(dir, f).replace(HOME, "~"), scope: dir.startsWith(CLAUDE_DIR) ? "All projects" : dir, body: redact(body.slice(0, 6000)) });
    }
  }
  return out;
}

function scheduledTasks(allSessions) {
  const dir = path.join(CLAUDE_DIR, "scheduled-tasks");
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names.map((n) => {
    const { meta, body } = frontmatter(readText(path.join(dir, n, "SKILL.md")));
    return { id: n, name: meta.name || n, description: meta.description || "", prompt: redact(body.slice(0, 4000)) };
  });
}

function mcpServers(cwds, toolTotals) {
  const cfg = readJson(path.join(HOME, ".claude.json"), {});
  const servers = {};
  const add = (name, v, scope) => { servers[name] = { name, scope, type: v.type || (v.command ? "stdio" : "http"), target: v.url || [v.command, ...(v.args || [])].join(" ") }; };
  for (const [k, v] of Object.entries(cfg.mcpServers || {})) add(k, v, "User (all projects)");
  for (const [p, pv] of Object.entries(cfg.projects || {})) for (const [k, v] of Object.entries(pv.mcpServers || {})) add(k, v, p);
  for (const cwd of cwds) for (const [k, v] of Object.entries(readJson(path.join(cwd, ".mcp.json"), {}).mcpServers || {})) add(k, v, cwd);
  // Every MCP server Claude actually called, including the app's built-in ones.
  const used = {};
  for (const [tool, n] of Object.entries(toolTotals)) {
    if (!tool.startsWith("mcp__")) continue;
    const [, server, ...rest] = tool.split("__");
    (used[server] ??= { server, label: MCP_LABELS[server] || server, calls: 0, tools: {} }).calls += n;
    used[server].tools[rest.join("__")] = n;
  }
  return { configured: Object.values(servers), used: Object.values(used).sort((a, b) => b.calls - a.calls), skillUsage: cfg.skillUsage || {} };
}

// ---------- summary ----------
function buildSummary() {
  const all = sessions();
  const toolTotals = {}, byDay = {}, totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, toolCalls: 0, prompts: 0 };
  const cwds = new Set();
  // Subagent transcripts live in a folder named after their parent session.
  const parentOf = (s) => { const dir = path.basename(path.dirname(s.file)); return /^[0-9a-f-]{36}$/.test(dir) ? dir : path.basename(path.dirname(path.dirname(s.file))).match(/^[0-9a-f-]{36}$/)?.[0] || null; };
  const main = new Map();
  for (const s of all) {
    if (s.cwd) cwds.add(s.cwd);
    for (const [t, n] of Object.entries(s.tools)) { toolTotals[t] = (toolTotals[t] || 0) + n; totals.toolCalls += n; }
    for (const [d, v] of Object.entries(s.byDay)) { const o = (byDay[d] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }); for (const k in v) o[k] += v[k]; }
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) totals[k] += s.tokens[k];
    totals.webSearches += s.webSearches;
    totals.prompts += s.prompts.length;
  }
  // Fold subagent work into the session that started it.
  for (const s of all) {
    const parent = parentOf(s);
    const rec = { ...s, subagents: 0 };
    if (parent && all.some((x) => x.id === parent)) continue;
    main.set(s.id, rec);
  }
  for (const s of all) {
    const parent = parentOf(s);
    const p = parent && main.get(parent);
    if (!p) continue;
    p.subagents++;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) p.tokens = { ...p.tokens, [k]: p.tokens[k] + s.tokens[k] };
    p.actions = [...p.actions, ...s.actions.map((a) => ({ ...a, sub: true }))];
    p.tools = { ...p.tools }; for (const [t, n] of Object.entries(s.tools)) p.tools[t] = (p.tools[t] || 0) + n;
  }
  const sessionList = [...main.values()].map((s) => {
    const kind = s.source === "ai-fix" ? "AI fix" : "Session";
    return {
      id: s.id, title: s.source === "ai-fix" ? `AI fixing ${s.prompts[0]?.text.match(/findings to (\S+)/)?.[1] || "a file"}`
        : s.title || s.aiTitle || (s.prompts[0]?.text.slice(0, 70) ?? "(untitled)"), kind,
      project: projectName(s.cwd), cwd: s.cwd,
      first: s.first, last: s.last, models: Object.keys(s.models), tokens: s.tokens, webSearches: s.webSearches,
      prompts: s.prompts, promptCount: s.prompts.length, tools: s.tools, toolCalls: Object.values(s.tools).reduce((a, b) => a + b, 0),
      files: s.files, subagents: s.subagents, actions: s.actions.slice(-300),
    };
  }).sort((a, b) => (b.last || "").localeCompare(a.last || ""));

  const feed = sessionList.flatMap((s) => s.actions.map((a) => ({ ...a, session: s.id, sessionTitle: s.title })))
    .sort((a, b) => (b.at || "").localeCompare(a.at || "")).slice(0, 250);
  const cwdList = [...cwds].filter((c) => statOf(c));

  // Code screen: every file Claude wrote or changed, newest first.
  const titleOf = (id) => id.startsWith("git:") ? (id.includes(" · commit ") ? id.slice(4) : `${id.slice(4)} · uncommitted changes`)
    : sessionList.find((x) => x.id === id)?.title || "";
  // The project a change belongs to: its session's folder, or the watched repo's name
  const projectOf = (id) => id.startsWith("git:") ? id.slice(4).split(" · ")[0] : sessionList.find((x) => x.id === id)?.project || "";
  editIndex.clear();
  const exists = new Map();
  const isThere = (f) => { if (!exists.has(f)) exists.set(f, !!statOf(f)); return exists.get(f); };
  const fromTranscripts = all.flatMap((s) => {
    const parent = parentOf(s);
    const owner = parent && main.has(parent) ? parent : s.id;
    return s.edits.map((e) => ({ e, owner, sub: owner !== s.id }));
  });
  // Changes that didn't come through Claude's edit tools (git apply, hand edits) in watched repos.
  // A file Claude is actively editing is skipped, so the same change doesn't show twice.
  const lastClaudeEdit = new Map();
  for (const { e } of fromTranscripts) {
    const k = e.file.toLowerCase();
    if ((lastClaudeEdit.get(k) || "") < e.at) lastClaudeEdit.set(k, e.at);
  }
  const fromGit = gitChanges().filter((x) => {
    const claude = lastClaudeEdit.get(x.e.file.toLowerCase());
    if (!claude) return true;
    // Uncommitted: skip while Claude is editing the file. Committed: skip if Claude edited it in the 6 h before the commit.
    return x.e.commit ? !(new Date(claude) <= new Date(x.e.at) && new Date(claude) > new Date(x.e.at) - 6 * 3600000)
      : new Date(claude) < new Date(x.e.at) - 10 * 60000;
  });
  const code = [...fromTranscripts, ...fromGit].sort((a, b) => (b.e.at || "").localeCompare(a.e.at || "")).slice(0, 150).map(({ e, owner, sub }) => {
    const d = codeDetail(e);
    editIndex.set(e.id, { e, d, owner, sub });
    return { id: e.id, at: e.at, tool: e.tool, file: e.file.replace(HOME, "~"), name: path.basename(e.file), write: !!e.write,
      rewrite: !!e.rewrite, exists: isThere(e.file), v: e.patch ? 1 : 0,
      session: owner, sessionTitle: titleOf(owner), project: projectOf(owner), sub, added: d.added, removed: d.removed, lang: d.lang };
  });

  // Live view: the last 3 hours in 5-minute buckets, plus who's working right now.
  const now = Date.now(), BUCKET = 5 * 60000, N = 36;
  const start = Math.floor(now / BUCKET) * BUCKET - (N - 1) * BUCKET;
  const buckets = Array.from({ length: N }, (_, i) => ({ t: new Date(start + i * BUCKET).toISOString(), output: 0, turns: 0, actions: 0 }));
  const slot = (iso) => { const i = Math.floor((new Date(iso) - start) / BUCKET); return i >= 0 && i < N ? buckets[i] : null; };
  let hourOutput = 0, hourActions = 0, hourTurns = 0;
  for (const s of all) {
    for (const t of s.turns) {
      const b = slot(t.at); if (b) { b.output += t.output; b.turns++; }
      if (now - new Date(t.at) < 3600000) { hourOutput += t.output; hourTurns++; }
    }
    for (const a of s.actions) {
      const b = slot(a.at); if (b) b.actions++;
      if (now - new Date(a.at) < 3600000) hourActions++;
    }
  }
  const active = sessionList.filter((s) => s.last && now - new Date(s.last) < 120000).map((s) => ({ id: s.id, title: s.title, kind: s.kind, last: s.last }));
  const live = { buckets, hour: { output: hourOutput, actions: hourActions, turns: hourTurns }, active, lastAction: feed[0] || null };

  // Token usage panel: who and what used the tokens, for three periods.
  const owners = new Map();
  const ownerOf = (s) => {
    if (owners.has(s.file)) return owners.get(s.file);
    const parent = parentOf(s);
    const id = parent && main.has(parent) ? parent : s.id;
    const sl = sessionList.find((x) => x.id === id);
    const o = { id, title: sl?.title || "(untitled)", kind: sl?.kind || "Session", project: sl?.project || projectName(s.cwd), first: sl?.first || s.first };
    owners.set(s.file, o);
    return o;
  };
  // AI code reviews and fixes run without a transcript; their recorded usage counts too.
  const reviewTurns = (readJson(REVIEWS_FILE, {}).reviews || [])
    .flatMap((r) => Object.entries(r.usage || {}).map(([model, u]) => {
      const t = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 };
      return { at: r.finishedAt || r.at, model, t, outParts: { review: t.output }, ctx: { review: t.input + t.cacheWrite } };
    }));
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const firstDay = new Date(Math.min(...all.map((s) => new Date(s.first || Date.now()).getTime()))); firstDay.setHours(0, 0, 0, 0);
  const H = 3600000;
  const tokenUsage = {
    today: usageBreakdown(all, ownerOf, midnight.getTime(), H, reviewTurns),
    week: usageBreakdown(all, ownerOf, midnight.getTime() - 6 * 24 * H, 6 * H, reviewTurns),
    all: usageBreakdown(all, ownerOf, firstDay.getTime(), 24 * H, reviewTurns),
  };

  return {
    generatedAt: new Date().toISOString(),
    live,
    code,
    tokenUsage,
    usage: liveUsage(all, readJson(USAGE_FILE, null)),
    totals: { ...totals, sessions: sessionList.length, transcripts: all.length },
    byDay: Object.entries(byDay).map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    tools: Object.entries(toolTotals).map(([name, count]) => ({ name, count, category: toolCategory(name) })).sort((a, b) => b.count - a.count),
    sessions: sessionList.map(({ actions, ...rest }) => rest),
    sessionActions: Object.fromEntries(sessionList.map((s) => [s.id, s.actions])),
    feed,
    memory: memoryFiles(),
    context: contextFiles(cwdList),
    settings: { user: readJson(path.join(CLAUDE_DIR, "settings.json"), {}), projects: cwdList.map((c) => ({ cwd: c, settings: readJson(path.join(c, ".claude", "settings.json"), null), local: readJson(path.join(c, ".claude", "settings.local.json"), null) })).filter((p) => p.settings || p.local) },
    agents: agents(cwdList),
    scheduled: scheduledTasks(sessionList),
    mcp: mcpServers(cwdList, toolTotals),
  };
}

// Full diff for one change on the code screen.
function codeEdit(id) {
  if (!editIndex.size) summary();
  const x = editIndex.get(id);
  if (!x) return null;
  return { id, at: x.e.at, tool: x.e.tool, file: x.e.file.replace(HOME, "~"), write: !!x.e.write, rewrite: !!x.e.rewrite, exists: !!statOf(x.e.file), replaceAll: !!x.e.replaceAll, sub: x.sub, ...x.d };
}

// The summary is rebuilt only when something it reads has changed: a transcript, the usage
// snapshot, a memory file, or the clock minute (the live strip is time-based).
let cached = { fp: null, data: null, body: null, etag: null };
function fingerprint() {
  const parts = [Math.floor(Date.now() / 60000)];
  for (const f of listTranscripts()) { const st = statOf(f); if (st) parts.push(f.length, st.mtimeMs, st.size); }
  const u = statOf(USAGE_FILE); parts.push(u ? u.mtimeMs : 0);
  const rv = statOf(REVIEWS_FILE); parts.push(rv ? rv.mtimeMs : 0);
  parts.push(gitCache.at); // watched repos refresh every 30 s
  let h = 2166136261; // FNV-1a over the stat list
  for (const ch of parts.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function current() {
  const fp = fingerprint();
  if (fp !== cached.fp) {
    const data = buildSummary();
    const body = JSON.stringify(data);
    cached = { fp, data, body, etag: `"${fp}"` };
  }
  return cached;
}
const summary = () => current().data;
const summaryResponse = () => { const c = current(); return { body: c.body, etag: c.etag }; };

module.exports = { summary, summaryResponse, codeEdit, DATA_DIR, REVIEWS_FILE };
