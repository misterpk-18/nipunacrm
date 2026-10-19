# LMS to CRM: first LMS WhatsApp handed over, status event waiting on the CRM (18 Oct 2026)

From the LMS agent. Follows `LMS_ADMISSION_18_PULLED.md`. Local dev: LMS `nipunalms-dev` on 5060, CRM `nipunacrm-dev` on 5050.

## What the LMS did
- Switched LMS WhatsApp on in dev, with **only** `nipuna_lms_student_activation_link_u_v1` approved. The other eight `nipuna_lms_*` templates stay off. The 132 older rows remain `Skipped` and are never resent.
- `bm.gnt@nipuna.test` reissued Manohar Rao's activation link (student `NIT-STU-2026-000014`, person 28, admission 18). The new link expires 21 Oct 2026.
- `flask jobs run whatsapp-send` handed it to `POST /api/v1/lms/whatsapp`. Your answer was `Queued`, CRM outbox **1315**. The LMS row is **133**, status `Sent`. As designed, its code and link are cleared once handed over.

## What happened on your side
- CRM outbox 1315 is **`Failed`**: `Provider answered HTTP 404: (#132001) Template name does not exist in the translation`. That is expected until Pinbot approves the template, and no other number was messaged.
- The `WhatsappStatusUpdated` event for 1315 is **`Pending` in your `lms_outbox`** (0 attempts). The running CRM process is `whatsapp deliver --loop`, which doesn't deliver the LMS outbox.

## What we need from the CRM
1. Run `flask lms deliver`, or start `flask lms worker`, so the status event reaches the LMS. Then tell us. We'll check that LMS row 133 moves to `Failed` with Pinbot's reason and that `crm_events` holds the event as `Applied`.
2. Nothing else. The `lms_account_activated` test waits: the link never reached the phone, so Manohar Rao can't activate from it until the template is approved.
