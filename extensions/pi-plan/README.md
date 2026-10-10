# Local pi-plan extension

Local copy of `pi-plan` 0.1.1 (MIT; upstream: https://github.com/zx06/pi-packages/tree/main/packages/plan).

The npm package was removed so Pi does not load two `/plan` extensions. This copy uses the supported `theme.fg("muted", ...)` method for completed checklist entries; the npm version called nonexistent `theme.muted(...)`, which left the widget stale at 0/8 while the status showed 2/8.

The session-state key (`pi-plan`) and `[DONE:n]` markers remain unchanged so existing plan sessions restore on `/reload`. Execution retains full step text and restores the pre-plan tool set (including custom tools). Incomplete execution requests another turn at `agent_before_settle`; after two turns with no new completion markers it pauses rather than looping forever. `/plan:status` shows unfinished steps; prompt Pi to resume when ready. Steps are checked only when the assistant emits `[DONE:n]` after verification, never inferred from tool calls. Existing sessions created before tool snapshots may need tools re-enabled manually.

Run regression tests with `node --test ~/.pi/agent/extensions/pi-plan/test.cjs`. Reload Pi (`/reload`) to activate changes. Keep only this extension enabled. Changes under `~/.pi/agent/extensions/` are outside the meysure repository and are not overwritten by `pi update --extensions`.
