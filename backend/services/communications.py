"""Communications inbox (manual activity until integrations are live), branch channels, the notification
centre and notification rules."""
from datetime import datetime, timezone

from sqlalchemy import select

from config.database import db
from models import BranchChannel, Communication, ContactChannel, Lead, Notification, NotificationRule, Role
from repositories import communications as comms_repo
from repositories import leads as leads_repo
from repositories import settings as settings_repo
from repositories.common import paginate
from services import audit, sla
from services import leads as leads_service
from services import persons as persons_service
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

# Staffed minutes to answer an inbound message that needs a response (assumption; not in the prototype)
DEFAULT_RESPONSE_MINUTES = 60
ACTIVITY_BY_CHANNEL = {"PHONE_CALL": "Call", "OUTBOUND_CALL": "Call", "WHATSAPP": "WhatsApp", "EMAIL": "Email",
                       "IN_PERSON": "Meeting"}


# ---------------------------------------------------------------- inbox

def get_communication(communication_id: int) -> Communication:
    comm = db.session.get(Communication, communication_id)
    if comm is None or not current_user().can_access_branch(comm.branch_id):
        raise NotFound("Communication not found")
    return comm


def list_inbox(filters: dict, page: int, per_page: int):
    return paginate(comms_repo.inbox_stmt(filters, current_user().branch_ids()), page, per_page)


def _match(comm: Communication, person_id: int | None, lead_id: int | None) -> None:
    if lead_id:
        lead = leads_service.get_lead(lead_id)
        person_id = person_id or lead.person_id
        if lead.person_id != person_id:
            raise ValidationError("The lead belongs to someone else", {"lead_id": ["Different person"]})
    if person_id:
        persons_service.get_person(person_id)
        comm.person_id, comm.lead_id, comm.match_status = person_id, lead_id, "Matched"
        comm.matched_by = current_user().user_id
        return
    address = comm.from_address if comm.direction == "Inbound" else comm.to_address
    phone = persons_service.normalise_phone(address) if address else None
    candidates = leads_repo.persons_matching(phone, address.lower() if address and "@" in address else None)
    if candidates:
        comm.match_status = "Match Review"  # never matched automatically
        comm.person_id = candidates[0].person_id if len(candidates) == 1 else None


def _log_on_lead(comm: Communication) -> None:
    if not comm.lead_id:
        return
    lead = db.session.get(Lead, comm.lead_id)
    activity_type = ACTIVITY_BY_CHANNEL.get(comm.channel.code, "Note")
    leads_service.log_activity(lead, activity_type, comm.subject or comm.body, direction=comm.direction,
                               contact_channel_id=comm.contact_channel_id, communication_id=comm.communication_id,
                               call_duration_seconds=comm.call_duration_seconds, occurred_at=comm.occurred_at,
                               outcome=comm.delivery_status)
    if comm.delivery_status not in ("Failed", "Missed") and (
            lead.last_contacted_at is None or comm.occurred_at > lead.last_contacted_at):
        lead.last_contacted_at = comm.occurred_at


def record(data: dict) -> Communication:
    if not current_user().can_access_branch(data["branch_id"]):
        raise Forbidden("You can only record communications at your own branches")
    channel = db.session.get(ContactChannel, data["contact_channel_id"])
    if channel is None:
        raise ValidationError("Unknown channel", {"contact_channel_id": ["Not found"]})
    occurred_at = data.get("occurred_at") or datetime.now(timezone.utc)
    if occurred_at > datetime.now(timezone.utc):
        raise ValidationError("Can't be in the future", {"occurred_at": ["Must not be in the future"]})
    needs_response = data.get("needs_response", data["direction"] == "Inbound" and data["delivery_status"] != "Missed")
    due = data.get("response_due_at")
    if needs_response and due is None:
        minutes = settings_repo.get_int("communication_response_staffed_minutes", DEFAULT_RESPONSE_MINUTES)
        due = sla.staffed_deadline(data["branch_id"], occurred_at, minutes)

    comm = Communication(
        branch_id=data["branch_id"], contact_channel_id=channel.contact_channel_id, direction=data["direction"],
        from_address=data.get("from_address"), to_address=data.get("to_address"), subject=data.get("subject"),
        body=data.get("body"), call_duration_seconds=data.get("call_duration_seconds"),
        delivery_status=data["delivery_status"], failure_reason=data.get("failure_reason"), is_manual=True,
        needs_response=needs_response, response_due_at=due if needs_response else None, occurred_at=occurred_at,
        created_by=current_user().user_id,
    )
    db.session.add(comm)
    _match(comm, data.get("person_id"), data.get("lead_id"))
    db.session.flush()
    db.session.refresh(comm)
    _log_on_lead(comm)
    db.session.flush()
    return comm


