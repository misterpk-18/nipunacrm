"""Unified inbox and notification queries."""
from sqlalchemy import Select

from models import CommunicationInbox, Notification
from repositories.common import raw_select, text

# Notification tab -> fixed SQL over notifications aliased n.
NOTIFICATION_TABS = {
    "Action Required": "n.is_action_required AND n.action_completed_at IS NULL AND n.category = 'Action Required'",
    "Escalations": "n.category = 'Escalation' AND n.action_completed_at IS NULL",
    "Unread": "n.read_at IS NULL",
    "System Issues": "n.category = 'System Issue'",
    "Completed": "n.action_completed_at IS NOT NULL",
}

# Equality filters: request field -> fixed SQL (the value always travels as a :named parameter).
_INBOX_FILTERS = {
    "queue": "ci.queue = :queue",
    "branch_id": "ci.branch_id = :branch_id",
    "sla_state": "ci.sla_state = :sla_state",
    "match_status": "ci.match_status = :match_status",
}


def inbox_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("ci.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in _INBOX_FILTERS.items():
        if filters.get(field) is not None:
            conditions.append(fragment)
            params[field] = filters[field]
    sql = text("SELECT ci.* FROM communication_inbox ci WHERE " + " AND ".join(conditions))
    return raw_select(CommunicationInbox, sql, params, "occurred_at DESC")


def notifications_stmt(user_id: int, tab: str | None) -> Select:
    conditions = ["n.recipient_user_id = :user_id"]
    if tab:
        conditions.append(NOTIFICATION_TABS[tab])
    sql = text("SELECT n.* FROM notifications n WHERE " + " AND ".join(conditions))
    return raw_select(Notification, sql, {"user_id": user_id}, "delivered_at DESC, notification_id DESC")
