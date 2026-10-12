"""Which CRM event sends which WhatsApp template, and with which values (templates: services/whatsapp_templates.py).

Each function is called by the service that made the change, inside its transaction, after the change is flushed. None
of them raises: a message is a courtesy to the learner and never a reason to refuse a payment, refund or invoice.

| Event                                              | Template                                  |
|----------------------------------------------------|-------------------------------------------|
| Advance payment verified (no invoice yet)          | nipuna_advance_payment_verified_u_v1      |
| Payment verified and the invoice balance is 0      | nipuna_invoice_balance_cleared_u_v1       |
| Invoice issued                                     | nipuna_invoice_issued_u_v1                |
| Refund approved (a waiver sends nothing)           | nipuna_refund_approved_u_v1               |
| Refund declined                                    | nipuna_refund_declined_u_v1               |
| Refund payout completed                            | nipuna_refund_payout_completed_u_v1       |
| Verified advance applied to an invoice             | nipuna_advance_allocated_u_v1             |
| Payment correction approved                        | nipuna_payment_correction_applied_u_v1    |
| Delivery plan accepted                             | nipuna_delivery_plan_accepted_u_v1        |
| Delivery plan sent for the learner's YES           | nipuna_delivery_plan_confirm_v1           |
| Batch allocated (CRM, or new from the LMS)         | nipuna_batch_allocated_u_v1               |
| LMS account created (first time, from the LMS)     | nipuna_lms_account_activated_u_v1         |
| LMS could not set up the course                    | nipuna_lms_course_access_delayed_u_v1     |
| Placement application recorded / stage changed     | nipuna_placement_application_*_u_v1       |
| New enquiry entered by staff                       | nipuna_enquiry_received_u_v3              |
| Unpaid instalment: 3 days before / due day / 3 after | nipuna_instalment_due_u_v1 / nipuna_instalment_overdue_u_v1 |

A payment against an invoice sends nothing of its own: the approved templates are for an advance and for a cleared
balance. nipuna_benefit_request_received_u_v1 has no event: the CRM has no course-benefit request record yet.
Messages that mirror old news (a batch the LMS allocated a week ago, an account provisioned last month) are not sent:
FRESH_DAYS. Stop contact (db 031) is not applied: it stops outreach, and these messages report the learner's own money.
"""
import functools
import logging
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import text

from config.database import db
from models import Admission, Company, Enquiry, Invoice, Payment, Person, RefundCase
from services import whatsapp
from services import whatsapp_templates as templates
from services.reports import business_now

logger = logging.getLogger(__name__)

FRESH_DAYS = 2  # something the LMS reports about the past is not news


def _safe(function):
    """Run inside a savepoint and swallow failures, so the business change always goes through."""
    @functools.wraps(function)
    def wrapper(*args, **kwargs):
        try:
            with db.session.begin_nested():
                return function(*args, **kwargs)
        except Exception:
            logger.exception("WhatsApp notification %s failed", function.__name__)
            return None
    return wrapper


def money(amount: Decimal | int | float | str) -> str:
    return f"{Decimal(amount):.2f}"


def day(value) -> str:
    return value.strftime("%d %b %Y")


def _unallocated_credit(person_id: int) -> Decimal:
    return db.session.execute(text(
        "SELECT COALESCE(SUM(amount), 0) FROM unallocated_advances "
        "WHERE person_id = :person AND verification_status = 'Verified'"), {"person": person_id}).scalar()


@_safe
def payment_verified(payment: Payment) -> None:
    """After Accounts verifies a positive payment: an advance, or the payment that clears an invoice."""
    if payment.entry_type != "Payment":
        return
    person, branch = payment.person, payment.collecting_branch
    if payment.invoice_id is None:
        whatsapp.queue(
            templates.ADVANCE_PAYMENT_VERIFIED, person=person, branch_id=branch.branch_id, source_type="payment",
            source_id=payment.payment_id, event_key=f"payment-verified:{payment.payment_id}",
            values={"customer_name": person.full_name, "branch_name": branch.branch_name,
                    "payment_amount": money(payment.amount), "receipt_no": payment.receipt_number,
                    "unallocated_credit": money(_unallocated_credit(person.person_id))})
        return
    row = db.session.execute(text(
        "SELECT invoice_number, outstanding, status::text FROM invoice_balances WHERE invoice_id = :id"),
        {"id": payment.invoice_id}).one()
    if row.status == "Cancelled" or row.outstanding > 0:
        return
    whatsapp.queue(
        templates.INVOICE_BALANCE_CLEARED, person=person, branch_id=branch.branch_id, source_type="payment",
        source_id=payment.payment_id, event_key=f"invoice-balance-cleared:{payment.invoice_id}:{payment.payment_id}",
        values={"customer_name": person.full_name, "branch_name": branch.branch_name,
                "invoice_no": row.invoice_number})


