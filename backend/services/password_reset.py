"""Forgot password: a one-time code on WhatsApp to the account's mobile (db 046).

POST /auth/forgot-password always gives the same answer, so it never tells whether a number belongs to an account.
A code is sent only when exactly one active user has that mobile, at most once a minute and five times an hour.
Only an HMAC of the code is stored; the code itself rides in the outbox's secret_params until the message is sent.
"""
import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone

from flask import current_app
from sqlalchemy.dialects.postgresql import insert

from config.database import db
from models import PasswordResetCode, User, WhatsappOutbox
from repositories import password_reset as reset_repo
from repositories import sessions as sessions_repo
from repositories import settings as settings_repo
from services import audit, whatsapp
from services.auth import check_password_policy
from services.context import client_ip
from services.errors import ValidationError
from services.security import hash_password
from services.whatsapp_templates import CRM_PASSWORD_RESET_CODE, HIDDEN

logger = logging.getLogger(__name__)

SOURCE_TYPE = "password_reset"
SENT_MESSAGE = "If an active account uses this mobile number, a code has been sent to it on WhatsApp."
INVALID_CODE = "That code is wrong or has expired. Ask for a new one."


def _now() -> datetime:
    return datetime.now(timezone.utc)  # tests move the clock here


def _hash(code: str) -> str:
    return hmac.new(current_app.config["SECRET_KEY"].encode(), code.encode(), hashlib.sha256).hexdigest()


def _account(phone: str) -> User | None:
    """The one active user with this mobile; None when there is none or more than one (an admin must fix that)."""
    users = reset_repo.active_users_with_phone(phone)
    if len(users) > 1:
        logger.warning("Password reset refused: %s active users share mobile %s", len(users), phone)
    return users[0] if len(users) == 1 else None


def _skip_reason(to_phone: str) -> str | None:
    if not whatsapp.configured():
        return "WhatsApp sending is switched off"
    allowed = whatsapp.test_numbers()
    if allowed and to_phone not in allowed:
        return "Not a test number (WHATSAPP_TEST_NUMBERS is set)"
    return None


def request_code(phone: str) -> dict:
    """Send a code if the number belongs to exactly one active account. The answer is the same either way."""
    answer = {"message": SENT_MESSAGE, "resend_after_seconds": settings_repo.get_int("password_reset_resend_seconds", 60)}
    user = _account(phone)
    if user is None:
        return answer

    now = _now()
    recent = reset_repo.codes_since(user.user_id, now - timedelta(hours=1))
    if recent and recent[0].created_at > now - timedelta(seconds=answer["resend_after_seconds"]):
        return answer  # asked again too soon: the code already sent is still the one to use
    if len(recent) >= settings_repo.get_int("password_reset_max_per_hour", 5):
        logger.warning("Password reset codes for user %s hit the hourly limit", user.user_id)
        return answer

    reset_repo.retire_live_codes(user.user_id)
    code = f"{secrets.randbelow(1_000_000):06d}"
    row = PasswordResetCode(
        user_id=user.user_id, phone=phone, code_hash=_hash(code), requested_ip=client_ip(),
        expires_at=now + timedelta(minutes=settings_repo.get_int("password_reset_code_minutes", 10)),
        max_attempts=settings_repo.get_int("password_reset_max_attempts", 5),
    )
    db.session.add(row)
    db.session.flush()

    to_phone = whatsapp.digits(phone)
    skip_reason = _skip_reason(to_phone)
    outbox_id = db.session.execute(insert(WhatsappOutbox).values(
        event_key=f"password-reset:{row.reset_id}", template_name=CRM_PASSWORD_RESET_CODE.name,
        language=CRM_PASSWORD_RESET_CODE.language, category=CRM_PASSWORD_RESET_CODE.category, to_phone=to_phone,
        params={"code": HIDDEN}, secret_params={"code": code}, body_text=CRM_PASSWORD_RESET_CODE.render({"code": code}),
        source_type=SOURCE_TYPE, source_id=row.reset_id, recipient_user_id=user.user_id,
        status="Skipped" if skip_reason else "Queued", skip_reason=skip_reason,
    ).returning(WhatsappOutbox.outbox_id)).scalar()
    if not skip_reason:
        db.session.info.setdefault(whatsapp.PUSH_KEY, set()).add(outbox_id)  # sent right after the commit
    else:
        logger.warning("Password reset code for user %s not sent: %s", user.user_id, skip_reason)

    audit.record("PASSWORD_RESET_CODE_SENT", "user", user.user_id, actor_user_id=user.user_id,
                 new={"reset_id": row.reset_id, "whatsapp": skip_reason or "Queued"})
    return answer


def reset_password(phone: str, code: str, new_password: str) -> None:
    """Set a new password with a valid code; every session of the account is signed out."""
    check_password_policy(new_password)  # before the code is checked, so a short password never spends a try
    user = _account(phone)
    row = reset_repo.live_code(user.user_id) if user else None
    now = _now()
    if row is None or row.expires_at <= now:
        raise ValidationError(INVALID_CODE, {"code": [INVALID_CODE]})

    if not hmac.compare_digest(row.code_hash, _hash(code)):
        row.attempts += 1
        if row.attempts >= row.max_attempts:
            row.retired_at = now
        db.session.commit()  # the 400 response would otherwise roll the count back
        raise ValidationError(INVALID_CODE, {"code": [INVALID_CODE]})

    row.used_at = now
    user.password_hash = hash_password(new_password)
    user.must_change_password = False
    user.password_changed_at = now
    user.failed_login_attempts = 0
    user.locked_until = None
    signed_out = sessions_repo.revoke_all_for_user(user.user_id, "password reset with a WhatsApp code")
    audit.record("PASSWORD_RESET_WITH_CODE", "user", user.user_id, actor_user_id=user.user_id,
                 new={"reset_id": row.reset_id, "sessions_signed_out": signed_out})
