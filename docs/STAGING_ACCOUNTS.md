# Nipuna CRM — Staging Accounts

Login accounts for testing. Locally they exist **only in the dev database `nipunacrm-dev`**, created by `flask --app app seed-dev` (re-created on every reseed); they are not in the local `nipunacrm`. They are also loaded into the **EC2 test server's** `nipunacrm` (https://13-201-78-226.sslip.io), see [DEPLOYMENT.md](DEPLOYMENT.md#database).

- URL: http://localhost:5173 (API on :5050 with `APP_ENV=development` — see [DEVELOPMENT.md](DEVELOPMENT.md#4-running))
- Password for every account: **`Nipuna-staging-1`**

## One account per role

| Role | Email | Branch | Lands on |
|---|---|---|---|
| Founder / CEO | `founder@nipuna.test` | All branches | Dashboard |
| Super Admin | `admin@nipuna.test` | All branches | Dashboard (+ Admin / Settings) |
| Branch Manager | `bm.gnt@nipuna.test` | Guntur | Branch Manager view |
| Sales (counsellor) | `sales.gnt@nipuna.test` | Guntur | Counsellor Workspace |
| Front Office | `fo.gnt@nipuna.test` | Guntur | Counsellor Workspace |
| Accounts | `accounts.gnt@nipuna.test` | Guntur | Dashboard |
| Academic Coordinator | `coordinator.gnt@nipuna.test` | Guntur | Dashboard |
| Trainer | `trainer.g1@nipuna.test` | Guntur | Dashboard |
| Placement | `placement.gnt@nipuna.test` | Guntur | Dashboard |
| HR | `hr.gnt@nipuna.test` | Guntur | Dashboard |

## Vijayawada accounts

Same roles, same password: `bm.vij`, `sales.vij`, `fo.vij`, `accounts.vij`, `coordinator.vij`, `placement.vij`, `hr.vij` (all `@nipuna.test`). Trainers: `trainer.v1@nipuna.test`, `trainer.v2@nipuna.test`. Guntur also has a second trainer, `trainer.g2@nipuna.test`.

## Notes

- There is no Student account: the role exists, but the CRM has no student-facing screens.
- Display names match the prototype, e.g. `sales.gnt` is "Counsellor A (GNT)", `fo.gnt` is "Front Office B (GNT)".
- The e2e tests use these accounts (`frontend/e2e/helpers.ts`) — don't change their passwords or deactivate them.
- Five failed logins lock an account for 15 minutes; a reseed resets everything.
- Never reuse this password or these accounts outside the dev database and the EC2 test server. On the server they must go before any real data does.

## V4 walkthrough (seeded records)

| Scenario | Record | Sign in as |
|---|---|---|
| Qualified lead, ready to convert | Ravi Teja (Vijayawada, Leads) | `fo.vij` / `bm.vij` |
| Deals at every stage, Next actions | Deal pipeline, either branch | `sales.gnt`, `sales.vij`, `bm.*` |
| Delivery plan accepted, ready to invoice | Karthik Reddy (Vijayawada) — "Prepare the invoice" | `sales.vij` |
| Two courses on one invoice, split tenders, two admissions for one person | Meera Joshi · `INV-GNT-2627-0005` | `sales.gnt`, `accounts.gnt` |
| Sample case: ₹22,000 invoice with a ₹5,000 cash claim pending | Sana Begum · `INV-VIJ-2627-0004` — verify it on Payments & receipts | `accounts.vij` |
| Overdue instalment with a promise to pay | Divya Sree · `INV-GNT-2627-0002` (Collections) | `accounts.gnt` |
| Long payment gap | Charan Teja (Performance tab → Long-gap plans) | `accounts.vij` |