@_safe
def invoice_issued(invoice: Invoice, payment_plan: str) -> None:
    """After an invoice is issued; payment_plan is the label of its own schedule ("Full", "50/50", "50/25/25")."""
    person = invoice.person
    branch = invoice.collecting_branch
    whatsapp.queue(
        templates.INVOICE_ISSUED, person=person, branch_id=branch.branch_id, source_type="invoice",
        source_id=invoice.invoice_id, event_key=f"invoice-issued:{invoice.invoice_id}",
        values={"customer_name": person.full_name, "branch_name": invoice.issuer_branch_name or branch.branch_name,
                "invoice_no": invoice.invoice_number, "invoice_total": money(invoice.billed_amount),
                "payment_plan": payment_plan, "invoice_channel": whatsapp_channel()})


def whatsapp_channel() -> str:
    from flask import current_app

    return current_app.config.get("WHATSAPP_INVOICE_CHANNEL") or "your Nipuna counsellor"


def _refund_values(case: RefundCase) -> dict:
    admission = case.admission
    return {"customer_name": admission.person.full_name, "branch_name": admission.service_branch.branch_name,
            "refund_case_no": case.case_code}


@_safe
def refund_decided(case: RefundCase) -> None:
    """After a refund case is decided: approved or declined (a waiver changes the balance, not the learner's money)."""
    admission = case.admission
    common = dict(person=admission.person, branch_id=admission.service_branch_id, source_type="refund_case",
                  source_id=case.refund_case_id)
    if case.refund_decision == "Refund Approved":
        whatsapp.queue(templates.REFUND_APPROVED, event_key=f"refund-approved:{case.refund_case_id}",
                       values={**_refund_values(case), "refund_amount": money(case.approved_refund_amount)}, **common)
    elif case.refund_decision == "Rejected":
        whatsapp.queue(templates.REFUND_DECLINED, event_key=f"refund-declined:{case.refund_case_id}",
                       values=_refund_values(case), **common)


@_safe
def refund_paid(case: RefundCase) -> None:
    """After the payout is marked Completed (reconciled)."""
    admission = case.admission
    paid_on = case.payout_completed_at.astimezone(business_now().tzinfo)
    whatsapp.queue(
        templates.REFUND_PAYOUT_COMPLETED, person=admission.person, branch_id=admission.service_branch_id,
        source_type="refund_case", source_id=case.refund_case_id, event_key=f"refund-paid:{case.refund_case_id}",
        values={**_refund_values(case), "refund_amount": money(case.payout_amount or case.approved_refund_amount),
                "payout_date": day(paid_on), "payout_reference": case.payout_reference})


@_safe
def advance_allocated(payment: Payment, parts: list) -> None:
    """After Accounts puts a verified advance on an invoice: parts are the (invoice line, amount) pairs it covered."""
    if payment.verification_status != "Verified" or not payment.receipt_number:
        return
    person, branch = payment.person, payment.collecting_branch
    courses = ", ".join(dict.fromkeys(line.course.course_title for line, _ in parts))
    whatsapp.queue(
        templates.ADVANCE_ALLOCATED, person=person, branch_id=branch.branch_id, source_type="payment",
        source_id=payment.payment_id, event_key=f"advance-allocated:{payment.payment_id}",
        values={"customer_name": person.full_name, "branch_name": branch.branch_name,
                "allocated_amount": money(payment.amount), "receipt_no": payment.receipt_number,
                "allocated_to": f"{courses} (invoice {payment.invoice.invoice_number})" if payment.invoice else courses,
                "unallocated_credit": money(_unallocated_credit(person.person_id))})


@_safe
def correction_applied(request) -> None:
    """After a payment correction is approved (the reversal is appended; the original record stays)."""
    payment = request.payment
    person, branch = payment.person, payment.collecting_branch
    whatsapp.queue(
        templates.PAYMENT_CORRECTION_APPLIED, person=person, branch_id=branch.branch_id, source_type="payment",
        source_id=payment.payment_id, event_key=f"payment-correction:{request.correction_request_id}",
        values={"customer_name": person.full_name, "branch_name": branch.branch_name,
                "correction_no": request.request_code, "receipt_no": payment.receipt_number,
                "adjustment_amount": money(request.amount)})


