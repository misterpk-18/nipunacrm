"""Queries for persons, enquiries, leads and lead activities."""
from sqlalchemy import Select, and_, case, exists, func, or_, select

from config.database import db
from models import Enquiry, Lead, LeadActivity, Person
from models.enums import CLOSED_STAGES

# ---------------------------------------------------------------- queue tabs (prototype Counsellor workspace)


def _local_date(column):
    return func.date(func.timezone(func.business_tz(), column))


def _open():
    return Lead.stage.not_in(CLOSED_STAGES)


QUEUES = {
    "new": lambda: Lead.stage == "New Enquiry",
    "untouched": lambda: and_(_open(), Lead.last_contacted_at.is_(None)),
    "due_today": lambda: and_(_open(), _local_date(Lead.next_follow_up_at) == _local_date(func.now())),
    "overdue": lambda: and_(_open(), Lead.next_follow_up_at < func.now()),
    "hot": lambda: and_(_open(), Lead.ai_priority == "Hot"),
    "demos": lambda: Lead.stage.in_(("Demo Scheduled", "Demo Attended")),
    "fee_discussion": lambda: Lead.stage == "Fee Discussion / Payment Awaited",
    "payment_pending": lambda: Lead.stage == "Payment Pending Verification",
    "cold": lambda: or_(
        and_(_open(), Lead.ai_priority == "Cold"),
        and_(Lead.stage == "Lost - closed", Lead.reactivation_date <= _local_date(func.now())),
    ),
    "future_joining": lambda: and_(_open(), Lead.ai_priority == "Waiting for Batch / Future Joining"),
}


# ---------------------------------------------------------------- persons

def search_persons(phone: str | None, email: str | None, name: str | None, limit: int = 20) -> list[Person]:
    conditions = []
    if phone:
        conditions += [Person.phone == phone, Person.alternate_phone == phone]
    if email:
        conditions.append(func.lower(Person.email) == email)
    if name:
        conditions.append(Person.full_name.ilike(f"%{name}%"))
    stmt = select(Person).where(or_(*conditions)).order_by(Person.full_name).limit(limit)
    return list(db.session.execute(stmt).scalars())


def person_visible(person_id: int, branch_ids: set[int] | None) -> bool:
    """Registered at, or has a lead at, one of the user's branches."""
    if branch_ids is None:
        return True
    stmt = select(Person.person_id).where(
        Person.person_id == person_id,
        or_(Person.registered_branch_id.in_(branch_ids),
            exists().where(Lead.person_id == Person.person_id, Lead.branch_id.in_(branch_ids))),
    )
    return db.session.execute(stmt).first() is not None


def open_leads_for_persons(person_ids: list[int], branch_id: int | None = None) -> list[Lead]:
    if not person_ids:
        return []
    stmt = select(Lead).where(Lead.person_id.in_(person_ids), _open()).order_by(Lead.lead_id)
    if branch_id is not None:
        stmt = stmt.where(Lead.branch_id == branch_id)
    return list(db.session.execute(stmt).scalars())


def find_open_lead(person_id: int, course_id: int | None, branch_id: int) -> Lead | None:
    stmt = select(Lead).where(
        Lead.person_id == person_id, Lead.branch_id == branch_id, _open(),
        Lead.course_id.is_(None) if course_id is None else Lead.course_id == course_id,
    )
    return db.session.execute(stmt).scalars().first()


def persons_matching(phone: str | None, email: str | None) -> list[Person]:
    if not phone and not email:
        return []
    return search_persons(phone, email, None)


# ---------------------------------------------------------------- enquiries

def enquiries_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(Enquiry).order_by(Enquiry.received_at.desc(), Enquiry.enquiry_id.desc())
    if branch_ids is not None:
        stmt = stmt.where(Enquiry.branch_id.in_(branch_ids))
    if filters.get("branch_id"):
        stmt = stmt.where(Enquiry.branch_id == filters["branch_id"])
    if filters.get("intake_status"):
        stmt = stmt.where(Enquiry.intake_status == filters["intake_status"])
    if filters.get("linked") is not None:
        stmt = stmt.where(Enquiry.lead_id.is_not(None) if filters["linked"] else Enquiry.lead_id.is_(None))
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Enquiry.enquiry_code.ilike(pattern), Enquiry.raw_name.ilike(pattern),
                              Enquiry.raw_phone.ilike(pattern), Enquiry.raw_email.ilike(pattern)))
    return stmt


def enquiries_for_lead(lead_id: int) -> list[Enquiry]:
    stmt = select(Enquiry).where(Enquiry.lead_id == lead_id).order_by(Enquiry.received_at, Enquiry.enquiry_id)
    return list(db.session.execute(stmt).scalars())


# ---------------------------------------------------------------- leads

def leads_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(Lead).join(Person, Person.person_id == Lead.person_id)

    if branch_ids is not None:
        stmt = stmt.where(Lead.branch_id.in_(branch_ids))
    for field, column in (("branch_id", Lead.branch_id), ("stage", Lead.stage), ("course_id", Lead.course_id),
                          ("source_id", Lead.original_source_id), ("intake_status", Lead.intake_status),
                          ("priority", Lead.ai_priority)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if "assigned_to" in filters:
        assigned = filters["assigned_to"]
        stmt = stmt.where(Lead.assigned_to.is_(None) if assigned is None else Lead.assigned_to == assigned)
    if filters.get("queue"):
        stmt = stmt.where(QUEUES[filters["queue"]]())
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        digits = "".join(ch for ch in filters["q"] if ch.isdigit())
        conditions = [Person.full_name.ilike(pattern), Person.email.ilike(pattern), Lead.lead_code.ilike(pattern)]
        if len(digits) >= 4:
            conditions.append(Person.phone.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conditions))

    return stmt.order_by(Lead.created_at.desc(), Lead.lead_id.desc())


def workspace_stmt(user_id: int) -> Select:
    """A counsellor's own open leads: overdue first, then due today, then hot, then by follow-up time."""
    urgency = case(
        (QUEUES["overdue"](), 0),
        (QUEUES["due_today"](), 1),
        (Lead.ai_priority == "Hot", 2),
        else_=3,
    )
    return (
        select(Lead)
        .where(Lead.assigned_to == user_id, _open())
        .order_by(urgency, Lead.next_follow_up_at.asc().nulls_last(), Lead.created_at)
    )


def queue_counts(user_id: int) -> dict[str, int]:
    columns = [func.count().filter(condition()).label(name) for name, condition in QUEUES.items()]
    row = db.session.execute(select(*columns).select_from(Lead).where(Lead.assigned_to == user_id)).one()
    return dict(row._mapping)


def activities_stmt(lead_id: int) -> Select:
    return (
        select(LeadActivity)
        .where(LeadActivity.lead_id == lead_id)
        .order_by(LeadActivity.occurred_at.desc(), LeadActivity.activity_id.desc())
    )
