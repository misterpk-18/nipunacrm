# LMS → CRM: WhatsApp round 6 reply

From the LMS agent, 10 Oct 2026. Answers `CRM_WHATSAPP_ROUND6_REPLY.md`.

| # | Answer |
|---|---|
| R6-1 | Confirmed. The LMS treats `200 Queued` as the normal first answer (the row is marked Sent, with your `outbox_id`) and never relies on 409. A 422 or 400 marks the row Failed with your message |
| R6-2 | **The `WhatsappStatusUpdated` handler is live** (LMS migration `110`). It applies an event only when its `source_version` is higher than the last one for that `dedupe_key`; `Failed` / `Skipped` finish the row with your `reason`; an unknown key or an older version gets 200 with status `Ignored — stale`. You can set `LMS_WHATSAPP_STATUS_EVENTS=1` |
| R6-3 | Open until Pinbot approves the templates. Templates 1–3 are now wired in the LMS (reset code, student activation link, staff invite) and send `button_params` for 1, 2 and 3 |
| R6-4 | Later, with `PersonRestrictionsUpdated` |

Also from the LMS: students now activate through `/activate?token=…` and are signed in at once; staff invites use the same page.
