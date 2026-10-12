"""Reading and recovering WhatsApp messages (db 033/034): the message list, a person's WhatsApp conversation, retry of a
failed message, and the learner's marketing consent. Messages are visible to anyone who can see the person's branch;
retry is for managers and Accounts."""
from datetime import datetime, timezone

from sqlalchemy import select

from config.database import db
from models import WhatsappOutbox
from repositories import whatsapp as whatsapp_repo
from repositories.common import paginate
from services import audit, persons as persons_service, whatsapp
from services.context import MANAGER_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound

CONSENT_STATUSES = ("Explicit Consent", "Withdrawn", "Not Recorded")
UNCLEAR = "may have been delivered"


def get_message(outbox_id: int) -> WhatsappOutbox:
    row = db.session.get(WhatsappOutbox, outbox_id)
    if row is None or not current_user().can_access_branch(row.branch_id):
        raise NotFound("WhatsApp message not found")
    return row


def list_messages(filters: dict, page: int, per_page: int):
    return paginate(whatsapp_repo.messages_stmt(filters, current_user().branch_ids()), page, per_page)


def summary(branch_id: int | None) -> dict:
    counts = whatsapp_repo.status_counts(current_user().branch_ids(), branch_id)
    return {"counts": counts, "total": sum(counts.values()), "sending": whatsapp.configured(),
            "test_numbers_only": bool(whatsapp.test_numbers())}


def person_conversation(person_id: int) -> dict:
    person = persons_service.get_person(person_id)
    scope = current_user().branch_ids()
    sent = db.session.execute(whatsapp_repo.messages_stmt({"person_id": person_id, "learner_only": True}, scope).limit(100)).scalars().all()
    inbound = db.session.execute(whatsapp_repo.inbound_for_person(person_id).limit(100)).scalars().all()
    items = [{"direction": "Outbound", "at": row.sent_at or row.created_at, **row.to_dict()} for row in sent]
    items += [{"direction": "Inbound", "at": comm.occurred_at, "communication_id": comm.communication_id,
               "body_text": comm.body, "status": "Received"} for comm in inbound
              if scope is None or comm.branch_id in scope]
    items.sort(key=lambda item: item["at"], reverse=True)
    return {"person": person.to_summary(), "whatsapp_number": whatsapp.recipient_phone(person),
            "consent": person.to_dict()["whatsapp_consent"], "notifications": person.whatsapp_notifications,
            "messages": items}


def retry(outbox_id: int, confirm_not_delivered: bool) -> WhatsappOutbox:
    user = current_user()
    row = get_message(outbox_id)
    if not (user.has_role(*MANAGER_ROLES, "ACCOUNTS", branch_id=row.branch_id)):
        raise Forbidden("Only a Branch Manager, Accounts or an admin can send a message again")
    if row.status not in ("Failed", "Skipped"):
        raise BusinessRule(f"A {row.status} message can't be sent again")
    if row.source_type == "lms":
        raise BusinessRule("This message came from the LMS. The LMS sends it again itself, so it can't be resent here")
    if row.to_phone is None:
        raise BusinessRule("There is no WhatsApp number on file for this person. Add one, then queue the message again")
    if row.status == "Failed" and UNCLEAR in (row.last_error or "") and not confirm_not_delivered:
        raise BusinessRule("The provider's answer was lost and the message may have reached the learner. Check their "
                           "WhatsApp, then confirm it was not delivered")
    old = {"status": row.status, "error": row.last_error or row.skip_reason}
    whatsapp.requeue([row.outbox_id])
    audit.record("WHATSAPP_RETRIED", "whatsapp_message", row.outbox_id, old=old, new={"status": "Queued"},
                 branch_id=row.branch_id)
    db.session.info.setdefault(whatsapp.PUSH_KEY, set()).add(row.outbox_id)
    return row


def record_consent(person_id: int, status: str, source: str | None) -> dict:
    person = persons_service.get_person(person_id)
    old = person.whatsapp_consent
    person.whatsapp_consent = status
    person.whatsapp_consent_by = current_user().user_id
    person.whatsapp_consent_at = None if status == "Not Recorded" else datetime.now(timezone.utc)
    person.whatsapp_consent_source = source
    db.session.flush()
    audit.record("WHATSAPP_CONSENT", "person", person_id, old={"status": old}, new={"status": status, "source": source},
                 branch_id=person.registered_branch_id)
    return person.to_dict()["whatsapp_consent"]


def set_notifications(person_id: int, enabled: bool) -> dict:
    """The WhatsApp notifications switch. On records Explicit Consent when none is recorded (source "Profile switch"),
    so marketing templates can follow; off only mutes the person (consent is left as it is)."""
    person = persons_service.get_person(person_id)
    old = {"enabled": person.whatsapp_notifications, "consent": person.whatsapp_consent}
    person.whatsapp_notifications = enabled
    if enabled and person.whatsapp_consent != "Explicit Consent":
        person.whatsapp_consent = "Explicit Consent"
        person.whatsapp_consent_by = current_user().user_id
        person.whatsapp_consent_at = datetime.now(timezone.utc)
        person.whatsapp_consent_source = "Profile switch"
    db.session.flush()
    audit.record("WHATSAPP_NOTIFICATIONS", "person", person_id, old=old,
                 new={"enabled": enabled, "consent": person.whatsapp_consent}, branch_id=person.registered_branch_id)
    return {"notifications": person.whatsapp_notifications, "consent": person.to_dict()["whatsapp_consent"]}
