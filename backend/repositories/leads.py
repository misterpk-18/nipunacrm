"""Queries for persons, enquiries, leads and lead activities (raw SQL; values only as bound parameters)."""
from sqlalchemy import Select, select
from sqlalchemy.orm import selectinload

from config.database import db
from models import Enquiry, Lead, LeadActivity, Person
from models.enums import CLOSED_STAGES
from repositories.common import text

# Lead's lazy="joined" relationships are not applied to a raw-SQL from_statement, so load them explicitly
_LEAD_EAGER = (selectinload(Lead.person), selectinload(Lead.course), selectinload(Lead.branch), selectinload(Lead.source),
               selectinload(Lead.channel), selectinload(Lead.entry_method), selectinload(Lead.owner),
               selectinload(Lead.lost_reason))

# ---------------------------------------------------------------- queue tabs (prototype Counsellor workspace)

_LOCAL_NOW_DATE = "DATE(timezone(business_tz(), now()))"
_OPEN = "leads.stage::text <> ALL(:closed_stages)"

# name -> (SQL condition on leads, its bound parameters); fragments are fixed literals, values are parameters
QUEUES = {
    "new": ("leads.stage = :stage_new", {"stage_new": "New Enquiry"}),
    "untouched": (f"({_OPEN} AND leads.last_contacted_at IS NULL)", {"closed_stages": list(CLOSED_STAGES)}),
    "due_today": (f"({_OPEN} AND DATE(timezone(business_tz(), leads.next_follow_up_at)) = {_LOCAL_NOW_DATE})",
                  {"closed_stages": list(CLOSED_STAGES)}),
    "overdue": (f"({_OPEN} AND leads.next_follow_up_at < now())", {"closed_stages": list(CLOSED_STAGES)}),
    "hot": (f"({_OPEN} AND leads.ai_priority = :priority_hot)",
            {"closed_stages": list(CLOSED_STAGES), "priority_hot": "Hot"}),
    "demos": ("leads.stage::text = ANY(:demo_stages)", {"demo_stages": ["Demo Scheduled", "Demo Attended"]}),
    "fee_discussion": ("leads.stage = :stage_fee", {"stage_fee": "Fee Discussion / Payment Awaited"}),
    "payment_pending": ("leads.stage = :stage_payment", {"stage_payment": "Payment Pending Verification"}),
    "cold": (f"(({_OPEN} AND leads.ai_priority = :priority_cold) "
             f"OR (leads.stage = :stage_lost AND leads.reactivation_date <= {_LOCAL_NOW_DATE}))",
             {"closed_stages": list(CLOSED_STAGES), "priority_cold": "Cold", "stage_lost": "Lost - closed"}),
    "future_joining": (f"({_OPEN} AND leads.ai_priority = :priority_waiting)",
                       {"closed_stages": list(CLOSED_STAGES), "priority_waiting": "Waiting for Batch / Future Joining"}),
}


def _where(fragments: list[str], params: dict):
    """AND the fragments into one text() clause with its parameters bound (None when there are no fragments)."""
    return text(" AND ".join(fragments)).bindparams(**params) if fragments else None


# ---------------------------------------------------------------- persons

def search_persons(phone: str | None, email: str | None, name: str | None, limit: int = 20) -> list[Person]:
    conditions, params = [], {"limit": limit}
    if phone:
        conditions += ["persons.phone = :phone", "persons.alternate_phone = :phone"]
        params["phone"] = phone
    if email:
        conditions.append("lower(persons.email) = :email")
        params["email"] = email
    if name:
        conditions.append("persons.full_name ILIKE :name_pattern")
        params["name_pattern"] = f"%{name}%"
    where = f"WHERE {' OR '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT persons.* FROM persons
        {where}
        ORDER BY persons.full_name
        LIMIT :limit
    """
    stmt = select(Person).from_statement(text(sql)).options(selectinload(Person.registered_branch))
    return list(db.session.execute(stmt, params).scalars())


def person_visible(person_id: int, branch_ids: set[int] | None) -> bool:
    """Registered at, or has a lead at, one of the user's branches."""
    if branch_ids is None:
        return True
    sql = """
        SELECT persons.person_id FROM persons
        WHERE persons.person_id = :person_id
          AND (persons.registered_branch_id = ANY(:branch_ids)
               OR EXISTS (SELECT 1 FROM leads WHERE leads.person_id = persons.person_id
                          AND leads.branch_id = ANY(:branch_ids)))
        LIMIT 1
    """
    return db.session.execute(text(sql), {"person_id": person_id, "branch_ids": list(branch_ids)}).first() is not None


