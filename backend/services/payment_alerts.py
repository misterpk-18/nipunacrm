"""Instalment alerts (db 018): due within a few days (daily job) and a long gap between a verified payment and the
next instalment (on verification). Notifications deduplicate on their event key, so re-running changes nothing."""
import logging
from datetime import timedelta

from sqlalchemy import select

from config.database import db
from models import Admission, InstallmentDue, Invoice, Lead, Payment, PaymentGap, User
from repositories import settings as settings_repo
from repositories import users as users_repo
from services import notifications, staff_alerts
from services import whatsapp_templates as templates
from services.context import actor_id
from services.reports import business_now

logger = logging.getLogger(__name__)

DUE_SOON_ROLES = ("ACCOUNTS", "BRANCH_MANAGER")
GAP_ROLES = ("ACCOUNTS", "BRANCH_MANAGER", "FOUNDER_CEO", "SUPER_ADMIN")


def invoice_owners(invoice: Invoice) -> set[int]:
    """Who follows up the money: each admitted course's finance owner or counsellor, else the deal's owner."""
    owners = set()
    for line in invoice.lines:
        admission = db.session.execute(select(Admission).where(Admission.invoice_line_id == line.invoice_line_id)
                                       ).scalar_one_or_none()
        owner = (admission.finance_owner_id or admission.counsellor_id) if admission else line.lead.assigned_to
        if owner is not None:
            owners.add(owner)
    return owners


def _recipients(invoice: Invoice, roles: tuple[str, ...]) -> list[int]:
    ids = users_repo.user_ids_with_any_role(roles, invoice.collecting_branch_id)
    return sorted(ids | invoice_owners(invoice))


def _courses(invoice: Invoice) -> str:
    return ", ".join(line.course.course_title for line in invoice.lines)


def due_soon() -> int:
    """Unpaid instalments due today up to `installment_due_soon_days` ahead: owner, Accounts and the Branch Manager.
    Payments awaiting verification (contact hold) and cancelled enrolments are skipped."""
    today = business_now().date()
    days = settings_repo.get_int("installment_due_soon_days", 2)
    rows = db.session.execute(
        select(InstallmentDue).where(InstallmentDue.balance > 0, InstallmentDue.due_position != "Cancelled",
                                     InstallmentDue.contact_hold.is_(False),
                                     InstallmentDue.due_date.between(today, today + timedelta(days=days)))
    ).scalars().all()
    for due in rows:
        invoice = db.session.get(Invoice, due.invoice_id)
        when = "today" if due.due_date == today else f"on {due.due_date:%d %b}"
        notifications.notify(
            "INSTALMENT_DUE_SOON", event_key=f"due-soon:{due.due_date.isoformat()}", entity_type="installment",
            entity_id=due.installment_id, branch_id=due.collecting_branch_id,
            title=f"Instalment {due.installment_no} due {when}: {due.person.full_name} · ₹{due.balance}",
            body=f"{invoice.invoice_number} · {_courses(invoice)}",
            recipient_user_ids=_recipients(invoice, DUE_SOON_ROLES),
        )
    return len(rows)


def check_gap(invoice_id: int | None, payment_id: int) -> PaymentGap | None:
    """After a payment is verified: if the invoice's next unpaid instalment is due more than
    `payment_gap_alert_days` after the last payment, alert the owner, Accounts, the Branch Manager and admins."""
    if invoice_id is None:
        return None
    gap = db.session.get(PaymentGap, invoice_id)
    if gap is None:
        return None
    invoice = db.session.get(Invoice, invoice_id)
    notifications.notify(
        "PAYMENT_GAP_LONG", event_key=f"gap:{payment_id}", entity_type="invoice", entity_id=invoice_id,
        branch_id=invoice.collecting_branch_id,
        title=(f"{gap.gap_days}-day gap: {gap.person.full_name}'s next instalment is due "
               f"{gap.next_due_date:%d %b %Y} (last payment {gap.last_payment_date:%d %b})"),
        body=f"{invoice.invoice_number} · instalment {gap.next_installment_no} · ₹{gap.outstanding} outstanding",
        recipient_user_ids=_recipients(invoice, GAP_ROLES),
    )
    return gap


# ---------------------------------------------------------------- the counsellor hears the outcome (db 038)

