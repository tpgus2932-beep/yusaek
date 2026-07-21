# Project instructions

## Scope and change safety

- Only change files and runtime behavior directly required by the user's current request.
- Do not refactor, migrate, reset, or change unrelated routes, services, database connections, environment variables, or existing features.
- Before changing shared infrastructure, identify every caller and obtain explicit user approval if behavior outside the requested feature may change.
- Preserve existing dirty-worktree changes; do not revert unrelated user work.

## Database rules

- Treat database routing as feature-specific infrastructure. Do not change the global `_USE_TURSO`, `.env` database settings, `_get_db`, or `_get_shared_db` just to implement one feature.
- Keep existing features on their existing database unless the user explicitly requests a migration.
- If a new feature needs a different database, create a narrowly scoped connection helper and use it only from that feature's router/service.
- Never assume that an empty local SQLite table means data was deleted; first check the existing Turso/shared database and explain the distinction.
- Before any database migration, create a timestamped backup and list the tables/data that will be copied. Do not migrate the whole database when the request concerns one feature.
- Do not delete, overwrite, or truncate existing database data without explicit confirmation.

## Verification

- After changes, run focused syntax/tests for the changed feature.
- Check `git diff` and `git status` to ensure unrelated DB or route wiring was not changed.
