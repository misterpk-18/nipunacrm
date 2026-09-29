"""Pipeline board: open person cards (pipeline_entries) per stage (Postgres enum order = pipeline order)."""
from sqlalchemy import Select, exists, func, or_, select

from config.database import db
from models import (
    Admission, Course, DeliveryPlan, Demo, FeeDiscussion, Invoice, InvoiceBalance, InvoiceLine, Lead, Payment,
    PaymentAllocation, Person, PipelineEntry,
)
from models.enums import CLOSED_STAGES


def _open_lead_on_card(*conditions):
    return exists().where(Lead.pipeline_entry_id == PipelineEntry.pipeline_entry_id,
                          Lead.stage.not_in(CLOSED_STAGES), *conditions)


def _any_lead_on_card(*conditions):
    return exists().where(Lead.pipeline_entry_id == PipelineEntry.pipeline_entry_id, *conditions)


def entries_stmt(filters: dict, branch_ids: set[int] | None, closed: bool = False) -> Select:
    """Open cards (default), or closed ones (Admitted / Lost) for the closed chips."""
    stmt = (select(PipelineEntry).join(Person, Person.person_id == PipelineEntry.person_id)
            .where(PipelineEntry.stage.in_(CLOSED_STAGES) if closed else PipelineEntry.stage.not_in(CLOSED_STAGES)))

    if branch_ids is not None:
        stmt = stmt.where(PipelineEntry.branch_id.in_(branch_ids))
    for field, column in (("branch_id", PipelineEntry.branch_id), ("stage", PipelineEntry.stage),
                          ("priority", PipelineEntry.ai_priority)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if "assigned_to" in filters:
        assigned = filters["assigned_to"]
        stmt = stmt.where(PipelineEntry.assigned_to.is_(None) if assigned is None
                          else PipelineEntry.assigned_to == assigned)
    on_card = _any_lead_on_card if closed else _open_lead_on_card
    if filters.get("course_id") is not None:
        stmt = stmt.where(on_card(Lead.course_id == filters["course_id"]))
    if filters.get("source_id") is not None:
        stmt = stmt.where(on_card(Lead.original_source_id == filters["source_id"]))
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        digits = "".join(ch for ch in filters["q"] if ch.isdigit())
        conditions = [Person.full_name.ilike(pattern), Person.email.ilike(pattern),
                      PipelineEntry.entry_code.ilike(pattern), on_card(Lead.lead_code.ilike(pattern)),
                      on_card(Lead.course.has(Course.course_title.ilike(pattern)))]
        if len(digits) >= 4:
            conditions.append(Person.phone.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conditions))
    return stmt


def stage_counts(filters: dict, branch_ids: set[int] | None) -> dict[str, int]:
    base = entries_stmt(filters, branch_ids).subquery()
    rows = db.session.execute(select(base.c.stage, func.count()).group_by(base.c.stage)).all()
    return {stage: count for stage, count in rows}


def closed_counts(filters: dict, branch_ids: set[int] | None) -> dict[str, int]:
    """Admitted / Closed lost chips: all-time per branch (V4 default)."""
    base = entries_stmt(filters, branch_ids, closed=True).subquery()
    rows = db.session.execute(select(base.c.stage, func.count()).group_by(base.c.stage)).all()
    return {stage: count for stage, count in rows}


def stage_cards(filters: dict, branch_ids: set[int] | None, stages: tuple[str, ...], limit: int,
                closed: bool = False) -> list[PipelineEntry]:
    order = ((PipelineEntry.closed_at.desc(),) if closed else
             (PipelineEntry.next_follow_up_at.asc().nulls_last(), PipelineEntry.created_at.desc()))
    stmt = (entries_stmt(filters, branch_ids, closed).where(PipelineEntry.stage.in_(stages))
            .order_by(*order).limit(limit))
    return list(db.session.execute(stmt).unique().scalars())


def open_entries(filters: dict, branch_ids: set[int] | None) -> list[PipelineEntry]:
    stmt = entries_stmt(filters, branch_ids).order_by(PipelineEntry.pipeline_entry_id)
    return list(db.session.execute(stmt).unique().scalars())


def table_stmt(filters: dict, branch_ids: set[int] | None, closed: bool = False) -> Select:
    return entries_stmt(filters, branch_ids, closed).order_by(
        PipelineEntry.stage, PipelineEntry.next_follow_up_at.asc().nulls_last(),
        PipelineEntry.pipeline_entry_id.desc())


# ---------------------------------------------------------------- card details (batched by lead)

def lead_prices(lead_ids: list[int]) -> dict[int, dict]:
    """The deal's price: admitted fee once admitted, else the current fee discussion's version when Approved."""
    if not lead_ids:
        return {}
    prices = {}
    for admission in db.session.execute(select(Admission).where(Admission.lead_id.in_(lead_ids),
                                                                Admission.complimentary_of_admission_id.is_(None))).scalars():
        prices[admission.lead_id] = {"amount": admission.final_fee, "basis": "Admitted fee"}
    discussions = db.session.execute(
        select(FeeDiscussion).where(FeeDiscussion.lead_id.in_(lead_ids),
                                    FeeDiscussion.milestone.not_in(("Expired", "Cancelled")))
        .order_by(FeeDiscussion.fee_discussion_id)).scalars()
    for discussion in discussions:
        version = discussion.current_version
        if discussion.lead_id not in prices and version is not None and version.status == "Approved":
            prices[discussion.lead_id] = {"amount": version.final_payable, "basis": "Approved fee"}
    return prices


def lead_plans(lead_ids: list[int]) -> dict[int, DeliveryPlan]:
    if not lead_ids:
        return {}
    rows = db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id.in_(lead_ids))).scalars()
    return {plan.lead_id: plan for plan in rows}


def lead_invoices(lead_ids: list[int]) -> dict[int, Invoice]:
    """Each course's live (Issued) invoice."""
    if not lead_ids:
        return {}
    rows = db.session.execute(
        select(InvoiceLine.lead_id, Invoice).join(Invoice, Invoice.invoice_id == InvoiceLine.invoice_id)
        .where(InvoiceLine.lead_id.in_(lead_ids), Invoice.status == "Issued")).all()
    return {lead_id: invoice for lead_id, invoice in rows}


def leads_with_pending_payments(lead_ids: list[int]) -> set[int]:
    if not lead_ids:
        return set()
    rows = db.session.execute(
        select(InvoiceLine.lead_id).join(PaymentAllocation, PaymentAllocation.invoice_line_id == InvoiceLine.invoice_line_id)
        .join(Payment, Payment.payment_id == PaymentAllocation.payment_id)
        .where(InvoiceLine.lead_id.in_(lead_ids), Payment.verification_status == "Pending Verification")).scalars()
    return set(rows)


def leads_with_open_demos(lead_ids: list[int]) -> set[int]:
    """A demo booked (Scheduled / Confirmed) with no outcome recorded yet."""
    if not lead_ids:
        return set()
    rows = db.session.execute(select(Demo.lead_id).where(Demo.lead_id.in_(lead_ids),
                                                         Demo.status.in_(("Scheduled", "Confirmed")))).scalars()
    return set(rows)


def invoice_outstanding(invoice_ids: set[int]) -> dict[int, object]:
    if not invoice_ids:
        return {}
    rows = db.session.execute(select(InvoiceBalance.invoice_id, InvoiceBalance.outstanding)
                              .where(InvoiceBalance.invoice_id.in_(invoice_ids))).all()
    return dict(rows)
