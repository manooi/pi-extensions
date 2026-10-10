# Pi extensions

A collection of custom extensions for Pi.

## Extensions

- [pi-finish](extensions/pi-finish/README.md): completion and verification workflow.
- [pi-permission](extensions/pi-permission/README.md): tool, command, and path permission policies.
- [pi-plan](extensions/pi-plan/README.md): planning workflow.

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
