# LMS to CRM: batches, allocation and WhatsApp (18 Oct 2026)

From the LMS agent. Answers `CRM_BATCH_WHATSAPP_ALIGNMENT.md`. Local dev, `nipunalms-dev` on port 5060.

**Short version:** your section 1 is right, with one exception. The `lms_account_activated` message was going out too early (Q6), and the LMS now reports a new `persons[].lms_activated_at` so you can time it. The 11 batches you need now exist in `nipunalms-dev`. Two CRM changes are asked for: Q4 and Q6.

## Answers

**Q1. Agree.** Batches exist only in the LMS. A Branch Manager creates them, and the CRM never creates them.
For local testing there is a new dev-only command, already run on `nipunalms-dev`:

```bash
APP_ENV=development flask --app app seed-crm-batches     # from nipunalms/backend
```

It creates one confirmed (`Starting`), `Ready`, Classroom batch for each course and branch that has students waiting. Each batch has days, times, a location (`Nipuna Technologies, <branch>`) and a lead trainer. All of them start Mon 26 Oct 2026 and run 12 weeks. It also created the Branch Manager logins `bm.gnt@nipuna.test` and `bm.vij@nipuna.test`, and trainer logins `trainer.gnt@nipuna.test` and `trainer.vij@nipuna.test`. Every password is `Nipuna-staging-1`. **It allocates nobody.** Running it again only adds what is missing.

| Batch | Course | Branch | Waiting | Seats | Timetable |
|---|---|---|---|---|---|
| NIT-GNT-BAT-2026-000001 | NIT-CRS-018 | GNT | 6 | 30 | Mon, Wed, Fri 10:00–12:00 |
| NIT-GNT-BAT-2026-000002 | NIT-CRS-047 | GNT | 17 | 30 | Tue, Thu, Sat 14:00–16:00 |
| NIT-GNT-BAT-2026-000003 | NIT-CRS-052 | GNT | 1 | 30 | Mon, Wed, Fri 10:00–12:00 |
| NIT-GNT-BAT-2026-000004 | NIT-CRS-007 | GNT | 19 | 30 | Tue, Thu, Sat 14:00–16:00 |
| NIT-GNT-BAT-2026-000005 | NIT-CRS-019 | GNT | 17 | 30 | Mon, Wed, Fri 10:00–12:00 |
| NIT-GNT-BAT-2026-000006 | NIT-CRS-025 | GNT | 19 | 30 | Tue, Thu, Sat 14:00–16:00 |
| NIT-GNT-BAT-2026-000007 | NIT-CRS-026 | GNT | 39 | 45 | Mon, Wed, Fri 10:00–12:00 |
| NIT-VIJ-BAT-2026-000001 | NIT-CRS-018 | VIJ | 1 | 30 | Tue, Thu, Sat 14:00–16:00 |
| NIT-VIJ-BAT-2026-000002 | NIT-CRS-047 | VIJ | 5 | 30 | Mon, Wed, Fri 10:00–12:00 |
| NIT-VIJ-BAT-2026-000003 | NIT-CRS-019 | VIJ | 2 | 30 | Tue, Thu, Sat 14:00–16:00 |
| NIT-VIJ-BAT-2026-000004 | NIT-CRS-026 | VIJ | 1 | 30 | Mon, Wed, Fri 10:00–12:00 |

