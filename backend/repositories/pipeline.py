"""Pipeline board: open person cards (pipeline_entries) per stage (Postgres enum order = pipeline order)."""
from sqlalchemy import Select, select
from sqlalchemy.orm import selectinload

from config.database import db
from models import (
    Admission, DeliveryPlan, Demo, FeeDiscussion, Invoice, Person, PipelineEntry,
)
from models.enums import CLOSED_STAGES
from repositories.common import text

# Cards carry their person, branch, owner and lost reason: load them together so the board stays a few queries.
_CARD_LOADS = (selectinload(PipelineEntry.person), selectinload(PipelineEntry.branch),
               selectinload(PipelineEntry.owner), selectinload(PipelineEntry.lost_reason))


def _entries_where(filters: dict, branch_ids: set[int] | None, closed: bool) -> tuple[str, dict]:
    """WHERE for open cards (default), or closed ones (Admitted / Lost) for the closed chips.
    Runs over pipeline_entries JOIN persons; fragments are fixed literals, values only go in params."""
    params: dict = {"closed_stages": list(CLOSED_STAGES)}
    where = ["pipeline_entries.stage::text = ANY(:closed_stages)" if closed
             else "pipeline_entries.stage::text <> ALL(:closed_stages)"]
    # a lead on the card: any lead when closed, else only leads still open
    lead_on_card = ("EXISTS (SELECT 1 FROM leads WHERE leads.pipeline_entry_id = pipeline_entries.pipeline_entry_id"
                    + ("" if closed else " AND leads.stage::text <> ALL(:closed_stages)") + " AND {})")

    if branch_ids is not None:
        where.append("pipeline_entries.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in (("branch_id", "pipeline_entries.branch_id = :branch_id"),
                            ("stage", "pipeline_entries.stage = :stage"),
                            ("priority", "pipeline_entries.ai_priority = :priority")):
        if filters.get(field) is not None:
            where.append(fragment)
            params[field] = filters[field]
    if "assigned_to" in filters:
        if filters["assigned_to"] is None:
            where.append("pipeline_entries.assigned_to IS NULL")
        else:
            where.append("pipeline_entries.assigned_to = :assigned_to")
            params["assigned_to"] = filters["assigned_to"]
    if filters.get("course_id") is not None:
        where.append(lead_on_card.format("leads.course_id = :course_id"))
        params["course_id"] = filters["course_id"]
    if filters.get("source_id") is not None:
        where.append(lead_on_card.format("leads.original_source_id = :source_id"))
        params["source_id"] = filters["source_id"]
    if filters.get("q"):
        params["pattern"] = f"%{filters['q']}%"
        digits = "".join(ch for ch in filters["q"] if ch.isdigit())
        conditions = ["persons.full_name ILIKE :pattern", "persons.email ILIKE :pattern",
                      "pipeline_entries.entry_code ILIKE :pattern",
                      lead_on_card.format("leads.lead_code ILIKE :pattern"),
                      lead_on_card.format("leads.course_id IN (SELECT course_id FROM courses "
                                          "WHERE course_title ILIKE :pattern)")]
        if len(digits) >= 4:
            conditions.append("persons.phone LIKE :phone_pattern")
            params["phone_pattern"] = f"%{digits}%"
        where.append("(" + " OR ".join(conditions) + ")")
    return " AND ".join(where), params


def _entries_sql(filters: dict, branch_ids: set[int] | None, closed: bool, tail: str) -> tuple[str, dict]:
    where, params = _entries_where(filters, branch_ids, closed)
    return (f"""
        SELECT pipeline_entries.*
        FROM pipeline_entries
        JOIN persons ON persons.person_id = pipeline_entries.person_id
        WHERE {where}
        {tail}
    """, params)


