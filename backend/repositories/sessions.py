"""Login sessions."""
from sqlalchemy import func, literal_column, select, update

from config.database import db
from models import ActiveSession, UserSession


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
    stmt = select(ActiveSession).where(ActiveSession.user_id == user_id).order_by(ActiveSession.last_seen_at.desc())
    return list(db.session.execute(stmt).scalars())


def touch(session_id: str) -> None:
    """Record activity, at most once a minute per session."""
    db.session.execute(
        update(UserSession)
        .where(UserSession.session_id == session_id, UserSession.last_seen_at < func.now() - literal_column("interval '1 minute'"))
        .values(last_seen_at=func.now())
    )


def mark_reauthenticated(session_id: str) -> None:
    db.session.execute(
        update(UserSession).where(UserSession.session_id == session_id).values(reauthenticated_at=func.now())
    )


def revoke(session_id: str, reason: str) -> None:
    db.session.execute(
        update(UserSession)
        .where(UserSession.session_id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=func.now(), revoke_reason=reason)
    )


def revoke_all_for_user(user_id: int, reason: str, except_session_id: str | None = None) -> int:
    stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_session_id:
        stmt = stmt.where(UserSession.session_id != except_session_id)
    return db.session.execute(stmt.values(revoked_at=func.now(), revoke_reason=reason)).rowcount
