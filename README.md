# Pi extensions

A collection of custom extensions and skills for Pi.

## Extensions

- [pi-finish](extensions/pi-finish/README.md): completion and verification workflow.
- [pi-permission](extensions/pi-permission/README.md): tool, command, and path permission policies.
- [pi-plan](extensions/pi-plan/README.md): planning workflow.

## Skills

- [model-review](skills/model-review/SKILL.md): ask a named model for an independent, read-only code review through Pi CLI. Requests such as **"have Astra review"** or **"ask Sonnet to review"** resolve the model with `pi --list-models` and launch a fresh reviewer with read/search tools only. No fixes are made automatically.

  Explicit invocation: `/skill:model-review have Astra review the uncommitted changes`.

Skills are task instructions loaded on demand; extensions are executable code that can add tools, commands, UI, and event hooks. The review workflow needs instructions, not a new runtime extension.

The package manifest exports both extensions and skills. No symlink or separate skill installation is needed. Once your GitHub source contains the change, install it or update your existing installation:

```bash
pi install git:github.com/manooi/pi-extensions
# If already installed:
pi update git:github.com/manooi/pi-extensions
```

Then run `/reload` in an active Pi session, or start a new session, to discover the skill. Existing package filters must allow skills (an explicit `skills: []` disables them).

## Local development

```bash
pi install ~/projects/pi-extensions
```

Do not load these copies alongside the originals in `~/.pi/agent/extensions/`.
Move the originals outside Pi's auto-discovery directory before switching over,
keeping backups and any local state.

## GitHub installation

After publishing, replace YOUR_USERNAME below:

```bash
pi install git:github.com/YOUR_USERNAME/pi-extensions
```

## Migration notes

This repository starts as a copy of the existing extensions. The active
installation has not been changed.

- Permission settings, approvals, and logs are deliberately excluded.
- `pi-permission` currently stores state under
  `~/.pi/agent/extensions/pi-permission/`, independently of its source location.
  Move its state to a dedicated user-data directory before switching installations.
- The plan regression test currently references a machine-specific `jiti` path;
  make this portable before adding CI.
- Some extension documentation still describes the original installation paths.
- Herdr and Atuin integrations are not included; manage those through their
  original installers.

Before publishing publicly, review source and documentation for private paths,
choose a license after checking source provenance, and run the regression tests.

`private: true` prevents accidental npm publication; it does not prevent GitHub
installation as a Pi package.
