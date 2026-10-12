"""Approved WhatsApp templates (Pinbot / A2Z). Each entry keeps the provider name, language, body and the
ordered body values, so a sender fills {{1}}..{{n}} in the right order.

The nine `nipuna_lms_*` templates at the end belong to the LMS (round 6, db 045): the LMS posts them to
POST /lms/whatsapp and the CRM sends them on the one number. Drafts: the LMS repo's docs/whatsapp-templates/."""
from dataclasses import dataclass

HIDDEN = "[hidden]"  # what the CRM keeps in place of a secret value (a reset code, an activation token)


@dataclass(frozen=True)
class WhatsAppTemplate:
    name: str             # exact provider template name
    language: str
    category: str
    body: str
    params: tuple[str, ...]  # meaning of {{1}}..{{n}}, in order
    buttons: tuple[str, ...] = ()  # meaning of each URL button's {{1}}, in button order
    secret: tuple[str, ...] = ()   # values never kept once the message is sent (body_text and params show HIDDEN)
    sender: str = "CRM"            # "LMS": only the LMS may send it, through POST /lms/whatsapp

    @property
    def keys(self) -> tuple[str, ...]:
        """Every value the message needs: the body's, then any button value that isn't also a body value."""
        return self.params + tuple(key for key in self.buttons if key not in self.params)

    def render(self, values: dict) -> str:
        text = self.body
        for i, key in enumerate(self.params, start=1):
            text = text.replace(f"{{{{{i}}}}}", HIDDEN if key in self.secret else str(values[key]))
        return text

    def body_parameters(self, values: dict) -> list[dict]:
        missing = [key for key in self.keys if values.get(key) in (None, "")]
        if missing:
            raise ValueError(f"{self.name} is missing {', '.join(missing)}")
        return [{"type": "text", "text": str(values[key])} for key in self.params]

    def button_components(self, values: dict) -> list[dict]:
        return [{"type": "button", "sub_type": "url", "index": str(i),
                 "parameters": [{"type": "text", "text": str(values[key])}]} for i, key in enumerate(self.buttons)]


REFUND_PAYOUT_COMPLETED = WhatsAppTemplate(
    name="nipuna_refund_payout_completed_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has processed the approved refund of INR {{3}} for case {{4}} "
          "on {{5}}. Payout reference: {{6}}. Please contact Accounts if you need help tracing this payout."),
    params=("customer_name", "branch_name", "refund_amount", "refund_case_no", "payout_date", "payout_reference"),
)

ADVANCE_PAYMENT_VERIFIED = WhatsAppTemplate(
    name="nipuna_advance_payment_verified_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has verified your advance payment of INR {{3}}. Receipt: {{4}}. "
          "Available unallocated credit: INR {{5}}. Course allocation and admission confirmation will be recorded "
          "separately."),
    params=("customer_name", "branch_name", "payment_amount", "receipt_no", "unallocated_credit"),
)

ADVANCE_ALLOCATED = WhatsAppTemplate(
    name="nipuna_advance_allocated_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has allocated INR {{3}} from your existing advance receipt {{4}} "
          "to {{5}}. Remaining unallocated credit: INR {{6}}. This allocation does not represent a new payment."),
    params=("customer_name", "branch_name", "allocated_amount", "receipt_no", "allocated_to", "unallocated_credit"),
)

PAYMENT_CORRECTION_APPLIED = WhatsAppTemplate(
    name="nipuna_payment_correction_applied_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has applied correction {{3}} to payment receipt {{4}}. "
          "Adjustment: INR {{5}}. The original record is retained and the account has been updated. This is an "
          "accounting correction, not a refund payout. Please contact Accounts for details."),
    params=("customer_name", "branch_name", "correction_no", "receipt_no", "adjustment_amount"),
)

INVOICE_BALANCE_CLEARED = WhatsAppTemplate(
    name="nipuna_invoice_balance_cleared_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, confirms that invoice {{3}} now has a remaining balance of "
          "INR 0.00 after verified payments. Please retain your payment receipts. This financial update does not "
          "change your class or course-completion status."),
    params=("customer_name", "branch_name", "invoice_no"),
)

BATCH_ALLOCATED = WhatsAppTemplate(
    name="nipuna_batch_allocated_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has allocated your admission {{3}} for {{4}} to batch {{5}}. "
          "Class details: {{6}}. This confirms batch allocation; please follow the scheduled start instructions."),
    params=("customer_name", "branch_name", "admission_no", "course_name", "batch_name", "class_details"),
)

