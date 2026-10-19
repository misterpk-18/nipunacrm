"""Login sessions."""
from sqlalchemy import select

from config.database import db
from models import ActiveSession, UserSession
from repositories.common import text


def create(session: UserSession) -> UserSession:
    db.session.add(session)
    db.session.flush()  # expires_at is filled by a trigger
    db.session.refresh(session)
    return session


def find_active(session_id: str) -> ActiveSession | None:
    """Only sessions that are not revoked, not past their max length and not idle (see the active_sessions view)."""
    return db.session.get(ActiveSession, session_id, populate_existing=True)


def get(session_id: str) -> UserSession | None:
    return db.session.get(UserSession, session_id)


def list_active_for_user(user_id: int) -> list[ActiveSession]:
    sql = text("""
        SELECT s.*
        FROM active_sessions s
        WHERE s.user_id = :user_id
        ORDER BY s.last_seen_at DESC
    """)
    return list(db.session.execute(select(ActiveSession).from_statement(sql), {"user_id": user_id}).scalars())


def touch(session_id: str) -> None:
    """Record activity, at most once a minute per session."""
    db.session.execute(
        text("""
            UPDATE user_sessions SET last_seen_at = now()
            WHERE session_id = :session_id AND last_seen_at < now() - interval '1 minute'
        """),
        {"session_id": session_id},
    )


def mark_reauthenticated(session_id: str) -> None:
    db.session.execute(
        text("UPDATE user_sessions SET reauthenticated_at = now() WHERE session_id = :session_id"),
        {"session_id": session_id},
    )


def revoke(session_id: str, reason: str) -> None:
    db.session.execute(
        text("""
            UPDATE user_sessions SET revoked_at = now(), revoke_reason = :reason
            WHERE session_id = :session_id AND revoked_at IS NULL
        """),
        {"session_id": session_id, "reason": reason},
    )


def revoke_all_for_user(user_id: int, reason: str, except_session_id: str | None = None) -> int:
    conditions = ["user_id = :user_id", "revoked_at IS NULL"]
    params = {"user_id": user_id, "reason": reason}
    if except_session_id:
        conditions.append("session_id != :except_session_id")
        params["except_session_id"] = except_session_id
    sql = text("UPDATE user_sessions SET revoked_at = now(), revoke_reason = :reason WHERE " + " AND ".join(conditions))
    return db.session.execute(sql, params).rowcount