def persons_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Persons list: registered at, or with a lead at, the user's branches (or the chosen branch); newest first.

    Returns a Select (callers paginate it); its filter and ordering are raw SQL with bound parameters."""
    fragments, params = [], {}
    scope = {filters["branch_id"]} if filters.get("branch_id") else branch_ids
    if scope is not None:
        fragments.append("(persons.registered_branch_id = ANY(:scope) OR EXISTS ("
                         "SELECT 1 FROM leads WHERE leads.person_id = persons.person_id AND leads.branch_id = ANY(:scope)))")
        params["scope"] = list(scope)
    if filters.get("q"):
        digits = "".join(ch for ch in filters["q"] if ch.isdigit())
        conditions = ["persons.full_name ILIKE :pattern", "persons.email ILIKE :pattern", "persons.person_code ILIKE :pattern"]
        params["pattern"] = f"%{filters['q']}%"
        if len(digits) >= 4:
            conditions += ["persons.phone LIKE :digits_pattern", "persons.alternate_phone LIKE :digits_pattern"]
            params["digits_pattern"] = f"%{digits}%"
        fragments.append(f"({' OR '.join(conditions)})")
    stmt = select(Person)
    where = _where(fragments, params)
    if where is not None:
        stmt = stmt.where(where)
    return stmt.order_by(text("persons.created_at DESC, persons.person_id DESC"))


def leads_for_persons(person_ids: list[int], branch_ids: set[int] | None) -> list[Lead]:
    """Every lead (open or closed) of these persons at the given branches, oldest first."""
    if not person_ids:
        return []
    fragments, params = ["leads.person_id = ANY(:person_ids)"], {"person_ids": list(person_ids)}
    if branch_ids is not None:
        fragments.append("leads.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    sql = f"""
        SELECT leads.* FROM leads
        WHERE {" AND ".join(fragments)}
        ORDER BY leads.lead_id
    """
    return list(db.session.execute(select(Lead).from_statement(text(sql)).options(*_LEAD_EAGER), params).scalars())


def open_leads_for_persons(person_ids: list[int], branch_id: int | None = None) -> list[Lead]:
    if not person_ids:
        return []
    fragments = ["leads.person_id = ANY(:person_ids)", _OPEN]
    params = {"person_ids": list(person_ids), "closed_stages": list(CLOSED_STAGES)}
    if branch_id is not None:
        fragments.append("leads.branch_id = :branch_id")
        params["branch_id"] = branch_id
    sql = f"""
        SELECT leads.* FROM leads
        WHERE {" AND ".join(fragments)}
        ORDER BY leads.lead_id
    """
    return list(db.session.execute(select(Lead).from_statement(text(sql)).options(*_LEAD_EAGER), params).scalars())


def open_leads_on_card(lead: Lead) -> list[Lead]:
    """The other open courses on the lead's pipeline card."""
    if lead.pipeline_entry_id is None:
        return []
    sql = f"""
        SELECT leads.* FROM leads
        WHERE leads.pipeline_entry_id = :pipeline_entry_id AND {_OPEN} AND leads.lead_id <> :lead_id
    """
    params = {"pipeline_entry_id": lead.pipeline_entry_id, "closed_stages": list(CLOSED_STAGES), "lead_id": lead.lead_id}
    return list(db.session.execute(select(Lead).from_statement(text(sql)).options(*_LEAD_EAGER), params).scalars())


def find_open_lead(person_id: int, course_id: int | None, branch_id: int) -> Lead | None:
    course = "leads.course_id IS NULL" if course_id is None else "leads.course_id = :course_id"
    sql = f"""
        SELECT leads.* FROM leads
        WHERE leads.person_id = :person_id AND leads.branch_id = :branch_id AND {_OPEN} AND {course}
    """
    params = {"person_id": person_id, "branch_id": branch_id, "closed_stages": list(CLOSED_STAGES)}
    if course_id is not None:
        params["course_id"] = course_id
    return db.session.execute(select(Lead).from_statement(text(sql)).options(*_LEAD_EAGER), params).scalars().first()