def reply(communication_id: int, data: dict) -> Communication:
    """Log the outbound reply and mark the original responded."""
    original = get_communication(communication_id)
    if original.direction != "Inbound":
        raise BusinessRule("Only inbound messages can be replied to")
    now = datetime.now(timezone.utc)
    response = Communication(
        branch_id=original.branch_id, contact_channel_id=original.contact_channel_id, direction="Outbound",
        from_address=original.to_address, to_address=original.from_address, subject=data.get("subject"),
        body=data["body"], delivery_status=data.get("delivery_status", "Sent"), is_manual=True,
        match_status=original.match_status if original.match_status == "Matched" else "Unmatched",
        person_id=original.person_id if original.match_status == "Matched" else None, lead_id=original.lead_id,
        occurred_at=now, created_by=current_user().user_id,
    )
    db.session.add(response)
    if original.responded_at is None:
        original.responded_at = now
        original.handled_by = current_user().user_id
    db.session.flush()
    db.session.refresh(response)
    _log_on_lead(response)
    db.session.flush()
    return response


def retry(communication_id: int, data: dict) -> Communication:
    original = get_communication(communication_id)
    if original.delivery_status != "Failed":
        raise BusinessRule("Only failed communications can be retried")
    comm = Communication(
        branch_id=original.branch_id, contact_channel_id=original.contact_channel_id, direction=original.direction,
        from_address=original.from_address, to_address=original.to_address, subject=original.subject,
        body=original.body, delivery_status=data.get("delivery_status", "Sent"),
        failure_reason=data.get("failure_reason"), retry_of_id=original.communication_id, is_manual=True,
        match_status=original.match_status, person_id=original.person_id, lead_id=original.lead_id,
        created_by=current_user().user_id,
    )
    db.session.add(comm)
    db.session.flush()
    db.session.refresh(comm)
    return comm


def match(communication_id: int, person_id: int, lead_id: int | None) -> Communication:
    comm = get_communication(communication_id)
    if comm.match_status == "Matched":
        raise BusinessRule("Already matched")
    _match(comm, person_id, lead_id)
    db.session.flush()
    _log_on_lead(comm)
    db.session.flush()
    return comm


# ---------------------------------------------------------------- branch channels

def list_channels(branch_id: int | None) -> list[BranchChannel]:
    stmt = select(BranchChannel).order_by(BranchChannel.branch_id, BranchChannel.branch_channel_id)
    if branch_id:
        stmt = stmt.where(BranchChannel.branch_id == branch_id)
    return list(db.session.execute(stmt).scalars())


def create_channel(data: dict) -> BranchChannel:
    channel = BranchChannel(**data)
    db.session.add(channel)
    db.session.flush()
    audit.record("BRANCH_CHANNEL_CREATED", "branch_channel", channel.branch_channel_id, new=data, branch_id=data["branch_id"])
    return channel


def update_channel(channel_id: int, data: dict) -> BranchChannel:
    channel = db.session.get(BranchChannel, channel_id)
    if channel is None:
        raise NotFound("Branch channel not found")
    for field, value in data.items():
        setattr(channel, field, value)
    db.session.flush()
    audit.record("BRANCH_CHANNEL_UPDATED", "branch_channel", channel_id, new=data, branch_id=channel.branch_id)
    return channel


# ---------------------------------------------------------------- notification centre

def my_notifications(tab: str | None, page: int, per_page: int):
    return paginate(comms_repo.notifications_stmt(current_user().user_id, tab), page, per_page)


def unread_count() -> int:
    from sqlalchemy import func

    return db.session.execute(select(func.count()).where(Notification.recipient_user_id == current_user().user_id,
                                                         Notification.read_at.is_(None))).scalar_one()


def _mine(notification_id: int) -> Notification:
    notification = db.session.get(Notification, notification_id)
    if notification is None or notification.recipient_user_id != current_user().user_id:
        raise NotFound("Notification not found")
    return notification


def mark(notification_id: int, action: str) -> Notification:
    """read / acknowledge (also marks read) / complete (action-required notifications only)."""
    notification = _mine(notification_id)
    now = datetime.now(timezone.utc)
    if action == "read":
        notification.read_at = notification.read_at or now
    elif action == "acknowledge":
        notification.acknowledged_at = notification.acknowledged_at or now
    else:
        if not notification.is_action_required:
            raise BusinessRule("This notification has no action to complete")
        notification.action_completed_at = notification.action_completed_at or now
        notification.read_at = notification.read_at or now
    db.session.flush()
    db.session.refresh(notification)
    return notification


def list_rules() -> list[NotificationRule]:
    return list(db.session.execute(select(NotificationRule).order_by(NotificationRule.rule_code)).scalars())


def update_rule(rule_id: int, data: dict) -> NotificationRule:
    rule = db.session.get(NotificationRule, rule_id)
    if rule is None:
        raise NotFound("Notification rule not found")
    old = rule.to_dict()
    for code_field, id_field in (("recipient_role", "recipient_role_id"), ("escalate_to_role", "escalate_to_role_id")):
        if code_field in data:
            code = data.pop(code_field)
            role_id = db.session.execute(select(Role.role_id).where(Role.role_code == code)).scalar() if code else None
            if code and role_id is None:
                raise ValidationError("Unknown role", {code_field: ["Not found"]})
            data[id_field] = role_id
    for field, value in data.items():
        setattr(rule, field, value)
    db.session.flush()  # the DB checks escalate > warn and that escalation has a target
    db.session.refresh(rule)
    audit.record("NOTIFICATION_RULE_UPDATED", "notification_rule", rule_id, old=old, new=rule.to_dict())
    return rule
