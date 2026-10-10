/** /finish — agent-driven project checks and task wrap-up. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const VERIFICATION_PROMPT = `Wrap up the current coding task: verify and report, not implement fixes.

Scope
- Identify the project/task from the working directory and conversation. Read project instructions and check configuration.
- Search project documentation and instructions for "gate" (case-insensitive). Read matches in context; treat documented checks and acceptance criteria as requirements.
- In Git, inspect status, staged/unstaged diffs, statistics, and relevant untracked source files. Do not assume every change belongs to this task; avoid ignored secrets and large generated files. Outside Git, report that and inspect known task files; do not initialize Git.

Verify
- Discover and inspect actual configured checks from scripts, manifests, CI, or build configuration. Prioritize affected packages and dependencies.
- Run relevant non-fixing lint, format-check, typecheck, test, and build commands with bounded timeouts, no watch mode, and captured exit codes. Avoid redundant runs; continue independent checks after failures.
- Do not edit source, install dependencies, auto-fix, update snapshots, deploy, publish, migrate, or use production/external services. Local build/cache artifacts are acceptable; report unexpected tracked changes without reverting them.
- Respect tool permissions and plan-mode restrictions; never bypass them. Report unsafe, unavailable, or restricted checks as skipped with reasons. Never count skipped, timed-out, or incomplete checks as passing. Label reused results as previous and reuse only if relevant files are unchanged.

Review and report
- Review task changes for obvious bugs, missing tests, new debug/temporary code, conflict markers, and new TODO/FIXME items; distinguish existing intentional code.
- Summarize changes and readiness. List exact check commands, working directories, PASS/FAIL/SKIPPED/TIMED OUT results, and verification gaps, including unmet or unverified gates.
- Give actionable findings with paths/line numbers, or say none were found. This is a focused review, not a correctness guarantee.`;

export const NORMAL_INSTRUCTIONS = `Do not stage, commit, stash, reset, clean, revert, or push. Suggest fixes instead of applying them. Include a copyable suggested commit message for this task's actual changes; omit it when no applicable changes exist.`;

export const COMMIT_INSTRUCTIONS = `Automatic commit mode: the user explicitly authorized committing this task. Do not ask for another intent confirmation. Existing permissions still apply.
- Commit only after verification/review, all required checks and gates pass, and no actionable blockers remain. Failed, skipped, timed-out, or unverified requirements block committing. If no checks/gates exist, say so and rely on focused review. Outside Git or with no task changes, skip committing and explain.
- Immediately before staging, recheck status and index. Stop without modifying the index if unrelated changes are staged or ownership is ambiguous, including mixed task/unrelated files. Do not unstage others' changes.
- Stage explicit task paths only, including intended deletions; exclude secrets, generated artifacts, and unrelated changes. Never use git add ., git add -A, or git commit -a. Inspect the complete staged diff and run git diff --cached --check; stop on failure or unexpected content.
- Create one normal commit with an accurate message. Do not amend, push, bypass hooks/signing, change Git configuration, stash, reset, clean, or revert. Report staging/commit failures or denials and remaining staged changes without bypass attempts.
- After success, verify and report the actual commit hash, message, and remaining Git status; otherwise explain why no commit occurred.`;

export const FINISH_PROMPT = `${VERIFICATION_PROMPT}\n\n${NORMAL_INSTRUCTIONS}`;

export function buildFinishPrompt(args: string): string {
  const trimmed = args.trim();
  const commitMode = /^commit(?:\s|$)/i.test(trimmed);
  const focus = commitMode ? trimmed.slice("commit".length).trim() : trimmed;
  const instructions = commitMode
    ? `${VERIFICATION_PROMPT}\n\n${COMMIT_INSTRUCTIONS}`
    : FINISH_PROMPT;
  return focus
    ? `${instructions}\n\nAdditional user focus:\n${focus}`
    : instructions;
}

export default function finishExtension(pi: ExtensionAPI): void {
  pi.registerCommand("finish", {
    description: "Verify and wrap up changes; /finish commit also commits after checks pass",
    handler: async (args, ctx) => {
      const prompt = buildFinishPrompt(args ?? "");
      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        if (ctx.hasUI) ctx.ui.notify("Finish queued after the current task.", "info");
      }
    },
  });
}
