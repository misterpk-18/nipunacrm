"""Admin-editable values in app_settings."""
from typing import Any

from sqlalchemy import select

from config.database import db
from models import AppSetting


def get(key: str, default: Any = None) -> Any:
    value = db.session.execute(select(AppSetting.setting_value).where(AppSetting.setting_key == key)).scalar()
    return default if value is None else value


def get_int(key: str, default: int) -> int:
    return int(get(key, default))
