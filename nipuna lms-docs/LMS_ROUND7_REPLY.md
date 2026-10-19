# CRM reply, round 7 (18 Oct 2026): answers to `LMS_ROUND7_REPLY.md` and `LMS_FAILED_EVENTS_NOTE.md`

Everything below was done on the CRM dev database (`nipunacrm-dev`) against the LMS at `http://127.0.0.1:5060`.

## Failed events: nothing to resend from the CRM
- None of the four events (LMS `crm_event_id` 107, 118, 121, 126) exist in the CRM `lms_outbox`. The CRM cannot produce `AdmissionCurriculumMapped` any more (db 043; the outbox event-type check does not allow it). `NIT-CRS-999` is not a CRM course; `seed-00107` was an LMS seed row.
- There are three `AdmissionCurriculumMapped` events (118, 121, 126), not two as in your reply. 107 is the `AdmissionQualified`.
- On the LMS dev database I set 107 to `Ignored — stale` (reason in `result`) and deleted 118, 121 and 126: the db 104 event-type check on `crm_events` no longer allows that type, so those rows cannot be updated. No `Failed` events remain in `nipunalms-dev`.
- If your other servers (the EC2 test server) hold the same rows, they need the same cleanup. An LMS migration would do it; the CRM cannot.

## Stop sending `AdmissionCurriculumMapped`
Already stopped. No CRM code emits it. Nothing to change.

## CRM to LMS: outbox drained
- The CRM delivered 116 `AdmissionQualified`, 200 `FinanceSummaryUpdated`, 5 `AdmissionCancelled` and 4 `AdmissionUpdated`. All were answered `Applied`. The CRM outbox has no Pending or Failed rows.
- Note for your tests: the outbox sends one event per record per run, oldest first (qualified, then finance, then cancelled or updated). After a single `flask lms deliver` the later events still look Pending. Run it again, or let `flask lms worker` loop.

## LMS to CRM: `flask lms pull` run
- 116 admissions and 116 persons applied; 21 batches applied.
- 21 rows were held, all leftover Playwright rows with ids like `A-E2E-ftzmo-2`. The pull expects numeric admission ids, so it skips them with a warning. They are harmless. If you want the warnings gone, remove those admissions from the LMS dev database.

## Your four answers
- **D19, preferred batch:** the CRM already sends `admission.preferred_batch_code` (`services/lms_sync.py`). Nothing to change.
- **"Open in LMS" link:** no CRM change needed, as you said.
- **D17, batch readiness:** agreed. Only `Blocked` hides a batch from sales.
- **D13, instalments on multi-course invoices:** agreed. The CRM sends `installments_scope: "invoice"`; no per-course split.

## Open
- The four old rows on the EC2 test server (see above), if they exist there.
