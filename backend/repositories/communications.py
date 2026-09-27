"""Unified inbox and notification queries."""
from sqlalchemy import Select, and_, select

from models import CommunicationInbox, Notification

NOTIFICATION_TABS = {
    "Action Required": lambda: and_(Notification.is_action_required, Notification.action_completed_at.is_(None),
                                    Notification.category == "Action Required"),
    "Escalations": lambda: and_(Notification.category == "Escalation", Notification.action_completed_at.is_(None)),
    "Unread": lambda: Notification.read_at.is_(None),
    "System Issues": lambda: Notification.category == "System Issue",
    "Completed": lambda: Notification.action_completed_at.is_not(None),
}


def inbox_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(CommunicationInbox).order_by(CommunicationInbox.occurred_at.desc())
    if branch_ids is not None:
        stmt = stmt.where(CommunicationInbox.branch_id.in_(branch_ids))
    for field, column in (("queue", CommunicationInbox.queue), ("branch_id", CommunicationInbox.branch_id),
                          ("sla_state", CommunicationInbox.sla_state), ("match_status", CommunicationInbox.match_status)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    return stmt


def notifications_stmt(user_id: int, tab: str | None) -> Select:
    stmt = select(Notification).where(Notification.recipient_user_id == user_id).order_by(
        Notification.delivered_at.desc(), Notification.notification_id.desc())
    if tab:
        stmt = stmt.where(NOTIFICATION_TABS[tab]())
    return stmt
