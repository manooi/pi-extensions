# pi-finish

`/finish` asks Pi to verify and wrap up the current coding task using the current conversation and project directory.

## Usage

```text
/finish
/finish focus on the backend tests
/finish verify the staged changes especially carefully
/finish commit
/finish commit focus on the backend tests
```

Run `/reload` after installing or changing this extension.

The agent discovers project instructions and configured checks, explicitly searches documentation for **"gate"** (case-insensitive), and reads matching quality/release/acceptance gate requirements in context. It inspects staged/unstaged changes and relevant untracked files, runs appropriate finite checks, and reviews changed code for bugs and leftovers. Unmet or unverified documented gates must appear in the readiness assessment. The final report includes:

- Task summary and readiness assessment.
- Exact check commands, working directories, results, and verification gaps.
- Actionable findings with file locations.
- A suggested commit message when there are applicable changes, or the actual commit result in commit mode.

### Automatic commit mode

`/finish commit` explicitly authorizes Pi to stage and commit task-owned changes after verification, without another intent confirmation. Required checks and documented gates must pass. Unrelated staged changes, ambiguous ownership, and mixed task/unrelated files block automatic committing. Only explicit task paths are staged; hooks and signing are not bypassed. Failures are reported, including changes left staged. No push or amend is performed.

The first word `commit` is reserved for this mode (case-insensitive); remaining words supply optional focus. Plain `/finish` remains verification-only.

If Pi is busy, the request is queued as a follow-up rather than interrupting its current work. Outside Git, it verifies known task files without initializing a repository.

## Safety and limitations

This is an **agent-driven workflow**, not a hard-coded check runner or a security sandbox. The instructions prohibit automatic source edits, fixes, dependency installation, pushes, and destructive Git operations. Staging and committing are prohibited unless `/finish commit` is used. Existing permissions and plan-mode restrictions still apply, so permission prompts can still require user action; this command does not enable YOLO or bypass approvals. Project checks can execute arbitrary code and create build/cache artifacts, so only approve checks you trust.

Check discovery and review depend on the model and available tools. Unavailable or unsafe checks should be reported as skipped/blocked, never as passing. This extension does not guarantee a bug-free result.

## Tests

With Node supporting TypeScript stripping:

```sh
node --experimental-strip-types --test ~/.pi/agent/extensions/pi-finish/finish.test.mjs
```
