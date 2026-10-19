"""Queries behind "Forgot password?" (db 046)."""
from datetime import datetime

from sqlalchemy import func, select, update

from config.database import db
from models import PasswordResetCode, User
from services.persons import normalise_phone


def active_users_with_phone(phone: str) -> list[User]:
    """Active users whose mobile is this number. Older rows may hold the number in another format, so both sides are
    normalised (+91XXXXXXXXXX) before comparing."""
    users = db.session.execute(select(User).where(User.is_active, User.phone.is_not(None))).scalars().all()
    return [user for user in users if normalise_phone(user.phone) == phone]


def codes_since(user_id: int, since: datetime) -> list[PasswordResetCode]:
    return db.session.execute(
        select(PasswordResetCode).where(PasswordResetCode.user_id == user_id, PasswordResetCode.created_at >= since)
        .order_by(PasswordResetCode.created_at.desc())
    ).scalars().all()


def live_code(user_id: int) -> PasswordResetCode | None:
    """The newest code that is neither used nor retired (it may still have expired)."""
    return db.session.execute(
        select(PasswordResetCode).where(PasswordResetCode.user_id == user_id, PasswordResetCode.used_at.is_(None),
                                        PasswordResetCode.retired_at.is_(None))
        .order_by(PasswordResetCode.created_at.desc()).limit(1)
    ).scalar_one_or_none()


def retire_live_codes(user_id: int) -> None:
    db.session.execute(
        update(PasswordResetCode).where(PasswordResetCode.user_id == user_id, PasswordResetCode.used_at.is_(None),
                                        PasswordResetCode.retired_at.is_(None))
        .values(retired_at=func.now())
    )
