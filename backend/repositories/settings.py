"""Admin-editable values in app_settings."""
from typing import Any


from config.database import db
from repositories.common import text


def get(key: str, default: Any = None) -> Any:
    value = db.session.execute(text("SELECT setting_value FROM app_settings WHERE setting_key = :key"),
                               {"key": key}).scalar()
    return default if value is None else value


def get_int(key: str, default: int) -> int:
    return int(get(key, default))
