---
name: db-migration
description: Change the nipunacrm PostgreSQL schema — write the next numbered SQL migration in db/, apply it, test it in a rolled-back transaction, prove a clean replay, reset sequences and update docs/DB_PHASES.md. Use for any new or changed table, column, constraint, trigger, function, view, enum value or seed data.
---

# Database migrations (nipunacrm)

The SQL files in `db/` are the **only** source of the schema. SQLAlchemy models map existing tables and never create them (no `db.create_all()`, no Alembic autogenerate). Business rules live in triggers and constraints, and their messages reach API users unchanged (422 `BUSINESS_RULE`), so write them for humans.

## 1. Before writing

1. Read `docs/DB_PHASES.md` (status table + the section for the area) and the latest migrations.
2. Look at the real tables, not memory:
   ```bash
   psql -d nipunacrm -At -F'|' -c "SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='<table>' ORDER BY ordinal_position"
   psql -d nipunacrm -c '\d <table>'            # constraints, triggers, indexes
   ```
3. Find views that depend on anything you'll drop or retype (a column used by a view can't be dropped):
   ```bash
   psql -d nipunacrm -At -c "SELECT DISTINCT v.relname FROM pg_depend d JOIN pg_rewrite r ON d.objid=r.oid JOIN pg_class v ON r.ev_class=v.oid JOIN pg_class t ON d.refobjid=t.oid WHERE t.relname='<table>' AND v.relname<>t.relname"
   ```

## 2. Write `db/NNN_short_name.sql`

Next number after the highest file. Header comment: what and why, and `-- Depends on: <previous file>`.

Conventions (match the existing files):
- **Keys / types:** `<table>_id SERIAL PRIMARY KEY` (BIGSERIAL for high-volume logs); money `NUMERIC(10, 2)`; times `TIMESTAMP WITH TIME ZONE`; fixed value sets as Postgres enums; admin-editable dropdowns as lookup tables (`code`, `label`, `sort_order`, `is_active`).
- **Timestamps:** `created_at`/`updated_at ... NOT NULL DEFAULT CURRENT_TIMESTAMP` plus `CREATE TRIGGER trg_<table>_updated_at BEFORE UPDATE ... EXECUTE FUNCTION set_updated_at();`
- **Name every constraint** (`CONSTRAINT <table>_<rule> CHECK (...)`) — never rely on auto names like `x_check1`. Use `"status <> 'X' OR <required fields> IS NOT NULL"` for "X needs Y".
- **Human codes** come from triggers using `next_number(key)` (gap-free, concurrency-safe), filled only when NULL:
  `PER-GNT-00001`, `LD-00001`, `ENQ-00001`, `FD-00001`, `SCR-00001`, `DM-GNT-0001`, `INV-GNT-2627-0001`, `GNT-R-2627-00001`, `REV-GNT-2627-00001`, `CR-GNT-0001`, `NIT-GNT-2026-000001`, `NIT-RF-00001`, `SUP-00001`, `IMP-00001`, `GNT-B-0001`, `GNT-C-2627-00001`, `JOB-00001`, `IR-00001`, `TM-2026-10-v1`. Branch part = `branches.receipt_prefix`; FY part = `fy_code(date)`.
- **Who did it:** triggers read `NULLIF(current_setting('app.current_user_id', TRUE), '')::INT` (the API sets it per request).
- **Role checks in SQL:** `user_has_role(user_id, ARRAY['FOUNDER_CEO','SUPER_ADMIN'], branch_id)` (uses `active_user_role_scopes`). Independent approval = a CHECK like `decided_by <> requested_by`.
- **Immutability:** ledgers / documents get a BEFORE UPDATE guard comparing a column tuple with `IS DISTINCT FROM`, plus a BEFORE DELETE that raises. Allowed changes go through a session flag (`set_config('app.applying_fee_change','on',TRUE)`) set by the approving trigger.
- **Deadlines:** `add_staffed_minutes(branch, start, minutes)`, `add_working_days(branch, date, n)`, `working_day_end(branch, date)`, `business_tz()`. Never hard-code clock minutes for SLAs.
- **Derived state** (balances, dues, occupancy, queues) goes in views, not stored columns.
- **Trigger order:** same-timing triggers fire alphabetically — prefix with `a_` / `z_` when one must run before / after another (e.g. `trg_fee_versions_z_approval` runs after the defaults trigger).
- **Enums:** `ALTER TYPE ... ADD VALUE` works inside the file's transaction, but the new value can't be *used* in that same transaction (constraints, WHEN clauses, inserts). If you need to use it, put the `ADD VALUE` in its own earlier file (see `009_prototype_alignment_enums.sql`). Removing values = recreate the type (see 009's intake status).
- **Views:** `CREATE OR REPLACE VIEW` may only append columns at the end; otherwise `DROP VIEW` first and recreate it in the same file.
- **Replacing a function:** `CREATE OR REPLACE FUNCTION` with the full new body; keep its trigger unless the WHEN clause changes (then `DROP TRIGGER` + `CREATE TRIGGER`).

## 3. Apply

```bash
psql -d nipunacrm -v ON_ERROR_STOP=1 -1 -q -f db/NNN_short_name.sql
```
Each file runs in its own transaction. If you fix a migration that is already applied (only while nothing is deployed), apply the identical fix to the live DB and run the replay check below.

## 4. Test in a rolled-back transaction

Write a script in the session scratchpad (not the repo):
```sql
\set QUIET on
BEGIN;
-- setup: users + role scopes, course, person, lead ... (look IDs up by code / email, never hard-code:
-- failed inserts inside savepoints still consume sequence values)
\echo '=== 1. <rule> (expect error)'
SAVEPOINT s; <statement that must fail>; ROLLBACK TO s;
\echo '=== 2. <happy path>'
<statement> RETURNING <what proves it>;
ROLLBACK;
```
Run and read only the useful lines:
```bash
psql -d nipunacrm -f <script> 2>&1 | grep -v '^CONTEXT\|^LINE\|^ *\^\|^SQL statement\|^PL/pgSQL\|^DETAIL:  Failing row' | sed -E 's#psql:[^:]+:[0-9]+: ##'
```
Cover every new rule's failure *and* the happy path. Every `ERROR` line must be one you expected.

## 5. Verify and clean up

```bash
cd backend && ../venv/bin/pytest -q                        # rebuilds nipunacrm_test from db/*.sql
bash .claude/skills/db-migration/scripts/replay_check.sh   # fresh DB from all files == live schema
psql -d nipunacrm -q -f .claude/skills/db-migration/scripts/reset_sequences.sql   # undo sequence bumps from tests
```
The replay check must report `schema diff lines: 0`.

## 6. Update docs and code

- `docs/DB_PHASES.md`: add the file to the status table and a section: changed decisions, added tables/views/functions, rules enforced.
- `docs/API_PLAN.md`: adjust affected endpoints (see the `build-api-step` skill).
- `backend/models/*`: add / adjust mapped columns for tables the API already uses (enums via `models/enums.py`).

## 7. Report to the user

What changed and why, what the tests proved (quote key results), and every value you had to assume (not in the prototype) so they can confirm it.
