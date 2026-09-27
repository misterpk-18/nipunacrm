"""Passwords and session tokens."""
import hashlib
import secrets
from functools import cache

from flask import current_app, has_app_context
from werkzeug.security import check_password_hash, generate_password_hash


def _method() -> str:
    """scrypt by default; tests use a cheap method (PASSWORD_HASH_METHOD) to stay fast."""
    return current_app.config.get("PASSWORD_HASH_METHOD", "scrypt") if has_app_context() else "scrypt"


def hash_password(password: str) -> str:
    return generate_password_hash(password, method=_method())


def verify_password(password_hash: str | None, password: str) -> bool:
    # Always run a hash check, even for unknown users, so response time doesn't reveal which emails exist
    return check_password_hash(password_hash or _dummy_hash(), password) and password_hash is not None


def _dummy_hash() -> str:
    return _dummy_hash_for(_method())


@cache
def _dummy_hash_for(method: str) -> str:
    return generate_password_hash(secrets.token_urlsafe(16), method=method)


def new_session_token() -> str:
    """Random 256-bit token handed to the client once."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """What we store and look up: SHA-256 of the token."""
    return hashlib.sha256(token.encode()).hexdigest()


def generate_temporary_password() -> str:
    return secrets.token_urlsafe(12)