LMS_ACCOUNT_ACTIVATED = WhatsAppTemplate(
    name="nipuna_lms_account_activated_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, your Nipuna Technologies learning account at {{2}}, associated with admission {{3}}, is "
          "activated. Access to each enrolled course is managed separately. Please reply if you need help signing "
          "in to your account."),
    params=("customer_name", "branch_name", "admission_no"),
)

LMS_COURSE_ACCESS_DELAYED = WhatsAppTemplate(
    name="nipuna_lms_course_access_delayed_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, at Nipuna Technologies, {{2}}, learning access for your admission {{3}} is not ready yet. "
          "Your admission and verified payment record remain recorded. Our academic team is reviewing the access "
          "issue and will notify you when the course is available."),
    params=("customer_name", "branch_name", "admission_no"),
)

REFUND_APPROVED = WhatsAppTemplate(
    name="nipuna_refund_approved_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has approved refund request {{3}} for INR {{4}}. The case is "
          "awaiting Accounts processing. This message confirms approval only; a separate update will confirm the "
          "payout."),
    params=("customer_name", "branch_name", "refund_case_no", "refund_amount"),
)

REFUND_DECLINED = WhatsAppTemplate(
    name="nipuna_refund_declined_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has completed the review of refund request {{3}}. The request "
          "was not approved. Please contact our accounts team and quote this case reference to obtain the recorded "
          "decision and clarification."),
    params=("customer_name", "branch_name", "refund_case_no"),
)

PLACEMENT_APPLICATION_RECORDED = WhatsAppTemplate(
    name="nipuna_placement_application_recorded_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has recorded placement-support application {{3}} for {{4}} "
          "based on your request and consent. Our placement team will track updates for this application. This "
          "acknowledgement does not confirm employer submission or selection."),
    params=("customer_name", "branch_name", "application_no", "application_for"),
)

PLACEMENT_APPLICATION_UPDATE = WhatsAppTemplate(
    name="nipuna_placement_application_update_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has an update to your placement-support application {{3}} for "
          "{{4}}. Recorded status: {{5}}. Please contact the placement team with this reference for clarification."),
    params=("customer_name", "branch_name", "application_no", "application_for", "application_status"),
)

BENEFIT_REQUEST_RECEIVED = WhatsAppTemplate(
    name="nipuna_benefit_request_received_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has recorded your course-benefit request {{3}} linked to "
          "admission {{4}}. The request is pending policy review and approval. This acknowledgement does not grant "
          "an additional course or learning access."),
    params=("customer_name", "branch_name", "benefit_request_no", "admission_no"),
)

ENQUIRY_RECEIVED = WhatsAppTemplate(
    name="nipuna_enquiry_received_u_v3",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has received your enquiry about {{3}}. Your enquiry reference "
          "is {{4}}. We will respond to the questions in your request. Please quote this reference when contacting "
          "our team."),
    params=("customer_name", "branch_name", "enquiry_subject", "enquiry_ref"),
)

INVOICE_ISSUED = WhatsAppTemplate(
    name="nipuna_invoice_issued_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has issued invoice {{3}} for your accepted course plan. Invoice "
          "total: INR {{4}}. Payment plan: {{5}}. Please review the invoice through {{6}}. This invoice is not a "
          "payment receipt."),
    params=("customer_name", "branch_name", "invoice_no", "invoice_total", "payment_plan", "invoice_channel"),
)

DELIVERY_PLAN_ACCEPTED = WhatsAppTemplate(
    name="nipuna_delivery_plan_accepted_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has recorded your delivery plan {{3}} for {{4}} as accepted. "
          "Learning mode: {{5}}. Planned start window: {{6}}. Batch allocation and admission confirmation are "
          "separate updates."),
    params=("customer_name", "branch_name", "delivery_plan_no", "course_name", "learning_mode", "start_window"),
)

DELIVERY_PLAN_CONFIRM = WhatsAppTemplate(
    name="nipuna_delivery_plan_confirm_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has prepared your delivery plan {{3}} for {{4}}. Learning mode: "
          "{{5}}. Planned start window: {{6}}. Please reply YES to confirm this plan. Batch allocation and admission "
          "confirmation are separate updates."),
    params=("customer_name", "branch_name", "delivery_plan_no", "course_name", "learning_mode", "start_window"),
)

COURSE_RECOMMENDATION = WhatsAppTemplate(
    name="nipuna_course_recommendation_mkt_v1",
    language="en",
    category="Marketing",
    body=("Hello {{1}}, are you planning your next learning step? The {{2}} course at Nipuna Technologies may suit "
          "your interest in {{3}}. Our counsellor can review your current skills and explain the prerequisites, "
          "syllabus and fees before you decide. Reply DETAILS to explore this option."),
    params=("customer_name", "course_name", "interest"),
)

