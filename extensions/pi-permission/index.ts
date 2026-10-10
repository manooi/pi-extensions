/**
 * pi-permission — a smarter permission gate for Pi.
 *
 * A self-contained policy enforcer: allow / ask / deny over tools, bash
 * commands, file paths, and the working-directory boundary, with
 * session-scoped and persistent user approvals, symlink-aware path checks,
 * and fail-closed behaviour when there is no UI to prompt.
 *
 * Config lives next to this file in config.json. Reload it live with
 *   /permissions reload
 * and inspect state with
 *   /permissions status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { checkDeletion } from "./deletion-guard.ts";

type Policy = "allow" | "ask" | "deny";
type Direction = "read" | "write" | "unknown";

interface Config {
  version: number;
  defaultPolicy: Policy;
  nonInteractive: Policy;
  logDecisions: boolean;
  yoloMode: boolean;
  tools: Record<string, Policy>;
  bash: Record<string, Policy>;
  pathDeny: string[];
  pathAllow: string[];
  externalDirectory: Policy;
  externalDirectoryRead: Policy;
  dangerousCommands: string[];
}

interface Decision {
  policy: Policy;
  source: string;
  detail: string;
  key: string;
  requireConfirmation?: boolean;
}

const DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-permission");
const CONFIG_PATH = path.join(DIR, "config.json");
const DECISIONS_PATH = path.join(DIR, "decisions.json");
const LOG_PATH = path.join(DIR, "decisions.log");

const RANK: Record<Policy, number> = { allow: 1, ask: 2, deny: 3 };

const OPTIONS = [
  "Allow once",
  "Allow this session",
  "Always allow",
  "Deny once",
  "Deny this session",
  "Always deny",
];

const READ_TOOLS = new Set(["read", "glob", "grep", "find", "ls", "rg", "list", "search"]);
const WRITE_TOOLS = new Set(["write", "edit", "append", "patch", "rm", "mv", "cp", "mkdir", "touch", "create"]);
const PATH_KEYS = ["path", "file", "filePath", "filepath", "directory", "dir", "target", "dest", "destination"];

const DEFAULT_CONFIG: Config = {
  version: 1,
  defaultPolicy: "allow",
  nonInteractive: "deny",
  logDecisions: true,
  yoloMode: false,
  tools: { bash: "allow", write: "ask", edit: "ask", append: "ask" },
  bash: {
    "*": "ask",
    pwd: "allow",
    date: "allow",
    ls: "allow",
    "ls *": "allow",
    "echo *": "allow",
    "which *": "allow",
    "command -v *": "allow",
    "cat *": "allow",
    "grep *": "allow",
    "head *": "allow",
    "tail *": "allow",
    "wc *": "allow",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "git remote -v": "allow",
    "git branch": "allow",
    "git branch -a": "allow",
    "git branch -r": "allow",
    "git branch --list*": "allow",
    "git rev-parse*": "allow",
    "sudo *": "ask",
    "rm -rf *": "ask",
    "rm -fr *": "ask",
    "rm --recursive *": "ask",
    "git push *--force*": "ask",
    "git reset --hard*": "ask",
  },
  pathDeny: [
    "**/.env",
    "**/.env.*",
    "~/.ssh/**",
    "~/.gnupg/**",
    "~/.aws/**",
    "~/.config/gcloud/**",
    "~/.pi/agent/settings.json",
    "~/.pi/agent/trust.json",
  ],
  pathAllow: [],
  externalDirectory: "ask",
  externalDirectoryRead: "allow",
  dangerousCommands: [
    "\\brm\\b",
    "\\bsudo\\b",
    "\\b(chmod|chown)\\b",
    "\\bmkfs\\b",
    "\\bdd\\b",
    "\\bshred\\b",
    "\\btruncate\\b",
    ">\\s*/etc/",
    ">>\\s*/etc/",
    "git\\s+push\\s+[^\\n]*--force",
    "git\\s+reset\\s+--hard",
    "git\\s+clean\\s+-[^\\n]*f",
    "\\bcurl\\b[^\\n]*\\|\\s*(ba)?sh\\b",
    "\\bwget\\b[^\\n]*\\|\\s*(ba)?sh\\b",
  ],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cfg: Config | undefined;
let cfgMtime = 0;
let dangerousRes: RegExp[] | undefined;

const sessionApprovals = new Map<string, Policy>();
const persistentApprovals = new Map<string, Policy>();
let yoloOverride: boolean | null = null;
const recentDecisions: { time: string; key: string; policy: string; note: string }[] = [];

// ---------------------------------------------------------------------------
// Config loading (JSONC-ish)
// ---------------------------------------------------------------------------