def _stage_count_rows(filters: dict, branch_ids: set[int] | None, closed: bool) -> dict[str, int]:
    where, params = _entries_where(filters, branch_ids, closed)
    rows = db.session.execute(text(f"""
        SELECT pipeline_entries.stage::text AS stage, COUNT(*) AS count
        FROM pipeline_entries
        JOIN persons ON persons.person_id = pipeline_entries.person_id
        WHERE {where}
        GROUP BY pipeline_entries.stage
    """), params).all()
    return {stage: count for stage, count in rows}


def stage_counts(filters: dict, branch_ids: set[int] | None) -> dict[str, int]:
    return _stage_count_rows(filters, branch_ids, closed=False)


def closed_counts(filters: dict, branch_ids: set[int] | None) -> dict[str, int]:
    """Admitted / Closed lost chips: all-time per branch (V4 default)."""
    return _stage_count_rows(filters, branch_ids, closed=True)


def stage_cards(filters: dict, branch_ids: set[int] | None, stages: tuple[str, ...], limit: int,
                closed: bool = False) -> list[PipelineEntry]:
    order = ("ORDER BY pipeline_entries.closed_at DESC" if closed else
             "ORDER BY pipeline_entries.next_follow_up_at ASC NULLS LAST, pipeline_entries.created_at DESC")
    where, params = _entries_where(filters, branch_ids, closed)
    params.update(stages=list(stages), limit=limit)
    sql = f"""
        SELECT pipeline_entries.*
        FROM pipeline_entries
        JOIN persons ON persons.person_id = pipeline_entries.person_id
        WHERE {where} AND pipeline_entries.stage::text = ANY(:stages)
        {order}
        LIMIT :limit
    """
    return list(db.session.execute(select(PipelineEntry).from_statement(text(sql)).options(*_CARD_LOADS),
                                   params).unique().scalars())


def open_entries(filters: dict, branch_ids: set[int] | None) -> list[PipelineEntry]:
    sql, params = _entries_sql(filters, branch_ids, False, "ORDER BY pipeline_entries.pipeline_entry_id")
    return list(db.session.execute(select(PipelineEntry).from_statement(text(sql)).options(*_CARD_LOADS),
                                   params).unique().scalars())


def table_stmt(filters: dict, branch_ids: set[int] | None, closed: bool = False) -> Select:
    """Kept as a Select (the table is paginated with db.paginate, which needs limit/offset): the filter is raw SQL."""
    where, params = _entries_where(filters, branch_ids, closed)
    return (select(PipelineEntry).join(Person, Person.person_id == PipelineEntry.person_id)
            .where(text(where).bindparams(**params))
            .order_by(text("pipeline_entries.stage, pipeline_entries.next_follow_up_at ASC NULLS LAST, "
                           "pipeline_entries.pipeline_entry_id DESC")))


# ---------------------------------------------------------------- card details (batched by lead)

def _live_fee_discussions(lead_ids: list[int]):
    """Fee discussions still alive (not Expired / Cancelled) on these leads, oldest first."""
    return db.session.execute(select(FeeDiscussion).from_statement(text("""
        SELECT * FROM fee_discussions
        WHERE lead_id = ANY(:lead_ids) AND milestone::text <> ALL(:dead)
        ORDER BY fee_discussion_id
    """)), {"lead_ids": lead_ids, "dead": ["Expired", "Cancelled"]}).unique().scalars()


def lead_prices(lead_ids: list[int]) -> dict[int, dict]:
    """The deal's price: admitted fee once admitted, else the current fee discussion's version when Approved."""
    if not lead_ids:
        return {}
    prices = {}
    admissions = db.session.execute(select(Admission).from_statement(text("""
        SELECT * FROM admissions
        WHERE lead_id = ANY(:lead_ids) AND complimentary_of_admission_id IS NULL
    """)), {"lead_ids": lead_ids}).scalars()
    for admission in admissions:
        prices[admission.lead_id] = {"amount": admission.final_fee, "basis": "Admitted fee"}
    for discussion in _live_fee_discussions(lead_ids):
        version = discussion.current_version
        if discussion.lead_id not in prices and version is not None and version.status == "Approved":
            prices[discussion.lead_id] = {"amount": version.final_payable, "basis": "Approved fee"}
    return prices


