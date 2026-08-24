# Contributing to InfoMemory Agent

## Development contract

Use Node.js 24 and npm 11 or later. Keep domain and repository logic in `packages/core`; keep HTTP, authentication, configuration, and connector adapters in `apps/api`. All repository reads must accept an access context and apply tenant/actor authorization in the database query. Raw connector data must pass through the safe normalization boundary before it is persisted, indexed, logged, sent to an LLM, or used to derive notifications.

## Local setup and verification

Install from the lock file:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Run the complete quality gate:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

The first command enters `scripts/install.ps1`, which invokes npm installation for the root workspace, `packages/core`, and `apps/api`. The second enters `scripts/verify.ps1`, which invokes the root `typecheck`, `test`, and `build` npm scripts; those delegate to both workspaces. See `README.md` for the full nested command chains.

## Pull requests

Keep changes independently testable. Add a regression test before or alongside every security or data-isolation fix. A pull request is ready only when the full quality gate passes on Windows and Linux, migrations preserve an existing file database, error responses do not echo submitted content, and user-facing capability claims match the code.

Never commit `.env.local`, SQLite/WAL files, logs, API responses containing enterprise content, access tokens, application secrets, or real tenant/user identifiers. Use synthetic fixtures in tests and examples.