COURSE_BROCHURE = WhatsAppTemplate(
    name="nipuna_course_brochure_mkt_v1",
    language="en",
    category="Marketing",
    body=("Hello {{1}}, interested in learning {{2}} at Nipuna Technologies? Explore the syllabus, practical "
          "learning topics and course structure before choosing your training. Reply BROCHURE to receive the course "
          "information or CALLBACK to discuss whether it matches your goals."),
    params=("customer_name", "course_name"),
)

NEW_BATCH = WhatsAppTemplate(
    name="nipuna_new_batch_mkt_v1",
    language="en",
    category="Marketing",
    body=("Hello {{1}}, explore the upcoming {{2}} batch at Nipuna Technologies, {{3}}. Contact our counsellor for "
          "the confirmed start date, timings, learning mode, syllabus and fees. Reply BATCH for details or DEMO to "
          "ask about an available demo session."),
    params=("customer_name", "course_name", "branch_name"),
)

ENQUIRY_FOLLOWUP = WhatsAppTemplate(
    name="nipuna_enquiry_followup_mkt_v1",
    language="en",
    category="Marketing",
    body=("Hello {{1}}, are you still exploring {{2}} training at Nipuna Technologies, {{3}}? Our counsellor can "
          "help you compare the syllabus, learning modes, fees and upcoming batches based on your goals. Reply "
          "INTERESTED for details or CALLBACK for a convenient time to speak."),
    params=("customer_name", "course_name", "branch_name"),
)

STAFF_PAYMENT_STATUS = WhatsAppTemplate(
    name="nipuna_staff_payment_status_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Accounts at Nipuna Technologies has reviewed payment claim {{2}} for {{3}} of INR {{4}}. "
          "Outcome: {{5}}. {{6}} Please open the CRM to see the details and follow up with the learner."),
    params=("staff_name", "transaction_no", "learner_name", "payment_amount", "outcome", "outcome_detail"),
)

INSTALMENT_DUE_U = WhatsAppTemplate(
    name="nipuna_instalment_due_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, this is a friendly reminder from Nipuna Technologies, {{2}}. Instalment {{4}} of invoice {{3}} "
          "(INR {{5}}) is due on {{6}}. To pay, please contact {{7}}. If you have already paid, please ignore this "
          "message."),
    params=("customer_name", "branch_name", "invoice_no", "installment_no", "amount_due", "due_date", "invoice_channel"),
)

INSTALMENT_OVERDUE_U = WhatsAppTemplate(
    name="nipuna_instalment_overdue_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has not yet received instalment {{4}} of invoice {{3}} "
          "(INR {{5}}), which was due on {{6}}. Please make the payment at the earliest by contacting {{7}}. If you "
          "have already paid, please share the details with us so we can update your account."),
    params=("customer_name", "branch_name", "invoice_no", "installment_no", "amount_due", "due_date", "invoice_channel"),
)

DEMO_BOOKED = WhatsAppTemplate(
    name="nipuna_demo_booked_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, your demo session for {{2}} at Nipuna Technologies, {{3}}, is booked for {{4}}. "
          "Venue: {{5}}. Trainer: {{6}}. Please reach a few minutes early. Contact our counsellor if you need to "
          "change the time."),
    params=("customer_name", "course_name", "branch_name", "demo_time", "demo_venue", "trainer_name"),
)

DEMO_RESCHEDULED = WhatsAppTemplate(
    name="nipuna_demo_rescheduled_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, your demo session for {{2}} at Nipuna Technologies, {{3}}, has been moved to {{4}}. "
          "Venue: {{5}}. Trainer: {{6}}. Your earlier time no longer applies."),
    params=("customer_name", "course_name", "branch_name", "demo_time", "demo_venue", "trainer_name"),
)

DEMO_CANCELLED = WhatsAppTemplate(
    name="nipuna_demo_cancelled_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, your demo session for {{2}} at Nipuna Technologies, {{3}}, planned for {{4}}, has been "
          "cancelled. Our counsellor will contact you to arrange another time if you wish."),
    params=("customer_name", "course_name", "branch_name", "demo_time"),
)

DEMO_REMINDER = WhatsAppTemplate(
    name="nipuna_demo_reminder_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, a reminder from Nipuna Technologies, {{2}}: your demo session for {{3}} starts in {{4}}, at "
          "{{5}}. Venue: {{6}}. Trainer: {{7}}."),
    params=("customer_name", "branch_name", "course_name", "starts_in", "demo_time", "demo_venue", "trainer_name"),
)

