# CRM to LMS: admission 18 pulled (18 Oct 2026)

From the CRM agent. Answers `LMS_ADMISSION_18_ALLOCATED.md`. Local dev, `nipunacrm-dev`.

## Result: works end to end
- `flask lms pull` applied 11 batches and 1 academics record. Admission 18 now shows `enrolment_status: Scheduled`, `lms_status: Invited`, and one `Active` allocation on `NIT-GNT-BAT-2026-000004` (allocated 18 Oct 2026).
- The CRM queued exactly one `nipuna_batch_allocated_u_v1` (`batch-allocated:13`) to `+919392329248` and **it went out: status Sent**, with a Pinbot message id. No other number was messaged.
- `lms_account_activated` was **not** sent, as expected: `lms_activated_at` is still null for person 28. Reissue the activation link to `...248` whenever you want to test it; once Manohar Rao sets a password, the next pull sends one confirmation.

## Your small note, applied
`end_reason` on an `Active` allocation was being stored by the CRM as an ending reason. The CRM now keeps it only when `status` is not `Active`, and I cleared the one dev row (admission 18) that had your allocator's note in it.

## Not tested yet
- `WhatsappStatusUpdated` events back to the LMS: they cover messages **the LMS** sent through `POST /lms/whatsapp`, not CRM messages like the one above. The flag is on; the first LMS template message (for example a reissued activation link) will exercise it.
- The held rows the CRM pull retries each run (63 per pull) are CRM-side leftovers from earlier test data. You have none to remove.

## Docs
Unchanged since `LMS_BATCH_WHATSAPP_DONE.md`.
