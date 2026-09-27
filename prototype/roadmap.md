# Prototype roadmap

- [x] Define the visual system, synthetic data model, and reusable CRM components.
- [x] Build the login, shared branch-aware shell, and responsive navigation.
- [x] Build all requested dashboard, sales, student, finance, operations, and AI routes.
- [x] Connect the lead-to-admission workflow and confirmation interactions.
- [x] Verify desktop and mobile navigation, primary workflows, and sample-only labeling.
- [x] Share the updated preview URL after verification.

## Audit corrections

- [x] Add persistent prototype role and branch scope state with role-based branch locking.
- [x] Filter dashboard metrics and operational sample records by the active branch.
- [x] Make counsellor, Lead 360, collections, and task tabs show distinct filtered content.
- [x] Improve counsellor mobile navigation and lead actions without horizontal scrolling.
- [x] Correct student workflow data, mask phone numbers, and label every figure as sample data.
- [x] Add demo feedback for every inert external-style action and correct FlowLink routing.
- [x] Verify desktop and mobile navigation, role switching, branch filtering, and workflows.
- [x] Return the updated preview URL with a concise audit correction summary.

## Frozen CRM consolidated alignment

- [x] Complete symmetric branch-locked UAT roles and global Founder / CEO and Super Admin scopes.
- [x] Align dashboards, leads, exact pipeline, demos, fee discussions, special closing, admissions and dependencies.
- [x] Align Student 360, payments, collections, refunds, tasks, communications, reports and AI terminology.
- [x] Add Course Master, Offer Master, Target Master, Notifications, Placement & Alumni, and Admin / Settings screens.
- [x] Add approved configuration, security, access, integration, backup and incident readiness labels.
- [x] Verify all routes, responsive layouts, branch locks, role switching and visible safety labels.
- [x] Confirm type/build status and record remaining prototype-only gaps.

## Independent verification corrections

- [x] Restrict configuration screens to Founder / CEO and Super Admin in the prototype; add role-aware mobile More hub.
- [x] Separate lead attribution and intake fields, align sample source and workspace tab labels.
- [x] Correct official representative course names/categories and show approved combo names and package prices.
- [x] Clarify target/readiness, placement profiles/openings, AI/report evidence and notification delivery status.
- [x] Verify type check, preview build status, ten target routes at desktop/mobile widths, mobile overflow and branch-manager restrictions after this patch.
- [ ] Production authorization, real integration delivery, full master rendering, operational configuration/verification and future modules remain outside this frontend-only prototype.

## v1.1 Workflow Review (remix only)

- [x] Shared synthetic store: persons, opportunities, invoices, immutable payments + verification events, admissions, batches, demos, tasks; VIJ person IDs fixed; both-branch detail pages; Add Another Course reuses the Person.
- [x] Lead capture form, search, filters, saved views, branch-scoped Bulk Assign, synthetic CSV import review with Duplicate Review and reset.
- [x] Invoice register + detail, linked payment history, verification, linked reversal corrections, watermarked print preview.
- [x] Batch workspace with allocation checks (capacity, wrong branch, curriculum mapping) and separate first-attendance event.
- [x] Demo scheduling/reschedule/cancel/outcome forms and Lead 360 follow-up logging.
- [x] Report drill-downs with period/course/staff/source filters on the fixed 26 Sep 2026 sample date.
- [x] Real staff/contact examples replaced with fictional labels and example.test addresses; exact notice on entry, pages and print previews.
- [ ] Production authorization, real integrations, full master rendering, operational configuration/verification and future modules remain outside this frontend-only prototype.

## v1.1 review fixes (26 Sep 2026)
- [x] Tasks screen reads shared store tasks (follow-ups/demo outcomes appear immediately); overdue derived vs fixed clock 26 Sep 2026 12:00 IST.
- [x] Dashboards derived from shared records (Sep 2026 MTD basis); Oct targets compared only with Oct results (not started).
- [x] Refunds ledger reads linked shared invoice/payment records.
- [x] Payment corrections: pending request → distinct Founder/CEO or Super Admin approval → linked reversal; self-approval and unverified-receipt corrections blocked; Verify only for pending positive receipts.
- [x] Reset restores tasks, correction requests and totals together.
- [x] Import is one consistent batch (mutations use latest state); Student360/Lead360 records filtered by viewer branch.

## v1.1 review follow-up — Add Another Course branch scope (done)
- NewLeadDialog: new opportunity branch/owner restricted to viewer allowedBranches; scoped roles default to their branch, All Branches defaults to Person originalBranch; submit validates branch scope and branch-compatible owner; defaults reset on open and on role/branch switch (useEffect). Person originalBranch preserved.
- Verified as Vijayawada Sales on Rohit (PER-GNT-00139): only Vijayawada offered, LD-25010 created in Vijayawada, original branch stays Guntur. Typecheck/build OK, no JS errors.