function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function asPolicy(v: unknown, fallback: Policy): Policy {
  return v === "allow" || v === "ask" || v === "deny" ? (v as Policy) : fallback;
}

function mergeConfig(user: any): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!user || typeof user !== "object") return base;
  if (typeof user.defaultPolicy === "string") base.defaultPolicy = asPolicy(user.defaultPolicy, base.defaultPolicy);
  if (typeof user.nonInteractive === "string") base.nonInteractive = asPolicy(user.nonInteractive, base.nonInteractive);
  if (typeof user.logDecisions === "boolean") base.logDecisions = user.logDecisions;
  if (typeof user.yoloMode === "boolean") base.yoloMode = user.yoloMode;
  if (typeof user.externalDirectory === "string") base.externalDirectory = asPolicy(user.externalDirectory, base.externalDirectory);
  if (typeof user.externalDirectoryRead === "string") base.externalDirectoryRead = asPolicy(user.externalDirectoryRead, base.externalDirectoryRead);
  if (user.tools && typeof user.tools === "object") Object.assign(base.tools, mapPolicies(user.tools));
  if (user.bash && typeof user.bash === "object") Object.assign(base.bash, mapPolicies(user.bash));
  if (Array.isArray(user.pathDeny)) base.pathDeny = user.pathDeny.filter((x) => typeof x === "string");
  if (Array.isArray(user.pathAllow)) base.pathAllow = user.pathAllow.filter((x) => typeof x === "string");
  if (Array.isArray(user.dangerousCommands)) base.dangerousCommands = user.dangerousCommands.filter((x) => typeof x === "string");
  return base;
}

function mapPolicies(obj: Record<string, unknown>): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = asPolicy(v, "ask");
  return out;
}

function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(stripJsonc(raw));
    return mergeConfig(parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function ensureConfig(): Config {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (!cfg || st.mtimeMs !== cfgMtime) {
      cfg = loadConfig();
      cfgMtime = st.mtimeMs;
      dangerousRes = cfg.dangerousCommands.map((r) => new RegExp(r, "i"));
    }
  } catch {
    if (!cfg) {
      cfg = structuredClone(DEFAULT_CONFIG);
      dangerousRes = cfg.dangerousCommands.map((r) => new RegExp(r, "i"));
    }
  }
  return cfg;
}

function loadDecisions(): void {
  try {
    const raw = fs.readFileSync(DECISIONS_PATH, "utf8");
    const data = JSON.parse(stripJsonc(raw));
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (v === "allow" || v === "deny") persistentApprovals.set(k, v);
      }
    }
  } catch {
    /* no saved decisions yet */
  }
}

function saveDecisions(): void {
  try {
    const obj: Record<string, Policy> = {};
    for (const [k, v] of persistentApprovals) obj[k] = v;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(DECISIONS_PATH, JSON.stringify(obj, null, 2) + "\n");
  } catch {
    /* best effort */
  }
}

function logDecision(key: string, policy: string, note: string): void {
  const entry = { time: new Date().toISOString(), key, policy, note };
  recentDecisions.push(entry);
  if (recentDecisions.length > 50) recentDecisions.shift();
  if (cfg?.logDecisions !== false) {
    try {
      fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathGlobToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp("^" + re + "$");
}

function commandGlobToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else re += escapeRegExp(c);
  }
  return new RegExp("^" + re + "$");
}

const pathGlobCache: Map<string, RegExp> = new Map();
function getPathGlob(glob: string): RegExp {
  const expanded = glob.replace(/^~(?=$|\/)/, os.homedir());
  const cached = pathGlobCache.get(expanded);
  if (cached) return cached;
  const re = pathGlobToRegex(expanded);
  pathGlobCache.set(expanded, re);
  return re;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(p: string, cwd: string): string {
  let v = p.trim();
  v = v.replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(v)) v = path.resolve(cwd, v);
  return path.normalize(v);
}

function canonicalize(p: string): string {
  let current = p;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    current = fs.realpathSync(current);
  } catch {
    /* keep as-is */
  }
  return suffix.length ? path.join(current, ...suffix) : current;
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Bash parsing
// ---------------------------------------------------------------------------