STAFF_DEMO_REMINDER = WhatsAppTemplate(
    name="nipuna_staff_demo_reminder_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, a reminder from the Nipuna CRM: you take the {{3}} demo for {{2}} in {{4}}, at {{5}}. "
          "Venue: {{6}}."),
    params=("staff_name", "learner_name", "course_name", "starts_in", "demo_time", "demo_venue"),
)

ADMISSION_CONFIRMED = WhatsAppTemplate(
    name="nipuna_admission_confirmed_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, your admission at Nipuna Technologies, {{2}}, is confirmed. Admission number: {{3}}. "
          "Course: {{4}}. Learning mode: {{5}}. Planned start: {{6}}. Our academic team will share your batch and "
          "class details separately."),
    params=("customer_name", "branch_name", "admission_no", "course_name", "learning_mode", "start_date"),
)

STAFF_LEAD_ASSIGNED = WhatsAppTemplate(
    name="nipuna_staff_lead_assigned_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, a new lead has been assigned to you at Nipuna Technologies: {{2}} for {{3}} at the {{4}} branch. "
          "{{5}} Please open the CRM to follow up."),
    params=("staff_name", "learner_name", "course_name", "branch_name", "response_note"),
)

STAFF_LEADS_ASSIGNED = WhatsAppTemplate(
    name="nipuna_staff_leads_assigned_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, {{2}} new leads have been assigned to you at Nipuna Technologies ({{3}}). "
          "Please open the CRM, My leads, to start following them up."),
    params=("staff_name", "lead_count", "branch_name"),
)

STAFF_APPROVAL_WAITING = WhatsAppTemplate(
    name="nipuna_staff_approval_waiting_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, special closing request {{2}} for {{3}} of INR {{4}} at the {{5}} branch is waiting for your "
          "approval at Nipuna Technologies. Please open the CRM to decide it."),
    params=("staff_name", "request_code", "learner_name", "requested_extra", "branch_name"),
)

STAFF_PAYMENT_TO_VERIFY = WhatsAppTemplate(
    name="nipuna_staff_payment_to_verify_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, payment claim {{2}} from {{3}} of INR {{4}} by {{5}} (reference {{6}}) is waiting for "
          "verification at Nipuna Technologies. Please open the CRM to verify it."),
    params=("staff_name", "transaction_no", "learner_name", "payment_amount", "payment_mode", "reference"),
)

TEMPLATES = {t.name: t for t in (REFUND_PAYOUT_COMPLETED, ADVANCE_PAYMENT_VERIFIED, ADVANCE_ALLOCATED,
                                 PAYMENT_CORRECTION_APPLIED, INVOICE_BALANCE_CLEARED, BATCH_ALLOCATED,
                                 LMS_ACCOUNT_ACTIVATED, LMS_COURSE_ACCESS_DELAYED, REFUND_APPROVED,
                                 REFUND_DECLINED, PLACEMENT_APPLICATION_RECORDED,
                                 PLACEMENT_APPLICATION_UPDATE, BENEFIT_REQUEST_RECEIVED,
                                 ENQUIRY_RECEIVED, INVOICE_ISSUED,
                                 DELIVERY_PLAN_ACCEPTED, DELIVERY_PLAN_CONFIRM, COURSE_RECOMMENDATION,
                                 COURSE_BROCHURE, NEW_BATCH,
                                 ENQUIRY_FOLLOWUP, STAFF_PAYMENT_STATUS,
                                 INSTALMENT_DUE_U, INSTALMENT_OVERDUE_U,
                                 DEMO_BOOKED, DEMO_RESCHEDULED, DEMO_CANCELLED, DEMO_REMINDER,
                                 STAFF_DEMO_REMINDER, ADMISSION_CONFIRMED,
                                 STAFF_LEAD_ASSIGNED, STAFF_LEADS_ASSIGNED, STAFF_APPROVAL_WAITING,
                                 STAFF_PAYMENT_TO_VERIFY)}


# ---------------------------------------------------------------- sent by the LMS (round 6)

LMS_PASSWORD_RESET_CODE = WhatsAppTemplate(
    name="nipuna_lms_password_reset_code_auth_v1",
    language="en",
    category="Authentication",
    body=("*{{1}}* is your verification code. For your security, do not share this code.\n"
          "This code expires in 10 minutes."),
    params=("code",),
    buttons=("code",),  # Copy code: the same value
    secret=("code",),
    sender="LMS",
)

