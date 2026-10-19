"""WhatsApp outbox queries (db 033)."""
from sqlalchemy import Select

from config.database import db
from models import Communication, WhatsappOutbox
from repositories.common import raw_select, text


def messages_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    joins = ""
    if branch_ids is not None:
        conditions.append("w.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        conditions.append("w.branch_id = :branch_id")
        params["branch_id"] = filters["branch_id"]
    if filters.get("person_id"):
        conditions.append("w.person_id = :person_id")
        params["person_id"] = filters["person_id"]
    if filters.get("learner_only"):  # a learner's conversation never shows staff alerts about them
        conditions.append("w.recipient_user_id IS NULL")
    if filters.get("status"):
        conditions.append("w.status = :status")
        params["status"] = filters["status"]
    if filters.get("template"):
        conditions.append("w.template_name ILIKE :template")
        params["template"] = f"%{filters['template']}%"
    if filters.get("sent_by"):  # CRM or LMS (db 045)
        conditions.append("w.source_type = 'lms'" if filters["sent_by"] == "LMS" else "w.source_type != 'lms'")
    if filters.get("category"):
        conditions.append("w.category = :category")
        params["category"] = filters["category"]
    if filters.get("q"):
        joins = "LEFT JOIN persons pe ON pe.person_id = w.person_id"
        conditions.append("(pe.full_name ILIKE :like OR w.to_phone ILIKE :like OR w.body_text ILIKE :like)")
        params["like"] = f"%{filters['q']}%"
    sql = text("SELECT w.* FROM whatsapp_outbox w " + joins + " WHERE " + " AND ".join(conditions))
    return raw_select(WhatsappOutbox, sql, params, "outbox_id DESC")


def status_counts(branch_ids: set[int] | None, branch_id: int | None) -> dict:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if branch_id:
        conditions.append("branch_id = :branch_id")
        params["branch_id"] = branch_id
    sql = text("SELECT status, COUNT(*) FROM whatsapp_outbox WHERE " + " AND ".join(conditions) + " GROUP BY status")
    return {status: count for status, count in db.session.execute(sql, params).all()}


def inbound_for_person(person_id: int) -> Select:
    sql = text("""
        SELECT c.*
        FROM communications c
        JOIN contact_channels cc ON cc.contact_channel_id = c.contact_channel_id
        WHERE c.person_id = :person_id AND cc.code = 'WHATSAPP' AND c.direction = 'Inbound'
    """)
    return raw_select(Communication, sql, {"person_id": person_id}, "occurred_at DESC")
