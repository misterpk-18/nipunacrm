"""Write audit_log entries (append-only)."""
import json
from typing import Any

from config.database import db
from models import AuditLog
from services.context import actor_id, client_ip

_CURRENT_ACTOR = object()


def _jsonable(values: dict | None) -> dict | None:
    """Dates, times and money become strings so snapshots fit in JSONB."""
    return None if values is None else json.loads(json.dumps(values, default=str))


def record(
    action: str,
    entity_type: str,
    entity_id: Any,
    *,
    old: dict | None = None,
    new: dict | None = None,
    reason: str | None = None,
    branch_id: int | None = None,
    actor_user_id: Any = _CURRENT_ACTOR,
) -> None:
    db.session.add(
        AuditLog(
            actor_user_id=actor_id() if actor_user_id is _CURRENT_ACTOR else actor_user_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            branch_id=branch_id,
            old_values=_jsonable(old),
            new_values=_jsonable(new),
            reason=reason,
            ip_address=client_ip(),
        )
    )