LMS_STUDENT_ACTIVATION_LINK = WhatsAppTemplate(
    name="nipuna_lms_student_activation_link_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has created your learning account. Your Student ID is {{3}}. Tap "
          "Activate account below to set your own password. The link works once and expires on {{4}}. If you did not "
          "expect this message, please contact your branch."),
    params=("customer_name", "branch_name", "student_id", "link_expiry"),
    buttons=("activation_token",),
    secret=("activation_token",),
    sender="LMS",
)

LMS_STAFF_ACCOUNT_INVITE = WhatsAppTemplate(
    name="nipuna_lms_staff_account_invite_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, a Nipuna Technologies LMS staff account has been created for you as {{2}} at {{3}}. You will "
          "sign in with your email address. Tap Set password below to choose your password. The link works once and "
          "expires on {{4}}. If you were not expecting this, please tell your Super Admin."),
    params=("staff_name", "role_name", "branch_name", "link_expiry"),
    buttons=("activation_token",),
    secret=("activation_token",),
    sender="LMS",
)

LMS_CLASS_REMINDER = WhatsAppTemplate(
    name="nipuna_lms_class_reminder_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, this is a reminder from Nipuna Technologies, {{2}}. Your class {{3}} for {{4}} starts at {{5}}. "
          "Mode: {{6}}. Please be on time; the Join button opens 15 minutes before the start on your Schedule page."),
    params=("customer_name", "branch_name", "class_title", "course_name", "class_start", "class_mode"),
    sender="LMS",
)

LMS_CLASS_CANCELLED = WhatsAppTemplate(
    name="nipuna_lms_class_cancelled_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has cancelled your class {{3}} for {{4}} that was planned for {{5}}. "
          "Reason: {{6}}. What happens next: {{7}}. This cancellation is not marked as an absence. Please check your "
          "Schedule page for updates."),
    params=("customer_name", "branch_name", "class_title", "course_name", "class_start", "reason", "next_step"),
    sender="LMS",
)

LMS_CLASS_RESCHEDULED = WhatsAppTemplate(
    name="nipuna_lms_class_rescheduled_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has moved your class {{3}} for {{4}}. Old time: {{5}}. New time: "
          "{{6}}. Mode: {{7}}. Please check your Schedule page for the latest details."),
    params=("customer_name", "branch_name", "class_title", "course_name", "old_start", "new_start", "class_mode"),
    sender="LMS",
)

LMS_RESULT_PUBLISHED = WhatsAppTemplate(
    name="nipuna_lms_result_published_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has published your result for {{3}} in {{4}}. You can see your "
          "marks and your trainer's feedback under My Progress in your learning account."),
    params=("customer_name", "branch_name", "assessment_title", "course_name"),
    sender="LMS",
)

LMS_CERTIFICATE_ISSUED = WhatsAppTemplate(
    name="nipuna_lms_certificate_issued_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, has issued your {{3}} for {{4}}. Certificate number: {{5}}. You can "
          "download it from Certificates in your learning account, and anyone can check it with the Verify certificate "
          "link below."),
    params=("customer_name", "branch_name", "certificate_type", "course_name", "certificate_no"),
    buttons=("certificate_no",),  # Verify certificate: /verify/<number>
    sender="LMS",
)

LMS_BATCH_CHANGE_AGREEMENT = WhatsAppTemplate(
    name="nipuna_lms_batch_change_agreement_u_v1",
    language="en",
    category="Utility",
    body=("Hello {{1}}, Nipuna Technologies, {{2}}, proposes a change to your batch for {{3}}. Now: {{4}}. Proposed: "
          "{{5}}. Reason: {{6}}. Please open your learning account and choose Agree or Decline by {{7}}. Nothing "
          "changes for you until you answer."),
    params=("customer_name", "branch_name", "course_name", "current_arrangement", "proposed_arrangement", "reason",
            "reply_by"),
    sender="LMS",
)

LMS_TEMPLATES = {t.name: t for t in (LMS_PASSWORD_RESET_CODE, LMS_STUDENT_ACTIVATION_LINK, LMS_STAFF_ACCOUNT_INVITE,
                                     LMS_CLASS_REMINDER, LMS_CLASS_CANCELLED, LMS_CLASS_RESCHEDULED,
                                     LMS_RESULT_PUBLISHED, LMS_CERTIFICATE_ISSUED, LMS_BATCH_CHANGE_AGREEMENT)}
TEMPLATES.update(LMS_TEMPLATES)
