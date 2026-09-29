"""Instalment alerts (db 018): due within a few days (daily job) and a long gap between a verified payment and the
next instalment (on verification). Notifications deduplicate on their event key, so re-running changes nothing."""
from datetime import timedelta

from sqlalchemy import select

from config.database import db
from models import Admission, InstallmentDue, Invoice, PaymentGap
from repositories import settings as settings_repo
from repositories import users as users_repo
from services import notifications
from services.reports import business_now

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