function splitBashUnits(command: string): string[] {
  const units: string[] = [];
  let cur = "";
  let inS = false;
  let inD = false;
  const push = () => {
    const t = cur.trim();
    if (t) units.push(t);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (inS) {
      cur += c;
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      cur += c;
      if (c === '"') inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      cur += c;
      continue;
    }
    if (c === '"') {
      inD = true;
      cur += c;
      continue;
    }
    if (c === "\\") {
      cur += c;
      if (i + 1 < command.length) {
        cur += command[i + 1];
        i++;
      }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return units;
}

function isDangerous(command: string, res: RegExp[]): boolean {
  return res.some((re) => {
    re.lastIndex = 0;
    return re.test(command);
  });
}

function extractBashPaths(command: string): string[] {
  const tokens = command.match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? [];
  const out: string[] = [];
  for (let t of tokens) {
    t = t.replace(/^['"]|['"]$/g, "");
    if (t.startsWith("-")) continue;
    if (t.startsWith("/") || t.startsWith("~") || t.startsWith("./") || t.startsWith("../") || t.includes("/")) {
      out.push(t);
    }
  }
  return out;
}

function hasWriteIndicator(command: string): boolean {
  return /(^|\s)(>>?|[0-9]>>?)\s*[^\s]/.test(command) || /\b(cp|mv|rm|touch|mkdir|install|ln|chmod|chown|dd|tee|truncate|sed\s+-i|perl\s+-[a-z]*i)\b/.test(command);
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

function directionForTool(toolName: string): Direction {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "unknown";
}

function extractToolPaths(toolName: string, input: any): { value: string; direction: Direction }[] {
  const dir = directionForTool(toolName);
  const found: { value: string; direction: Direction }[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) found.push({ value: v, direction: dir });
  };
  if (input && typeof input === "object") {
    for (const k of PATH_KEYS) add(input[k]);
    if (input.arguments && typeof input.arguments === "object") {
      for (const k of PATH_KEYS) add(input.arguments[k]);
    }
    for (const arr of [input.files, input.paths]) {
      if (Array.isArray(arr)) arr.forEach(add);
    }
  }
  return found;
}

function evaluatePath(raw: string, direction: Direction, cwd: string): Decision | undefined {
  const norm = normalizePath(raw, cwd);
  const canon = canonicalize(norm);
  for (const g of cfg!.pathDeny) {
    const re = getPathGlob(g);
    if (re.test(norm) || re.test(canon) || re.test(raw)) {
      return { policy: "deny", source: "path", detail: `${raw} matches deny pattern "${g}"`, key: `path:${canon}` };
    }
  }
  for (const g of cfg!.pathAllow) {
    const re = getPathGlob(g);
    if (re.test(norm) || re.test(canon) || re.test(raw)) {
      return { policy: "allow", source: "path", detail: `${raw} matches allow pattern "${g}"`, key: `path:${canon}` };
    }
  }
  if (direction === "unknown") return undefined;
  const outside = !isWithin(norm, cwd) && !isWithin(canon, cwd);
  if (outside) {
    const pol = direction === "write" ? cfg!.externalDirectory : cfg!.externalDirectoryRead;
    if (pol !== "allow") {
      return { policy: pol, source: "external", detail: `${raw} is outside the working directory`, key: `external:${canon}` };
    }
  }
  return undefined;
}

function resolveBashRule(unit: string): Policy {
  let result: Policy | undefined;
  for (const [pattern, policy] of Object.entries(cfg!.bash)) {
    if (commandGlobToRegex(pattern).test(unit)) result = policy;
  }
  return result ?? cfg!.defaultPolicy;
}

function evaluateBash(command: string, cwd: string): Decision[] {
  const out: Decision[] = [];
  const units = splitBashUnits(command);
  out.push(...checkDeletion(command, cwd, units, target => evaluatePath(target, "write", cwd)?.policy === "deny"));
  const wholeDangerous = isDangerous(command, dangerousRes!);
  for (const u of units) {
    const rule = resolveBashRule(u);
    const danger = wholeDangerous || isDangerous(u, dangerousRes!);
    let policy = rule;
    let source = "bash";
    let detail = `bash rule for "${u}"`;
    if (policy === "allow" && danger) {
      policy = "ask";
      source = "dangerous";
      detail = `"${u}" matched a dangerous pattern`;
    }
    out.push({ policy, source, detail, key: `bash:${u}` });
  }
  // Cross-cutting path deny/allow for path-looking tokens in the command.
  for (const p of extractBashPaths(command)) {
    const d = evaluatePath(p, hasWriteIndicator(command) ? "write" : "read", cwd);
    if (d) out.push(d);
  }
  return out;
}

// Tie-break equal-ranked decisions toward the most specific one, so an
// approval is scoped to the command/path rather than the whole tool:
// path/external > bash/dangerous > tool > default.
function sourceSpecificity(source: string): number {
  switch (source) {
    case "deletion":
      return 4;
    case "path":
    case "external":
      return 3;
    case "bash":
    case "dangerous":
      return 2;
    case "tool":
      return 1;
    default:
      return 0;
  }
}

function mostRestrictive(decisions: Decision[], fallback: Policy): Decision {
  let best: Decision = { policy: fallback, source: "default", detail: "default policy", key: "default" };
  for (const d of decisions) {
    if (
      RANK[d.policy] > RANK[best.policy] ||
      (RANK[d.policy] === RANK[best.policy] && sourceSpecificity(d.source) > sourceSpecificity(best.source))
    ) {
      best = d;
    }
  }
  if (best.policy === "ask" && decisions.some(d => d.requireConfirmation)) {
    const confirmation = decisions.find(d => d.requireConfirmation)!;
    best = { ...best, requireConfirmation: true, key: confirmation.key, detail: confirmation.detail };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

function lookupApproval(key: string): Policy | undefined {
  return sessionApprovals.get(key) ?? persistentApprovals.get(key);
}

function isYolo(): boolean {
  return yoloOverride ?? cfg?.yoloMode ?? false;
}

async function authorize(
  ctx: any,
  opts: { policy: Policy; key: string; detail: string; title: string; requireConfirmation?: boolean },
): Promise<{ allow: boolean; reason?: string }> {
  const saved = lookupApproval(opts.key);
  if (saved === "deny") return { allow: false, reason: "Denied by a saved decision" };
  if (saved === "allow" && !opts.requireConfirmation) {
    if (opts.policy === "deny") return { allow: false, reason: `Blocked by policy: ${opts.detail}` };
    return { allow: true };
  }
  if (opts.policy === "deny") return { allow: false, reason: `Blocked by policy: ${opts.detail}` };
  if (opts.policy === "allow") return { allow: true };

  // "ask"
  if (isYolo() && !opts.requireConfirmation) {
    logDecision(opts.key, "allow", "yolo");
    return { allow: true };
  }

  if (!ctx.hasUI) {
    if (cfg!.nonInteractive === "allow" && !opts.requireConfirmation) return { allow: true };
    logDecision(opts.key, "deny", `no UI; ${opts.detail}`);
    return { allow: false, reason: `Blocked (no UI to confirm): ${opts.detail}` };
  }

  const choice = String((await ctx.ui.select(opts.title, opts.requireConfirmation ? ["Allow once", "Deny once"] : OPTIONS)) ?? "");
  if (choice === "Allow once" || choice === "Allow this session" || choice === "Always allow") {
    if (choice === "Allow this session") sessionApprovals.set(opts.key, "allow");
    else if (choice === "Always allow") {
      persistentApprovals.set(opts.key, "allow");
      saveDecisions();
    }
    logDecision(opts.key, "allow", choice);
    return { allow: true };
  }

  const isDeny = choice === "Deny once" || choice === "Deny this session" || choice === "Always deny";
  if (choice === "Deny this session") sessionApprovals.set(opts.key, "deny");
  else if (choice === "Always deny") {
    persistentApprovals.set(opts.key, "deny");
    saveDecisions();
  }
  logDecision(opts.key, "deny", choice || "cancelled");
  return { allow: false, reason: isDeny ? "Denied by user" : "Prompt cancelled" };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  loadDecisions();
  ensureConfig();

  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      ensureConfig();
      const toolName = String(event.toolName ?? "");
      const input = event.input ?? {};
      const cwd: string = ctx.cwd ?? process.cwd();

      const decisions: Decision[] = [];
      decisions.push({
        policy: cfg!.tools[toolName] ?? cfg!.defaultPolicy,
        source: "tool",
        detail: `tool "${toolName}"`,
        key: `tool:${toolName}`,
      });
      for (const p of extractToolPaths(toolName, input)) {
        const d = evaluatePath(p.value, p.direction, cwd);
        if (d) decisions.push(d);
      }
      if (toolName === "bash") {
        const command = String(input.command ?? input.cmd ?? "");
        for (const d of evaluateBash(command, cwd)) decisions.push(d);
      }

      const winner = mostRestrictive(decisions, cfg!.defaultPolicy);
      const title = buildTitle(toolName, winner, input);
      const res = await authorize(ctx, {
        policy: winner.policy,
        key: winner.key,
        detail: winner.detail,
        requireConfirmation: winner.requireConfirmation,
        title,
      });
      if (!res.allow) return { block: true, reason: res.reason ?? "Blocked by permission system" };
      return undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { block: true, reason: `Permission gate error (fail closed): ${msg}` };
    }
  });

  pi.on("user_bash", async (event: any, ctx: any) => {
    try {
      ensureConfig();
      const command = String(event.command ?? "");
      const cwd: string = ctx.cwd ?? process.cwd();
      const decisions = evaluateBash(command, cwd);
      decisions.unshift({
        policy: cfg!.tools.bash ?? cfg!.defaultPolicy,
        source: "tool",
        detail: `tool "bash"`,
        key: `tool:bash`,
      });
      const winner = mostRestrictive(decisions, cfg!.defaultPolicy);
      const res = await authorize(ctx, {
        policy: winner.policy,
        key: winner.key,
        detail: winner.detail,
        requireConfirmation: winner.requireConfirmation,
        title: `🔐 Permission required — bash\n  ${command}\n  ${winner.detail}`,
      });
      if (res.allow) return undefined;
      return {
        result: {
          output: res.reason ?? "Blocked by permission system",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: {
          output: `Permission gate error (fail closed): ${msg}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  const handlePermissions = async (name: string, ctx: any) => {
      ensureConfig();
      const arg = (name ?? "").trim().toLowerCase();
      const say = (msg: string) => {
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
      };
      const syncStatus = () => {
        try {
          if (ctx.hasUI) ctx.ui.setStatus("pi-permission", isYolo() ? "🔐 yolo" : "");
        } catch {
          /* ignore */
        }
      };
      if (!arg || arg === "status") {
        const lines = [
          "🔐 pi-permission",
          `config: ${CONFIG_PATH}`,
          `yolo mode: ${isYolo() ? "ON" : "off"}`,
          `tools: ${Object.keys(cfg!.tools).length} rules · bash: ${Object.keys(cfg!.bash).length} patterns · pathDeny: ${cfg!.pathDeny.length} · dangerous: ${cfg!.dangerousCommands.length}`,
          `session approvals: ${sessionApprovals.size} · persistent: ${persistentApprovals.size}`,
          "recent decisions:",
          ...recentDecisions.slice(-5).map((d) => `  ${d.policy.padEnd(5)} ${d.key}  ${d.note}`),
        ];
        say(lines.join("\n"));
      } else if (arg === "yolo" || arg.startsWith("yolo ")) {
        const sub = arg.slice(5).trim();
        if (sub === "on") yoloOverride = true;
        else if (sub === "off") yoloOverride = false;
        else if (sub === "") yoloOverride = !isYolo();
        else {
          say("Usage: /permissions yolo [on|off]");
          return;
        }
        syncStatus();
        say(`🔐 YOLO mode ${isYolo() ? "ON — auto-approving 'ask' (hard denies still block)" : "off — prompting for 'ask'"}`);
      } else if (arg === "reload") {
        yoloOverride = null;
        cfg = loadConfig();
        try {
          cfgMtime = fs.statSync(CONFIG_PATH).mtimeMs;
        } catch {
          cfgMtime = 0;
        }
        dangerousRes = cfg.dangerousCommands.map((r) => new RegExp(r, "i"));
        syncStatus();
        say(`🔐 Permission config reloaded (${Object.keys(cfg.tools).length} tools, ${Object.keys(cfg.bash).length} bash patterns)`);
      } else if (arg === "reset") {
        sessionApprovals.clear();
        persistentApprovals.clear();
        try {
          fs.rmSync(DECISIONS_PATH, { force: true });
        } catch {
          /* ignore */
        }
        say("🔐 Permission approvals reset (session + persistent)");
      } else {
        say("Usage: /permissions [status|reload|reset|yolo [on|off]]");
      }
  };

  pi.registerCommand("permissions", {
    description: "Permission system: status | reload | reset | yolo [on|off]",
    handler: handlePermissions,
  });

  pi.registerCommand("yolo", {
    description: "Toggle YOLO mode or set it with /yolo on|off (hard denies still block)",
    handler: async (args: string, ctx: any) => handlePermissions(`yolo ${args ?? ""}`, ctx),
  });

  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus("pi-permission", isYolo() ? "🔐 yolo" : "");
      } catch {
        /* ignore */
      }
      ctx.ui.notify(
        `🔐 pi-permission loaded (${Object.keys(cfg!.tools).length} tools, ${Object.keys(cfg!.bash).length} bash patterns, ${cfg!.pathDeny.length} path denials, yolo ${isYolo() ? "ON" : "off"})`,
        "info",
      );
    }
  });
}

function buildTitle(toolName: string, decision: Decision, input: any): string {
  const cmd = input?.command ?? input?.cmd;
  const preview = typeof cmd === "string" ? `\n  ${cmd}` : "";
  const detail = decision.source === "tool" ? decision.detail : `${decision.source}: ${decision.detail}`;
  return `🔐 Permission required — ${toolName}${preview}\n  ${detail}`;
}
