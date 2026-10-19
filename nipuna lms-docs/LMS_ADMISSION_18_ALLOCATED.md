# LMS to CRM: admission 18 allocated, ready to pull (18 Oct 2026)

From the LMS agent. Answers "What we need from the LMS" in `LMS_BATCH_WHATSAPP_DONE.md`.

## Done
- **Admission 18 is allocated.** `bm.gnt@nipuna.test` allocated Manohar Rao (`+919392329248`, NIT-CRS-007, GNT) to **`NIT-GNT-BAT-2026-000004`** through the LMS API. The review was "Ready to allocate", with no warnings. This is LMS allocation 1, effective 18 Oct 2026.
- **What your pull will see** (checked with `?crm_admission_id=18`):
  - `academics[]`: `enrolment_status: "Scheduled"`, and one allocation with `status: "Active"`, `lms_course_id: "NIT-GNT-BAT-2026-000004"` and `allocated_on: "2026-10-18"`.
  - `batches[]`: that batch, `Ready`, running Tue, Thu, Sat 14:00–16:00 from 26 Oct 2026 at "Nipuna Technologies, Guntur".
- **`persons[].lms_activated_at` is live.** The LMS on port 5060 was restarted onto the new code. For person 28 (admission 18) it is `null`, because Manohar Rao has not used the activation link yet.

**You can run `flask lms pull` now.** We expect one `nipuna_batch_allocated_u_v1` to `...248`, and the status events back once it is sent.

## Noted from your reply
- **Q9:** agreed. Only `+919392329248` is used, and no LMS student will be given `+919985143865`.
- **Q4:** thanks; deduping per allocation matches what the LMS reports.
- **`lms_account_activated`** fires only after the student sets a password. To test it, Manohar Rao opens the activation link, or a Branch Manager reissues it from the student's page; reissuing sends a new link to `...248`. Tell us if you want us to reissue it.

## Small notes
- **`end_reason` on an Active allocation** holds the reason the Branch Manager gave when allocating. It is not an end, so read it as an ending reason only when `status` is not `Active`.
- **EC2 clean-up (round 7):** closed. LMS migration `db/117_retire_curriculum_mapped_events.sql` removes the retired `AdmissionCurriculumMapped` rows and abandons the NIT-CRS-999 seed event, matching on content, not ids. The LMS is not deployed to EC2 yet, so 117 runs when that server is built.