@_safe
def delivery_plan_accepted(lead, plan) -> None:
    """After the learner's acceptance of a delivery plan is captured."""
    person = lead.person
    whatsapp.queue(
        templates.DELIVERY_PLAN_ACCEPTED, person=person, branch_id=plan.service_branch_id,
        source_type="delivery_plan", source_id=plan.delivery_plan_id, event_key=f"delivery-plan-accepted:{plan.delivery_plan_id}",
        values={"customer_name": person.full_name, "branch_name": plan.service_branch.branch_name,
                "delivery_plan_no": plan.plan_code, "course_name": lead.course.course_title if lead.course else None,
                "learning_mode": plan.delivery_mode,
                "start_window": f"From {day(plan.planned_start_date)}" if plan.planned_start_date
                else "To be confirmed by our team"})


def _plan_values(lead, plan) -> dict:
    window = f"From {day(plan.planned_start_date)}" if plan.planned_start_date else "To be confirmed by our team"
    if plan.preferred_lms_batch_label:
        window += f" (preferred batch: {plan.preferred_lms_batch_label})"
    return {"customer_name": lead.person.full_name, "branch_name": plan.service_branch.branch_name,
            "delivery_plan_no": plan.plan_code, "course_name": lead.course.course_title if lead.course else None,
            "learning_mode": plan.delivery_mode, "start_window": window}


@_safe
def delivery_plan_confirmation(lead, plan, attempt: int):
    """Staff put the plan to the learner: "Reply YES to confirm". Each press is its own message (attempt 1, 2 ...).
    Returns the outbox row (Queued, or Skipped with a reason), None when it could not be written. The template
    needs Pinbot approval before sending is switched on."""
    return whatsapp.queue(
        templates.DELIVERY_PLAN_CONFIRM, person=lead.person, branch_id=plan.service_branch_id,
        source_type="delivery_plan_confirm", source_id=plan.delivery_plan_id,
        event_key=f"delivery-plan-confirm:{plan.delivery_plan_id}:{attempt}", values=_plan_values(lead, plan))


def _is_fresh(on) -> bool:
    return on is None or (business_now().date() - on) <= timedelta(days=FRESH_DAYS)


def class_details(batch, joining_date=None) -> str:
    parts = []
    if batch.schedule_days:
        times = ""
        if batch.start_time and batch.end_time:
            times = f" {batch.start_time:%I:%M %p} to {batch.end_time:%I:%M %p}".replace(" 0", " ")
        parts.append(f"{batch.schedule_days}{times}")
    else:
        parts.append("Timing to be confirmed by the academic team")
    starts = joining_date or batch.start_date
    if starts:
        parts.append(f"{'joining' if joining_date else 'batch starts'} {day(starts)}")
    if batch.location:
        parts.append(batch.location)
    return ", ".join(parts)


@_safe
def batch_allocated(allocation) -> None:
    """After a learner is put on a batch (by the CRM, or newly reported by the LMS: older news is not sent)."""
    if allocation.status != "Active" or not _is_fresh(allocation.lms_allocated_on):
        return
    admission, batch = allocation.admission, allocation.batch
    whatsapp.queue(
        templates.BATCH_ALLOCATED, person=admission.person, branch_id=admission.service_branch_id,
        source_type="batch_allocation", source_id=allocation.allocation_id,
        event_key=f"batch-allocated:{allocation.allocation_id}",
        values={"customer_name": admission.person.full_name, "branch_name": admission.service_branch.branch_name,
                "admission_no": admission.admission_code, "course_name": batch.course.course_title,
                "batch_name": batch.batch_name, "class_details": class_details(batch, allocation.joining_date)})


def _latest_admission(person_id: int) -> Admission | None:
    return db.session.execute(
        db.select(Admission).where(Admission.person_id == person_id, Admission.enrolment_status != "Cancelled")
        .order_by(Admission.admission_id.desc()).limit(1)).scalar_one_or_none()


