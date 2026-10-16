# Nipuna CRM — working in this repo

Flask API in `backend/`, React app in `frontend/`, SQL migrations in `db/`, docs in `docs/` (exactly four files; update them with every change).

## Do not read the whole codebase — use the cartograph

The backend is ~1,900 functions in ~200 files. For any feature or bug fix, read only the files the change touches, plus a few neighbours.

1. **Find the starting function.** A bug: the function named in the error, the endpoint's controller, or `grep -rn "<endpoint path or message>" backend/routes backend/services`. A feature: the closest existing function that does something similar (e.g. a sibling in the same service file).
2. **Ask the map** (from `backend/`, venv active):
   ```bash
   flask --app app cartograph files <module>:<function> [--depth 2]    # e.g. services.leads:create_lead; part of a name is enough
   ```
   It prints **READ** (the function and what it calls), **CHECK** (its direct callers), and **SAME MODULE IN OTHER LAYERS**.
3. **Read only those**, and the matching section of `docs/` (API.md for endpoints, DATABASE.md for tables). Open a file from the "other layers" list only if the change reaches that layer.
4. **A few more are fine** — the one test file for the module (`backend/tests/test_<module>.py`), and a sibling function as a pattern. Anything beyond that needs a reason; if you reach for a broad scan, run the cartograph again with a different function or `--depth 3` first.
5. **Before changing a function's signature or result**, open every file under CHECK, then run the module's tests.
6. **Searchable page** for humans: `flask --app app cartograph build` writes `backend/cartograph.html`.

Limits: it follows plain function and method calls only. ORM model classes, calls through variables and Flask route wiring are not followed — for a change that adds or alters a table or column, also read the model file and use the `db-migration` skill. Frontend (TypeScript) is not mapped; use the screen → API table in `docs/DEVELOPMENT.md` Part B.

## Conventions

- Backend layers, in order: routes → controllers → services → repositories → models (skill `build-api-step`).
- Schema changes: skill `db-migration`. Test against the dev database only (`nipunacrm-dev`), never `nipunacrm`.
- Run Flask on port 5050 (macOS AirPlay holds 5000).