def persons_matching(phone: str | None, email: str | None) -> list[Person]:
    if not phone and not email:
        return []
    return search_persons(phone, email, None)


# ---------------------------------------------------------------- enquiries

def enquiries_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Returns a Select (callers paginate it); its filter and ordering are raw SQL with bound parameters."""
    fragments, params = [], {}
    if branch_ids is not None:
        fragments.append("enquiries.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        fragments.append("enquiries.branch_id = :branch_id")
        params["branch_id"] = filters["branch_id"]
    if filters.get("intake_status"):
        fragments.append("enquiries.intake_status = :intake_status")
        params["intake_status"] = filters["intake_status"]
    if filters.get("linked") is not None:
        fragments.append("enquiries.lead_id IS NOT NULL" if filters["linked"] else "enquiries.lead_id IS NULL")
    if filters.get("q"):
        fragments.append("(enquiries.enquiry_code ILIKE :pattern OR enquiries.raw_name ILIKE :pattern "
                         "OR enquiries.raw_phone ILIKE :pattern OR enquiries.raw_email ILIKE :pattern)")
        params["pattern"] = f"%{filters['q']}%"
    stmt = select(Enquiry)
    where = _where(fragments, params)
    if where is not None:
        stmt = stmt.where(where)
    return stmt.order_by(text("enquiries.received_at DESC, enquiries.enquiry_id DESC"))


def enquiries_for_lead(lead_id: int) -> list[Enquiry]:
    sql = """
        SELECT enquiries.* FROM enquiries
        WHERE enquiries.lead_id = :lead_id
        ORDER BY enquiries.received_at, enquiries.enquiry_id
    """
    stmt = select(Enquiry).from_statement(text(sql)).options(
        selectinload(Enquiry.branch), selectinload(Enquiry.course), selectinload(Enquiry.source),
        selectinload(Enquiry.channel), selectinload(Enquiry.entry_method), selectinload(Enquiry.owner),
        selectinload(Enquiry.lead))
    return list(db.session.execute(stmt, {"lead_id": lead_id}).scalars())


def unlinked_enquiries_matching(phone: str | None, email: str | None, *, within_hours: int | None = None,
                                exclude_id: int | None = None, branch_ids: set[int] | None = None) -> list[Enquiry]:
    """Unconverted enquiries with this phone or email (any branch unless branch_ids is given), newest first."""
    contact = []
    params: dict = {}
    if phone:
        contact.append("enquiries.raw_phone = :phone")
        params["phone"] = phone
    if email:
        contact.append("lower(enquiries.raw_email) = lower(:email)")
        params["email"] = email
    if not contact:
        return []
    fragments = ["enquiries.lead_id IS NULL", f"({' OR '.join(contact)})"]
    if within_hours is not None:
        fragments.append("enquiries.received_at > now() - make_interval(hours => :hours)")
        params["hours"] = within_hours
    if exclude_id is not None:
        fragments.append("enquiries.enquiry_id <> :exclude_id")
        params["exclude_id"] = exclude_id
    if branch_ids is not None:
        fragments.append("enquiries.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    sql = f"""
        SELECT enquiries.* FROM enquiries
        WHERE {" AND ".join(fragments)}
        ORDER BY enquiries.received_at DESC, enquiries.enquiry_id DESC
        LIMIT 20
    """
    return list(db.session.execute(select(Enquiry).from_statement(text(sql)), params).scalars())


def enquiry_by_external_ref(entry_method_id: int, external_ref: str) -> Enquiry | None:
    return db.session.execute(select(Enquiry).where(
        Enquiry.entry_method_id == entry_method_id, Enquiry.external_ref == external_ref)).scalar_one_or_none()


def count_enquiries_since(entry_method_id: int, seconds: int, phone: str | None = None) -> int:
    """Enquiries of one entry method recorded in the last `seconds` (optionally from one phone): request limits.
    Counts created_at (the CRM's own clock), since received_at can be the sender's earlier submission time."""
    sql = """
        SELECT count(*) FROM enquiries
        WHERE entry_method_id = :method AND created_at > now() - make_interval(secs => :seconds)
          AND (CAST(:phone AS TEXT) IS NULL OR raw_phone = :phone)
    """
    return db.session.execute(text(sql), {"method": entry_method_id, "seconds": seconds, "phone": phone}).scalar()


# ---------------------------------------------------------------- leads

# request filter name -> SQL column (fixed allowlist)
_LEAD_FILTER_COLUMNS = {"branch_id": "leads.branch_id", "stage": "leads.stage", "course_id": "leads.course_id",
                        "source_id": "leads.original_source_id", "intake_status": "leads.intake_status",
                        "priority": "leads.ai_priority", "lead_status": "leads.lead_status"}


def leads_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Returns a Select (callers paginate it); its filter and ordering are raw SQL with bound parameters."""
    fragments, params = [], {}

    if branch_ids is not None:
        fragments.append("leads.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, column in _LEAD_FILTER_COLUMNS.items():
        if filters.get(field) is not None:
            fragments.append(f"{column} = :f_{field}")
            params[f"f_{field}"] = filters[field]
    if "assigned_to" in filters:
        assigned = filters["assigned_to"]
        if assigned is None:
            fragments.append("leads.assigned_to IS NULL")
        else:
            fragments.append("leads.assigned_to = :assigned_to")
            params["assigned_to"] = assigned
    if filters.get("queue"):
        queue_sql, queue_params = QUEUES[filters["queue"]]
        fragments.append(queue_sql)
        params.update(queue_params)
    if filters.get("q"):
        digits = "".join(ch for ch in filters["q"] if ch.isdigit())
        conditions = ["persons.full_name ILIKE :pattern", "persons.email ILIKE :pattern", "leads.lead_code ILIKE :pattern"]
        params["pattern"] = f"%{filters['q']}%"
        if len(digits) >= 4:
            conditions.append("persons.phone LIKE :digits_pattern")
            params["digits_pattern"] = f"%{digits}%"
        fragments.append(f"({' OR '.join(conditions)})")

    stmt = select(Lead).join(Person, Person.person_id == Lead.person_id)
    where = _where(fragments, params)
    if where is not None:
        stmt = stmt.where(where)
    return stmt.order_by(text("leads.created_at DESC, leads.lead_id DESC"))


def workspace_stmt(user_id: int) -> Select:
    """A counsellor's own open leads: overdue first, then due today, then hot, then by follow-up time."""
    closed = list(CLOSED_STAGES)
    urgency = f"""
        CASE WHEN {QUEUES["overdue"][0]} THEN 0
             WHEN {QUEUES["due_today"][0]} THEN 1
             WHEN leads.ai_priority = :priority_hot THEN 2
             ELSE 3 END,
        leads.next_follow_up_at ASC NULLS LAST, leads.created_at
    """
    return (
        select(Lead)
        .where(text(f"leads.assigned_to = :user_id AND {_OPEN}").bindparams(user_id=user_id, closed_stages=closed))
        .order_by(text(urgency).bindparams(closed_stages=closed, priority_hot="Hot"))
    )


def queue_counts(user_id: int) -> dict[str, int]:
    params = {"user_id": user_id}
    columns = []
    for name, (condition, queue_params) in QUEUES.items():
        columns.append(f"COUNT(*) FILTER (WHERE {condition}) AS {name}")
        params.update(queue_params)
    sql = f"SELECT {', '.join(columns)} FROM leads WHERE leads.assigned_to = :user_id"
    row = db.session.execute(text(sql), params).one()
    return dict(row._mapping)


def activities_stmt(lead_id: int) -> Select:
    """Returns a Select (callers paginate / extend it); its filter and ordering are raw SQL with bound parameters."""
    return (
        select(LeadActivity)
        .where(text("lead_activities.lead_id = :lead_id").bindparams(lead_id=lead_id))
        .order_by(text("lead_activities.occurred_at DESC, lead_activities.activity_id DESC"))
    )