def lead_plans(lead_ids: list[int]) -> dict[int, DeliveryPlan]:
    if not lead_ids:
        return {}
    rows = db.session.execute(select(DeliveryPlan).from_statement(
        text("SELECT * FROM delivery_plans WHERE lead_id = ANY(:lead_ids)")), {"lead_ids": lead_ids}).scalars()
    return {plan.lead_id: plan for plan in rows}


def lead_invoices(lead_ids: list[int]) -> dict[int, Invoice]:
    """Each course's live (Issued) invoice."""
    if not lead_ids:
        return {}
    pairs = db.session.execute(text("""
        SELECT invoice_lines.lead_id, invoices.invoice_id
        FROM invoice_lines
        JOIN invoices ON invoices.invoice_id = invoice_lines.invoice_id
        WHERE invoice_lines.lead_id = ANY(:lead_ids) AND invoices.status = :status
    """), {"lead_ids": lead_ids, "status": "Issued"}).all()
    if not pairs:
        return {}
    invoices = {invoice.invoice_id: invoice for invoice in db.session.execute(select(Invoice).from_statement(
        text("SELECT * FROM invoices WHERE invoice_id = ANY(:invoice_ids)")),
        {"invoice_ids": list({invoice_id for _, invoice_id in pairs})}).scalars()}
    return {lead_id: invoices[invoice_id] for lead_id, invoice_id in pairs}


def leads_with_pending_payments(lead_ids: list[int]) -> set[int]:
    if not lead_ids:
        return set()
    rows = db.session.execute(text("""
        SELECT invoice_lines.lead_id
        FROM invoice_lines
        JOIN payment_allocations ON payment_allocations.invoice_line_id = invoice_lines.invoice_line_id
        JOIN payments ON payments.payment_id = payment_allocations.payment_id
        WHERE invoice_lines.lead_id = ANY(:lead_ids) AND payments.verification_status = :status
    """), {"lead_ids": lead_ids, "status": "Pending Verification"}).scalars()
    return set(rows)


def leads_with_open_demos(lead_ids: list[int]) -> set[int]:
    """A demo booked (Scheduled / Confirmed) with no outcome recorded yet."""
    if not lead_ids:
        return set()
    rows = db.session.execute(text("""
        SELECT lead_id FROM demos WHERE lead_id = ANY(:lead_ids) AND status::text = ANY(:statuses)
    """), {"lead_ids": lead_ids, "statuses": ["Scheduled", "Confirmed"]}).scalars()
    return set(rows)


def invoice_outstanding(invoice_ids: set[int]) -> dict[int, object]:
    if not invoice_ids:
        return {}
    rows = db.session.execute(text("""
        SELECT invoice_id, outstanding FROM invoice_balances WHERE invoice_id = ANY(:invoice_ids)
    """), {"invoice_ids": list(invoice_ids)}).all()
    return dict(rows)


def lead_open_demos(lead_ids: list[int]) -> dict[int, Demo]:
    """Each course's next open demo (Scheduled / Confirmed), the earliest first."""
    if not lead_ids:
        return {}
    rows = db.session.execute(select(Demo).from_statement(text("""
        SELECT * FROM demos WHERE lead_id = ANY(:lead_ids) AND status::text = ANY(:statuses)
        ORDER BY scheduled_at DESC
    """)), {"lead_ids": lead_ids, "statuses": list(Demo.OPEN_STATUSES)}).unique().scalars()
    return {demo.lead_id: demo for demo in rows}  # descending, so the earliest wins


def lead_fee_state(lead_ids: list[int]) -> dict[int, dict]:
    """Each course's live fee discussion: its current version's status and whether it needs special closing."""
    if not lead_ids:
        return {}
    state = {}
    for discussion in _live_fee_discussions(lead_ids):
        version = discussion.current_version
        state[discussion.lead_id] = {"milestone": discussion.milestone,
                                     "status": version.status if version else None,
                                     "needs_special_closing": bool(version and version.needs_special_closing)}
    return state