@_safe
def lms_account_activated(person: Person, provisioned_at) -> None:
    """The first time the LMS reports a login for the person (not for old accounts the pull is catching up on)."""
    if provisioned_at is not None and not _is_fresh(provisioned_at.astimezone(business_now().tzinfo).date()):
        return
    admission = _latest_admission(person.person_id)
    branch = admission.service_branch if admission else person.registered_branch
    whatsapp.queue(
        templates.LMS_ACCOUNT_ACTIVATED, person=person, branch_id=branch.branch_id, source_type="person",
        source_id=person.person_id, event_key=f"lms-account-activated:{person.person_id}",
        values={"customer_name": person.full_name, "branch_name": branch.branch_name,
                "admission_no": admission.admission_code if admission else None})


@_safe
def lms_access_delayed(admission: Admission) -> None:
    """The LMS could not set up the admission's learning access (its event failed for good)."""
    whatsapp.queue(
        templates.LMS_COURSE_ACCESS_DELAYED, person=admission.person, branch_id=admission.service_branch_id,
        source_type="admission", source_id=admission.admission_id, event_key=f"lms-access-delayed:{admission.admission_id}",
        values={"customer_name": admission.person.full_name, "branch_name": admission.service_branch.branch_name,
                "admission_no": admission.admission_code})


def _application_values(application) -> dict:
    from models import PlacementProfile

    profile = db.session.get(PlacementProfile, application.profile_id)
    person = db.session.get(Person, profile.person_id)
    job = application.job_opening
    company = db.session.get(Company, job.company_id)
    return {"person": person, "values": {
        "customer_name": person.full_name, "branch_name": person.registered_branch.branch_name,
        "application_no": application.application_code,
        "application_for": f"{company.company_name} - {job.job_title}"}}


@_safe
def placement_application_recorded(application) -> None:
    """After a placement-support application is recorded (it needs the learner's referral consent)."""
    info = _application_values(application)
    person = info["person"]
    whatsapp.queue(
        templates.PLACEMENT_APPLICATION_RECORDED, person=person, branch_id=person.registered_branch_id,
        source_type="job_application", source_id=application.application_id,
        event_key=f"placement-recorded:{application.application_id}", values=info["values"])


@_safe
def placement_application_update(application, status: str) -> None:
    """After the application's stage changes, or an interview is scheduled; status is the recorded status."""
    info = _application_values(application)
    person = info["person"]
    changed = int(application.stage_changed_at.timestamp()) if application.stage_changed_at else 0
    whatsapp.queue(
        templates.PLACEMENT_APPLICATION_UPDATE, person=person, branch_id=person.registered_branch_id,
        source_type="job_application", source_id=application.application_id,
        event_key=f"placement-update:{application.application_id}:{status}:{changed}",
        values={**info["values"], "application_status": status})


@_safe
def enquiry_received(lead) -> None:
    """After staff enter a new enquiry (a bulk import or an outreach prospect sends nothing). One per person per day."""
    if lead.intake_status not in ("New", "New Enquiry"):
        return
    person = lead.person
    enquiry = db.session.get(Enquiry, lead.original_enquiry_id)
    if enquiry is None:
        return
    if enquiry.enquiry_code is None:
        db.session.refresh(enquiry)  # the code comes from a trigger
    recent = db.session.execute(text(
        "SELECT 1 FROM whatsapp_outbox WHERE person_id = :p AND template_name = :t "
        "AND created_at > now() - interval '24 hours' LIMIT 1"),
        {"p": person.person_id, "t": templates.ENQUIRY_RECEIVED.name}).first()
    if recent:
        return
    whatsapp.queue(
        templates.ENQUIRY_RECEIVED, person=person, branch_id=lead.branch_id, source_type="enquiry",
        source_id=enquiry.enquiry_id, event_key=f"enquiry-received:{enquiry.enquiry_id}",
        values={"customer_name": person.full_name, "branch_name": lead.branch.branch_name,
                "enquiry_subject": lead.course.course_title if lead.course else "our courses",
                "enquiry_ref": enquiry.enquiry_code})


@_safe
def instalment_due_reminder(due, invoice, stage: str):
    """Automatic reminder for an unpaid instalment; stage is "before" / "today" (friendly) or "overdue" (firm).
    One message per instalment per stage; the caller keeps it to one per invoice per day."""
    person = due.person
    branch = invoice.collecting_branch
    template = templates.INSTALMENT_OVERDUE_U if stage == "overdue" else templates.INSTALMENT_DUE_U
    return whatsapp.queue(
        template, person=person, branch_id=due.collecting_branch_id, source_type="invoice_due",
        source_id=due.invoice_id, event_key=f"due-{due.installment_id}-{stage}",
        values={"customer_name": person.full_name, "branch_name": invoice.issuer_branch_name or branch.branch_name,
                "invoice_no": invoice.invoice_number, "installment_no": due.installment_no,
                "amount_due": money(due.balance), "due_date": day(due.due_date), "invoice_channel": whatsapp_channel()})


