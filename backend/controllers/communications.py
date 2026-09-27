"""Communications inbox, branch channels, notification centre and rules."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models.enums import ACTIVITY_DIRECTIONS, COMM_DELIVERY_STATUSES, COMM_MATCH_STATUSES, INTEGRATION_MODES
from repositories.communications import NOTIFICATION_TABS
from services import communications as comms_service

QUEUES = ("Awaiting Reply", "Failed Communications", "Manual Activity", "Match Review", "Missed Calls", "Other")
SLA_STATES = ("Within SLA", "At Risk", "Breached", "Met", "Met Late")


def list_communications():
    v = Validator(request.args.to_dict())
    v.choice("queue", QUEUES)
    v.choice("sla_state", SLA_STATES)
    v.choice("match_status", COMM_MATCH_STATUSES)
    v.integer("branch_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = comms_service.list_inbox(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def record_communication():
    v = Validator(json_body())
    v.integer("branch_id", required=True, min_value=1)
    v.integer("contact_channel_id", required=True, min_value=1)
    v.choice("direction", ACTIVITY_DIRECTIONS, required=True)
    v.choice("delivery_status", COMM_DELIVERY_STATUSES, required=True)
    v.string("from_address", nullable=True, max_length=255)
    v.string("to_address", nullable=True, max_length=255)
    v.string("subject", nullable=True, max_length=255)
    v.string("body", nullable=True)
    v.integer("call_duration_seconds", nullable=True, min_value=0)
    v.string("failure_reason", nullable=True)
    v.integer("person_id", nullable=True, min_value=1)
    v.integer("lead_id", nullable=True, min_value=1)
    v.boolean("needs_response")
    v.datetime("response_due_at", nullable=True)
    v.datetime("occurred_at", nullable=True)
    return created(comms_service.record(v.validate()).to_dict())


def reply(communication_id: int):
    v = Validator(json_body())
    v.string("body", required=True)
    v.string("subject", nullable=True, max_length=255)
    v.choice("delivery_status", ("Sent", "Delivered", "Read", "Failed"))
    return created(comms_service.reply(communication_id, v.validate()).to_dict())


def retry(communication_id: int):
    v = Validator(json_body())
    v.choice("delivery_status", ("Sent", "Delivered", "Failed"))
    v.string("failure_reason", nullable=True)
    return created(comms_service.retry(communication_id, v.validate()).to_dict())


def match(communication_id: int):
    v = Validator(json_body())
    v.integer("person_id", required=True, min_value=1)
    v.integer("lead_id", nullable=True, min_value=1)
    data = v.validate()
    return ok(comms_service.match(communication_id, data["person_id"], data.get("lead_id")).to_dict())


def list_channels():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    return ok([c.to_dict() for c in comms_service.list_channels(v.validate().get("branch_id"))])


def _channel_rules(v: Validator, creating: bool) -> None:
    if creating:
        v.integer("branch_id", required=True, min_value=1)
        v.integer("contact_channel_id", required=True, min_value=1)
    v.string("address", required=creating, max_length=255)
    v.choice("mode", INTEGRATION_MODES)
    v.boolean("is_active")


def create_channel():
    v = Validator(json_body())
    _channel_rules(v, True)
    return created(comms_service.create_channel(v.validate()).to_dict())


def update_channel(channel_id: int):
    v = Validator(json_body())
    _channel_rules(v, False)
    return ok(comms_service.update_channel(channel_id, require_changes(v.validate())).to_dict())


def list_notifications():
    v = Validator(request.args.to_dict())
    v.choice("tab", tuple(NOTIFICATION_TABS))
    page, per_page = get_page_params()
    rows, meta = comms_service.my_notifications(v.validate().get("tab"), page, per_page)
    return paginated([n.to_dict() for n in rows], {**meta, "unread": comms_service.unread_count()})


def mark_notification(notification_id: int, action: str):
    return ok(comms_service.mark(notification_id, action).to_dict())


def list_rules():
    return ok([r.to_dict() for r in comms_service.list_rules()])


def update_rule(rule_id: int):
    v = Validator(json_body())
    v.integer("warn_after_minutes", nullable=True, min_value=1)
    v.integer("escalate_after_minutes", nullable=True, min_value=1)
    v.string("recipient_role", max_length=50, upper=True)
    v.string("escalate_to_role", nullable=True, max_length=50, upper=True)
    v.boolean("send_whatsapp")
    v.boolean("send_email")
    v.boolean("is_active")
    v.string("description", nullable=True)
    return ok(comms_service.update_rule(rule_id, require_changes(v.validate())).to_dict())
