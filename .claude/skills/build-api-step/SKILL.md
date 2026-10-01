---
name: build-api-step
description: Build or extend Nipuna CRM backend APIs in backend/ following docs/API.md and the project's layered Flask structure (routes → controllers → services → repositories → models). Use when implementing an API build step, adding or changing endpoints, or touching auth / branch scoping / validation in the backend.
---

# Building an API step (backend/)

Flask + SQLAlchemy 2 over the existing `nipunacrm` schema. Follow `docs/API.md` (build order, endpoint tables, conventions) and keep it up to date.

## 0. Read first

1. The step's section in `docs/API.md` (endpoints, roles, notes) and any "As built" notes of earlier steps.
2. The matching section of `docs/DATABASE.md` — the database already enforces many rules; don't re-implement them, let their messages through.
3. The real columns of every table you'll map:
   `psql -d nipunacrm -At -F'|' -c "SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='<t>' ORDER BY ordinal_position"`
   and enum values: `SELECT t.typname, string_agg(e.enumlabel, ' | ' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY 1`.
4. If the schema must change, do that first with the `db-migration` skill.

## 1. Layout (no `core/`, no `schemas/`)

```
backend/app.py            create_app(); transaction hook (commit < 400, rollback otherwise); error handler. Nothing imports app.py.
backend/config/           settings, database.py (db), json_provider.py, logging
backend/models/           one file per domain; every model has to_dict() (and to_row()/to_summary() where lists need less)
backend/repositories/     queries, filters, pagination · common.py: paginate(), set_db_user()
backend/services/         business rules · errors.py, security.py, context.py (CurrentUser, role tuples), audit.py, tasks.py, notifications.py, sla.py
backend/controllers/      request → Validator → service → JSON · common.py: ok/created/paginated/no_content, Validator, json_body, get_page_params, error_response_for
backend/routes/           blueprints + decorators.py (@login_required, @require_roles, @fresh_auth); routes/__init__.py BLUEPRINTS is the only list
backend/tests/            pytest; conftest.py fixtures
```
Same file name across layers for a module: `routes/x.py → controllers/x.py → services/x.py → repositories/x.py → models/x.py`.

## 2. Models

- Map columns exactly (names, nullability, lengths). Postgres enums: add values to `models/enums.py` and use `_pg_enum("type_name", VALUES)` (`create_type=False`) — plain `String` breaks enum comparisons.
- Columns filled by triggers (codes, `expires_at`, defaults the service needs right away): `db.session.flush(); db.session.refresh(obj)` after insert.
- Relationships: `lazy="joined"` for many-to-one used in to_dict, `lazy="selectin"` for collections; `cascade="all, delete-orphan"` for child sets replaced wholesale.
- Don't declare a `ForeignKey` to a table that has no model yet (plain `Integer`), or mapper configuration fails.
- Import every new model in `models/__init__.py`.
- New object defaults (`default=`) only apply at INSERT — set them explicitly if service logic reads them before flush.

## 3. Controllers — validate and shape, never query

```python
def create_thing():
    v = Validator(json_body())
    v.string("name", required=True, max_length=150)
    v.email("email", nullable=True)
    v.phone("phone", required=True)            # normalises to +91XXXXXXXXXX
    v.integer("branch_id", required=True, min_value=1)
    v.choice("stage", LEAD_STAGES)
    v.decimal("amount", min_value=0)           # money -> Decimal(2dp)
    v.date("valid_from", nullable=True); v.time("opens_at"); v.datetime("due_at")  # datetime needs a TZ offset
    v.id_list("branch_ids"); v.nested("person", person_rules, nullable=True)
    v.list_of("items", item_rules, required=True, min_items=1)
    return created(things_service.create(v.validate()).to_dict())
```
- Query params: `Validator(request.args.to_dict())`; pagination via `get_page_params()` → `paginated(rows, meta)`.
- PATCH: only present fields are in the result; reject an empty body (`_require_changes`).
- Unknown fields are ignored.

## 4. Services — the rules

- Actor: `current_user()` from `services.context` (`user_id`, `has_role(*codes, branch_id=)`, `is_admin`, `is_manager_of(branch)`, `branch_ids()` (None = all), `can_access_branch(branch)`, `has_fresh_auth`). Services never import `flask.request` for input.
- **Branch scoping:** reading a record outside the user's branches → `NotFound`; creating in a branch outside scope → `Forbidden`. List queries pass `current_user().branch_ids()` to the repository.
- Raise from `services.errors`: `ValidationError` (400, with field details), `Forbidden` (403), `NotFound` (404), `Conflict` (409), `BusinessRule` (422), `FreshAuthRequired`, `PasswordChangeRequired`, `TooManyAttempts`.
- Pre-check only where a friendlier message helps (e.g. duplicate open lead → name the existing code); otherwise let DB trigger / constraint errors surface (mapped in `controllers/common.py`).
- Use `db.session.flush()`, not `commit()` — the request hook commits. (Exception: state that must survive an error response, e.g. failed-login counters.)
- `audit.record(action, entity_type, entity_id, old=..., new=..., branch_id=...)` for approvals, money, access, settings, ownership changes.
- System work: `tasks.create_system_task(type_code, title, branch_id, due_at, dedupe_key=..., lead_id=...)` (idempotent), `tasks.complete_system_task(key)`, `notifications.notify(rule_code, event_key=..., entity_type=..., entity_id=..., branch_id=..., title=...)`, `sla.staffed_deadline(branch, start, minutes)`.

## 5. Repositories

Build `select()` statements with filters; return statements for `paginate()` or lists. Reusable filter expressions go here (see `QUEUES` in `repositories/leads.py`).

## 6. Routes

```python
@things_bp.post("/things/<int:thing_id>/approve")
@login_required
@require_roles(*ADMIN_ROLES)       # role tuples live in services/context.py: ADMIN_ROLES, COUNSELLOR_ROLES, LEAD_ROLES
@fresh_auth                         # sensitive actions only
def approve_thing(thing_id: int):
    return things_controller.approve_thing(thing_id)
```
Register the blueprint in `routes/__init__.py`. Endpoint function names must be unique per blueprint (the auth allow-list uses `auth.me` etc.).

## 7. Tests (backend/tests/test_<module>.py)

Fixtures: `app`, `client`, `make_user(roles=[("SALES", 1)], full_name=..., **columns)`, `login(email)` → auth header, `run_sql(sql, **params)` (commits so setup survives failed requests). Each test runs in a rolled-back transaction; the test DB is rebuilt from `db/*.sql` every run. Look lookup IDs up by `code`.

Cover per endpoint: happy path, wrong role → 403, other branch → 404, each business rule (including DB trigger messages), validation → 400.

```bash
cd backend && ../venv/bin/pytest -q
../venv/bin/pip install -q pyflakes && ../venv/bin/python -m pyflakes app.py cli config controllers models repositories routes services tests; ../venv/bin/pip uninstall -y -q pyflakes
```

## 8. Finish

- Mark the step `✅` in `docs/API.md` and add an **"As built"** list: extra endpoints, deviations, permission decisions, and assumptions not from the prototype.
- Report to the user: endpoints, rules enforced, test count, and the assumptions to confirm.

## Conventions (from docs/API.md)

`/api/v1` prefix · `{"data": ...}` / `{"data": [...], "meta": {page, per_page, total, pages}}` / `{"error": {code, message, details}}` · money as strings `"27000.00"` · ISO 8601 dates (IST business dates) · enum values as stored · IDs plus human codes in responses · opaque bearer session tokens (`user_sessions`, 30-min idle, 12-h max, fresh auth 15 min).
