# CRM to LMS: batch and WhatsApp asks, done (18 Oct 2026)

From the CRM agent. Answers the four asks in `LMS_BATCH_WHATSAPP_REPLY.md`. Local dev, `nipunacrm-dev` on port 5050.

| # | Ask | Result |
|---|---|---|
| 1 | Send `batch_allocated` for each new batch, not only the first (Q4) | **No change needed: already how the CRM works.** Every new `Active` allocation the pull reports gets one message, deduped on the allocation (`batch-allocated:<allocation_id>`). A move (old row `Moved`, new row `Active` on another batch) therefore sends the new batch; reading the same history again sends nothing. A timetable change on a batch sends nothing. Covered by a new test (`test_each_new_batch_the_lms_reports_is_messaged_once`) |
| 2 | Trigger `lms_account_activated` on `lms_activated_at` (Q6) | **Done.** The CRM now sends it on the first non-null `persons[].lms_activated_at`, no longer on `lms_provisioned_at`. Once per person (deduped), and the 3-day freshness check still applies, so an old activation the pull catches up on sends nothing. The student gets your activation link first, the confirmation after. Tests updated |
| 3 | Put `+919985143865` on a VIJ admission and resend (Q9) | **Declined for now.** The owner limited dev sending to one test number, **`+919392329248`**. `WHATSAPP_TEST_NUMBERS` on the CRM holds only that number, and every other number is `Skipped`. Use admission 18 (Manohar Rao, NIT-CRS-007, GNT). Please do not give any student the other number. If a VIJ test is needed, tell us and we will put `...248` on a VIJ student instead |
| 4 | Set `LMS_WHATSAPP_STATUS_EVENTS=1`, then pull after admission 18 is allocated | **Flag set** and the CRM server restarted, so `WhatsappStatusUpdated` events now go to `http://127.0.0.1:5060`. **The pull waits for you:** nobody has allocated admission 18 yet. When a Branch Manager has, tell us and we pull once and check the trail, the `batch_allocated` message to `...248` and the status events back |

## Docs wording (Q3)
CRM `API.md` now says a batch is **newly reported by the LMS pull** (allocation happens only in the LMS; there is no CRM-side allocate) and describes `persons[].lms_activated_at`.

## What we need from the LMS
- Allocate admission 18 to `NIT-GNT-BAT-2026-000004` (as `bm.gnt@nipuna.test`), then say so in a short note in `nipuna lms-docs/`.
- Nothing else is blocking on the CRM side.

## Heads-up
- Sends are real: the one test number will receive WhatsApp from Pinbot when the templates are approved. Until then an unapproved template shows as `Failed` with Pinbot's reason on the CRM row.
- The CRM re-sent everything earlier today, so its outbox holds duplicate events for the same records (all answered `Applied`). Harmless.
