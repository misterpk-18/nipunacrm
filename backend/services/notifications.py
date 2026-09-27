"""Internal notification sending for other modules (the Notification Centre API comes in step 14).

Recipients come from the rule's role at the record's branch. Notifications are deduplicated by
event occurrence + linked record + recipient + purpose; warn / escalate times are filled by a trigger.
"""
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from config.database import db
from models import Notification, NotificationRule
from repositories import users as users_repo


def notify(
    rule_code: str,
    *,
    event_key: str,
    entity_type: str,
    entity_id: int | str,
    title: str,
    branch_id: int | None = None,
    body: str | None = None,
    recipient_user_ids: list[int] | None = None,
    purpose: str = "notify",
) -> list[Notification]:
    rule = db.session.execute(
        select(NotificationRule).where(NotificationRule.rule_code == rule_code, NotificationRule.is_active)
    ).scalar_one_or_none()
    if rule is None:
        return []  # rule switched off (or not configured)

    recipients = recipient_user_ids if recipient_user_ids is not None else users_repo.user_ids_with_role(
        rule.recipient_role_id, branch_id
    )
    for user_id in recipients:
        db.session.execute(
            insert(Notification)
            .values(rule_id=rule.rule_id, event_key=event_key, purpose=purpose, entity_type=entity_type,
                    entity_id=str(entity_id), recipient_user_id=user_id, branch_id=branch_id, title=title, body=body)
            .on_conflict_do_nothing(index_elements=["event_key", "entity_type", "entity_id", "recipient_user_id", "purpose"])
        )

    return list(db.session.execute(
        select(Notification).where(
            Notification.event_key == event_key,
            Notification.entity_type == entity_type,
            Notification.entity_id == str(entity_id),
            Notification.purpose == purpose,
        ).order_by(Notification.notification_id)
    ).scalars())


def complete_for(entity_type: str, entity_id: int | str) -> int:
    """The action behind these notifications is done (e.g. the SCR was decided). Returns how many were closed."""
    result = db.session.execute(
        update(Notification)
        .where(Notification.entity_type == entity_type, Notification.entity_id == str(entity_id),
               Notification.is_action_required, Notification.action_completed_at.is_(None))
        .values(action_completed_at=func.now(), read_at=func.coalesce(Notification.read_at, func.now()))
    )
    return result.rowcount