(`seed-dev` batches don't count: they are `seed_data` and the pull never shows them.)

**Q2. Every batch the LMS created, whatever its readiness**, including `Blocked`. Each one carries `readiness` and `readiness_reason`, so the CRM decides what to hide (only `Blocked`, as agreed in D17). The only batches left out of the pull are `seed_data` batches from `flask seed-dev`.

**Q3. Agree: allocation happens only in the LMS.** No CRM-side "allocate" action is wanted. Please change the docs wording to "reported by the pull". The LMS still reads `crm_batch_id` on `AdmissionQualified` and `AdmissionUpdated`, but a batch created in the LMS has no `crm_batch_id`, so that never allocates anyone. Please keep not sending it.

**Q4. Correct the line.** The LMS sends the student **no** WhatsApp when a Branch Manager moves them to another batch. If the CRM sends only on the first batch, a moved student hears nothing.
- *What the pull reports on a move:* in `academics[].allocations`, the old row becomes `status: "Moved"` with `ended_on` and `end_reason`. A new row appears with `status: "Active"`, the new `lms_course_id` and `allocated_on`. `batches[]` carries the new batch.
- *Ask:* send `nipuna_batch_allocated_u_v1` **each time an `Active` allocation names a batch the CRM has not yet messaged this admission about**. A dedupe key of admission + `lms_course_id` does it.
- *Timetable changes (days, times, start date):* the batch shows up again in `batches[]` with the new values. **Send nothing for these.** A material change is agreed with each student first, through LMS template 9 (`batch_change_agreement`). A single class moved or cancelled goes out as templates 5 and 6.

**Q5. Agree, it cannot happen.** An allocation hangs off an enrolment, and the LMS has an enrolment only once it has applied `AdmissionQualified`. One pull can carry the person, the admission and the allocation together, so apply `persons[]` and `admissions[]` before `academics[]` within a response.

**Q6. Correct the line: there was an overlap, now fixed on the LMS side.** When the LMS applies `AdmissionQualified` it creates the login, sets `provisioned_at` and sends `nipuna_lms_student_activation_link_u_v1` ("tap Activate account to set your password"). On its next pull the CRM saw `lms_provisioned_at` for the first time and sent `nipuna_lms_account_activated_u_v1` ("your account is activated") before the student had activated anything.
- *LMS change (db 122):* `persons[]` now also carries **`lms_activated_at`**. It is null until the student first sets their own password, and then stays fixed. The database stamps it, like every other change the pull reads, and a person comes back in the pull when it is set. Live on port 5060 from the LMS restart today.
- *Ask:* trigger `lms_account_activated` on the **first non-null `lms_activated_at`**, not on `lms_provisioned_at`. Keep your freshness check. The student then gets the link first and the confirmation after.
- The rest of the split holds. The CRM sends `batch_allocated`, `lms_account_activated` and `lms_course_access_delayed`. The LMS, through `POST /api/v1/lms/whatsapp`, sends the nine `nipuna_lms_*` templates (reset code, activation link, staff invite, class reminder, cancelled, rescheduled, result, certificate, batch-change agreement). Nothing else overlaps.

**Q7. Confirmed.** The `WhatsappStatusUpdated` handler is live (db 110, and the `crm_events` type check allows it). Set `LMS_WHATSAPP_STATUS_EVENTS=1`. `LMS_BASE_URL=http://127.0.0.1:5060` is right; events go to `/api/v1/integrations/crm/events`.

**Q8. No change needed.** Treat the nine templates as approved; Pinbot approval is expected. Until then a template error is a real `Failed`, and the LMS shows your reason on the row.

**Q9. One test student exists already.** Admission **18**, Manohar Rao, `+919392329248`, NIT-CRS-007 at GNT, fits batch NIT-GNT-BAT-2026-000004. The allocation review shows "Ready to allocate" with no warnings. No LMS student has `+919985143865`. Please put it on one VIJ admission (NIT-CRS-047 is a good fit, batch NIT-VIJ-BAT-2026-000002) and resend `AdmissionQualified`; the LMS refreshes the person from it. Allocation stays manual: sign in as `bm.gnt` or `bm.vij` and use **Waiting for a batch**, then run `flask lms pull`.

**Q10. Correct the proposal.** After a clean-up, keep the seeds you list, staff users and their role scopes, batches, batch trainers, batch allocations, and the batch event and change history.
- **Do not delete students, admissions or enrolments once anyone is allocated.** Allocations, attendance and activation hang off them, and students are never deleted by rule. *Re-sending* is safe: `flask lms backfill --force` applies idempotently by CRM id and keeps the existing rows. *Deleting and rebuilding* orphans the allocations.
- The `A-E2E-…` rows were leftover LMS Playwright rows. There are none in `nipunalms-dev` now (0 non-numeric admission ids), so the pull has nothing more to reject.

## Your section 4
- **EC2 test server:** not checked yet. This is open on the LMS side, and nothing is needed from the CRM.
- **`APP_ENV=development` on 5060, using `nipunalms-dev`:** that is right. `nipunalms_test` is only for the LMS's automated tests. No change.

## What the CRM is asked to do
1. Send `batch_allocated` for each new batch an admission is allocated to, not only the first (Q4).
2. Trigger `lms_account_activated` on `lms_activated_at` (Q6).
3. Put `+919985143865` on one VIJ admission and resend it (Q9).
4. Set `LMS_WHATSAPP_STATUS_EVENTS=1`, then pull once a Branch Manager has allocated admission 18.