# ---------------------------------------------------------------- demos and admissions (automatic round, W1)
# | Demo booked / rescheduled / cancelled             | nipuna_demo_booked_u_v1 / _rescheduled_u_v1 / _cancelled_u_v1 |
# | Demo reminder 24h and 1h (learner)                | nipuna_demo_reminder_u_v1                 |
# | Demo reminder 24h and 1h (the trainer, staff)     | nipuna_staff_demo_reminder_v1             |
# | Admission created (automatic, manual, complimentary) | nipuna_admission_confirmed_u_v1        |

def _demo_values(demo) -> dict:
    when = demo.scheduled_at.astimezone(business_now().tzinfo)
    branch = demo.branch
    if demo.mode == "Online":
        venue = f"Online. Joining link: {demo.meeting_link}" if demo.meeting_link \
            else "Online. Our team will share the joining link"
    else:
        venue = f"In person at {branch.branch_name}" + (f", {' '.join(branch.address.split())}" if branch.address else "")
    return {"customer_name": demo.lead.person.full_name, "branch_name": branch.branch_name,
            "course_name": demo.course.course_title if demo.course else "a Nipuna course",
            "demo_time": when.strftime("%a, %d %b %Y at %I:%M %p").replace(" 0", " "), "demo_venue": venue,
            "trainer_name": demo.trainer.full_name if demo.trainer else "To be confirmed"}


def _demo_message(template, demo, event_key: str, values: dict | None = None):
    return whatsapp.queue(template, person=demo.lead.person, branch_id=demo.branch_id, source_type="demo",
                          source_id=demo.demo_id, event_key=event_key, values=values or _demo_values(demo))


@_safe
def demo_booked(demo) -> None:
    """After a demo is booked: course, time, venue (branch address, or the online link) and trainer."""
    _demo_message(templates.DEMO_BOOKED, demo, f"demo-booked:{demo.demo_id}")


@_safe
def demo_rescheduled(new_demo) -> None:
    """After a demo is moved: the updated details, sent for the new demo (the old one is superseded)."""
    _demo_message(templates.DEMO_RESCHEDULED, new_demo, f"demo-rescheduled:{new_demo.demo_id}")


@_safe
def demo_cancelled(demo) -> None:
    values = _demo_values(demo)
    _demo_message(templates.DEMO_CANCELLED, demo, f"demo-cancelled:{demo.demo_id}", values)


@_safe
def demo_reminder(demo, reminder_id: int, starts_in: str):
    """The learner's 24h / 1h reminder (one per reminder row). Returns the outbox row, None when already queued."""
    return _demo_message(templates.DEMO_REMINDER, demo, f"demo-reminder:{reminder_id}",
                         {**_demo_values(demo), "starts_in": starts_in})


@_safe
def demo_trainer_reminder(demo, reminder_id: int, starts_in: str):
    """The trainer's alert on users.phone, through staff_alerts (setting, no phone -> Skipped, kept out of the
    learner's conversation)."""
    from services import staff_alerts

    if demo.trainer is None:
        return None
    values = _demo_values(demo)
    return staff_alerts.send(
        demo.trainer.user_id, templates.STAFF_DEMO_REMINDER,
        {"learner_name": values["customer_name"], "course_name": values["course_name"], "starts_in": starts_in,
         "demo_time": values["demo_time"], "demo_venue": values["demo_venue"]},
        f"demo-reminder-trainer:{reminder_id}", person=demo.lead.person, branch_id=demo.branch_id,
        source_type="demo", source_id=demo.demo_id, skip_actor=False)


@_safe
def admission_confirmed(admission: Admission) -> None:
    """After an admission is created (verification, manual, complimentary): once per admission."""
    person = admission.person
    whatsapp.queue(
        templates.ADMISSION_CONFIRMED, person=person, branch_id=admission.service_branch_id, source_type="admission",
        source_id=admission.admission_id, event_key=f"admission-confirmed:{admission.admission_id}",
        values={"customer_name": person.full_name, "branch_name": admission.service_branch.branch_name,
                "admission_no": admission.admission_code, "course_name": admission.course.course_title,
                "learning_mode": admission.delivery_mode,
                "start_date": day(admission.planned_start_date) if admission.planned_start_date
                else "To be confirmed by our team"})