def claim_owners(payment: Payment) -> dict[int, list[Lead]]:
    """Who owns the deal behind a payment claim: {lead owner's user_id: [leads]} for every course it is allocated to
    (or the lead of an advance); with no owner at all, whoever recorded the claim."""
    leads = {a.line.lead.lead_id: a.line.lead for a in payment.allocations}
    if not leads and payment.lead_id:
        leads = {payment.lead_id: db.session.get(Lead, payment.lead_id)}
    owners: dict[int, list[Lead]] = {}
    for lead in leads.values():
        if lead is not None and lead.assigned_to is not None:
            owners.setdefault(lead.assigned_to, []).append(lead)
    if not owners and payment.collected_by is not None:
        owners[payment.collected_by] = []
    return owners


def _outcome_text(payment: Payment, outcome: str) -> tuple[str, str]:
    """(short outcome, the detail that goes with it: the receipt, or the failure reason)."""
    if outcome == "verified":
        return "verified", f"Receipt {payment.receipt_number}."
    reason = " ".join((payment.failure_reason or "").split())  # one line: a WhatsApp value can't hold line breaks
    return "failed verification", f"Reason: {reason}."


def payment_outcome(payment: Payment, outcome: str) -> None:
    """After Accounts verifies or fails a claim: a bell notification to the owner counsellor (the failure reason
    included) and, when app setting whatsapp_staff_alerts_enabled is on, a WhatsApp message to their phone. The
    person who decided is not told about their own decision. Never breaks the verification."""
    try:
        with db.session.begin_nested():
            _notify_owners(payment, outcome)
    except Exception:
        logger.exception("Could not tell the owner about %s", payment.transaction_number)


def _notify_owners(payment: Payment, outcome: str) -> None:
    short, detail = _outcome_text(payment, outcome)
    learner = payment.person.full_name
    for user_id, leads in claim_owners(payment).items():
        if user_id == actor_id():
            continue
        courses = ", ".join(sorted({lead.course.course_title for lead in leads if lead.course})) or "advance payment"
        title = (f"Payment {payment.transaction_number} verified · {learner} · ₹{payment.amount}" if outcome == "verified"
                 else f"Payment {payment.transaction_number} FAILED · {learner} · ₹{payment.amount}")
        body = (f"{courses}. {detail}" + (" Receipt issued; the money now counts." if outcome == "verified"
                                          else " The money does not count; follow up with the learner."))
        rule = "PAYMENT_VERIFIED" if outcome == "verified" else "PAYMENT_FAILED"
        for lead in leads or [None]:
            notifications.notify(
                rule, event_key=f"payment.{outcome}:{payment.transaction_number}",
                entity_type="lead" if lead else "payment", entity_id=lead.lead_id if lead else payment.payment_id,
                branch_id=payment.collecting_branch_id, title=title, body=body, recipient_user_ids=[user_id])
        _whatsapp_staff(payment, user_id, short, detail)  # staff_alerts checks the setting


def _whatsapp_staff(payment: Payment, user_id: int, short: str, detail: str) -> None:
    staff_alerts.send(
        user_id, templates.STAFF_PAYMENT_STATUS,
        {"transaction_no": payment.transaction_number, "learner_name": payment.person.full_name,
         "payment_amount": f"{payment.amount:.2f}", "outcome": short, "outcome_detail": detail},
        f"staff-payment-{short.split()[0]}:{payment.payment_id}:{user_id}",
        person=payment.person, branch_id=payment.collecting_branch_id, source_type="payment", source_id=payment.payment_id)


def payment_to_verify(payment: Payment) -> None:
    """A claim was recorded: the branch's Accounts users get a WhatsApp 'payment to verify' (never the person who
    recorded it). The bell notification and the task are raised by the caller."""
    try:
        with db.session.begin_nested():
            mode = payment.mode.label if payment.mode else "payment"
            for user_id in sorted(users_repo.user_ids_with_any_role(("ACCOUNTS",), payment.collecting_branch_id)):
                staff_alerts.send(
                    user_id, templates.STAFF_PAYMENT_TO_VERIFY,
                    {"transaction_no": payment.transaction_number, "learner_name": payment.person.full_name,
                     "payment_amount": f"{payment.amount:.2f}", "payment_mode": mode,
                     "reference": payment.reference or "not given"},
                    f"staff-payment-verify:{payment.payment_id}:{user_id}", person=payment.person,
                    branch_id=payment.collecting_branch_id, source_type="payment", source_id=payment.payment_id)
    except Exception:
        logger.exception("Could not alert Accounts about %s", payment.transaction_number)
