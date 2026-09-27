"""Concession approval limits and app settings (admin-editable values used by the app and triggers)."""
from sqlalchemy import delete, select

from config.database import db
from models import AppSetting, ConcessionLimit, Role
from services import audit
from services.context import current_user
from services.errors import ValidationError


# ---------------------------------------------------------------- concession limits

def list_concession_limits() -> list[ConcessionLimit]:
    return list(db.session.execute(select(ConcessionLimit).join(Role).order_by(Role.role_id)).scalars())


def replace_concession_limits(limits: list[dict]) -> list[ConcessionLimit]:
    """Roles left out lose their approval authority."""
    codes = [limit["role_code"] for limit in limits]
    if len(codes) != len(set(codes)):
        raise ValidationError("Each role can appear only once", {"limits": ["Duplicate role_code"]})
    roles = {r.role_code: r for r in db.session.execute(select(Role).where(Role.role_code.in_(codes))).scalars()}
    missing = set(codes) - set(roles)
    if missing:
        raise ValidationError("Unknown role", {"limits": [f"Not found: {sorted(missing)}"]})

    old = [limit.to_dict() for limit in list_concession_limits()]
    db.session.execute(delete(ConcessionLimit))
    for limit in limits:
        db.session.add(ConcessionLimit(role_id=roles[limit["role_code"]].role_id,
                                       max_percent=limit["max_percent"], max_amount=limit["max_amount"]))
    db.session.flush()

    new = list_concession_limits()
    audit.record("CONCESSION_LIMITS_SET", "concession_limits", "all", old={"limits": old},
                 new={"limits": [limit.to_dict() for limit in new]})
    return new


# ---------------------------------------------------------------- app settings

def list_settings() -> list[AppSetting]:
    return list(db.session.execute(select(AppSetting).order_by(AppSetting.setting_key)).scalars())


def update_settings(values: dict) -> list[AppSetting]:
    """Only existing keys; each keeps its type (number stays number, text stays text)."""
    settings = {s.setting_key: s for s in list_settings()}
    errors = {}
    for key, value in values.items():
        if key not in settings:
            errors[key] = ["Unknown setting"]
        elif type(value) is not type(settings[key].setting_value):
            errors[key] = [f"Must be a {type(settings[key].setting_value).__name__}"]
        elif isinstance(value, int) and value < 0:
            errors[key] = ["Must be 0 or more"]
    if errors:
        raise ValidationError("Invalid settings", errors)

    old = {key: settings[key].setting_value for key in values}
    for key, value in values.items():
        settings[key].setting_value = value
        settings[key].updated_by = current_user().user_id
    db.session.flush()
    audit.record("SETTINGS_UPDATED", "app_settings", ",".join(sorted(values))[:50], old=old, new=values)
    return list_settings()
