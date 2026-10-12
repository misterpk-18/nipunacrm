"""WhatsApp outbox queries (db 033)."""
from sqlalchemy import Select, func, or_, select

from models import Communication, ContactChannel, Person, WhatsappOutbox


def messages_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(WhatsappOutbox).order_by(WhatsappOutbox.outbox_id.desc())
    if branch_ids is not None:
        stmt = stmt.where(WhatsappOutbox.branch_id.in_(branch_ids))
    if filters.get("branch_id"):
        stmt = stmt.where(WhatsappOutbox.branch_id == filters["branch_id"])
    if filters.get("person_id"):
        stmt = stmt.where(WhatsappOutbox.person_id == filters["person_id"])
    if filters.get("learner_only"):  # a learner's conversation never shows staff alerts about them
        stmt = stmt.where(WhatsappOutbox.recipient_user_id.is_(None))
    if filters.get("status"):
        stmt = stmt.where(WhatsappOutbox.status == filters["status"])
    if filters.get("template"):
        stmt = stmt.where(WhatsappOutbox.template_name.ilike(f"%{filters['template']}%"))
    if filters.get("sent_by"):  # CRM or LMS (db 045)
        lms = WhatsappOutbox.source_type == "lms"
        stmt = stmt.where(lms if filters["sent_by"] == "LMS" else ~lms)
    if filters.get("category"):
        stmt = stmt.where(WhatsappOutbox.category == filters["category"])
    if filters.get("q"):
        like = f"%{filters['q']}%"
        stmt = stmt.outerjoin(Person, Person.person_id == WhatsappOutbox.person_id).where(or_(
            Person.full_name.ilike(like), WhatsappOutbox.to_phone.ilike(like), WhatsappOutbox.body_text.ilike(like)))
    return stmt


def status_counts(branch_ids: set[int] | None, branch_id: int | None) -> dict:
    stmt = select(WhatsappOutbox.status, func.count()).group_by(WhatsappOutbox.status)
    if branch_ids is not None:
        stmt = stmt.where(WhatsappOutbox.branch_id.in_(branch_ids))
    if branch_id:
        stmt = stmt.where(WhatsappOutbox.branch_id == branch_id)
    from config.database import db

    return {status: count for status, count in db.session.execute(stmt).all()}


def inbound_for_person(person_id: int) -> Select:
    return (select(Communication).join(ContactChannel, ContactChannel.contact_channel_id == Communication.contact_channel_id)
            .where(Communication.person_id == person_id, ContactChannel.code == "WHATSAPP",
                   Communication.direction == "Inbound").order_by(Communication.occurred_at.desc()))
