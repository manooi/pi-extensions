import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DeletionCheck {
  policy: "ask" | "deny";
  source: "deletion";
  detail: string;
  key: string;
  requireConfirmation: boolean;
}

function canonical(p: string): string {
  const suffix: string[] = [];
  while (!fs.existsSync(p)) {
    const parent = path.dirname(p);
    if (parent === p) break;
    suffix.unshift(path.basename(p));
    p = parent;
  }
  return path.join(fs.realpathSync(p), ...suffix);
}

function within(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Deliberately accept only literal shell words. This is not a shell interpreter.
function words(unit: string): string[] | undefined {
  if (/[\\$`*?\[\]{}()<>!&|\n]/.test(unit)) return undefined;
  const tokens = unit.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) ?? [];
  if (tokens.join(" ").replace(/\s/g, "") !== unit.replace(/\s/g, "")) return undefined;
  return tokens.map(t => t.replace(/^(["'])(.*)\1$/, "$2"));
}

export function checkDeletion(command: string, cwd: string, units: string[], denied: (target: string) => boolean = () => false): DeletionCheck[] {
  if (!/\b(rm|rmdir)\b/.test(command)) return [];
  const root = canonical(cwd);
  const home = canonical(os.homedir());
  const system = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/run", "/var", "/opt", "/root"].map(canonical);
  let current = root;
  let uncertain = /[$`\\(){}\n]|\|\||(^|[^&])&([^&]|$)|(^|[^|])\|([^|]|$)/.test(command);
  const checks: DeletionCheck[] = [];
  const decision = (policy: "ask" | "deny", detail: string, confirm = true): DeletionCheck => ({
    policy, source: "deletion", detail, key: `deletion:${root}:${command}`, requireConfirmation: confirm,
  });
  for (const unit of units) {
    const args = words(unit);
    if (!args?.length) { uncertain = true; continue; }
    const executable = path.basename(args[0]);
    if (executable === "cd") {
      if (args.length !== 2 || args[1].startsWith("-") || args[1].startsWith("~")) { uncertain = true; continue; }
      current = canonical(path.resolve(current, args[1]));
      continue;
    }
    if (executable !== "rm" && executable !== "rmdir") {
      // Other commands may change directories, paths, or symlinks before rm.
      uncertain = true;
      continue;
    }
    let options = true;
    const targets: string[] = [];
    for (const arg of args.slice(1)) {
      if (options && arg === "--") { options = false; continue; }
      if (options && arg.startsWith("-")) {
        if (!/^-[rfdivIP]+$/.test(arg) && !["--recursive", "--force", "--verbose", "--interactive", "--preserve-root", "--one-file-system"].includes(arg)) uncertain = true;
        continue;
      }
      targets.push(arg);
    }
    if (!targets.length) uncertain = true;
    for (const target of targets) {
      if (!target || target.startsWith("~")) { uncertain = true; continue; }
      const lexical = path.resolve(current, target);
      const resolved = canonical(lexical);
      const protectedPath = (p: string) => p === "/" || p === home || p === "/home" || p === "/tmp" || p === "/mnt" || p === "/media" || system.some(s => within(p, s)) || within(root, p);
      if (denied(lexical) || denied(resolved)) {
        checks.push(decision("deny", `Deletion target matches a sensitive-path denial: ${target}`));
      } else if (protectedPath(lexical) || protectedPath(resolved)) {
        checks.push(decision("deny", `Deletion target is a protected directory or project ancestor: ${target}`));
      } else if (!within(lexical, root) || !within(resolved, root)) {
        checks.push(decision("ask", `Deletion target is outside the project (including symlink resolution): ${target}`));
      } else {
        checks.push(decision("ask", `Project-local deletion: ${target}`, false));
      }
    }
  }
  if (uncertain) checks.push(decision("ask", "Deletion command contains shell syntax or operations that cannot be safely resolved; confirm once"));
  return checks;
}
