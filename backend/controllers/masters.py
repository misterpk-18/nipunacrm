"""Lookups, branches (details, shifts, holidays), concession limits and settings."""
import re

from flask import request

from controllers.common import Validator, created, json_body, no_content, ok
from services import branches as branches_service
from services import lookups as lookups_service
from services import settings as settings_service
from services.errors import ValidationError

CODE_PATTERN = r"[A-Z][A-Z0-9_]*"


def _require_changes(data: dict) -> dict:
    if not data:
        raise ValidationError("Provide at least one field to update")
    return data


# ---------------------------------------------------------------- lookups

def all_lookups():
    return ok(lookups_service.all_lookups())


def list_lookup(lookup_type: str):
    return ok([row.to_dict() for row in lookups_service.list_type(lookup_type)])


def create_lookup(lookup_type: str):
    extras = lookups_service.extra_fields(lookup_type)
    v = Validator(json_body())
    v.string("code", required=True, max_length=50, upper=True, pattern=CODE_PATTERN,
             pattern_message="Use capital letters, digits and underscores (e.g. GOOGLE_ADS)")
    v.string("label", required=True, max_length=100)
    v.integer("sort_order", default=0, min_value=0)
    v.boolean("is_active", default=True)
    for field in extras:
        v.boolean(field)
    return created(lookups_service.create(lookup_type, v.validate()).to_dict())


def update_lookup(lookup_type: str, row_id: int):
    extras = lookups_service.extra_fields(lookup_type)
    v = Validator(json_body())
    v.string("label", min_length=1, max_length=100)
    v.integer("sort_order", min_value=0)
    v.boolean("is_active")
    for field in extras:
        v.boolean(field)
    return ok(lookups_service.update(lookup_type, row_id, _require_changes(v.validate())).to_dict())


# ---------------------------------------------------------------- branches

def list_branches():
    return ok([b.to_dict() for b in branches_service.list_branches()])


def get_branch(branch_id: int):
    return ok(branches_service.get_branch(branch_id).to_dict())


def update_branch(branch_id: int):
    v = Validator(json_body())
    v.string("branch_name", min_length=1, max_length=100)
    v.string("city", min_length=1, max_length=100)
    v.string("address", nullable=True)
    v.string("phone", nullable=True, max_length=20)
    v.email("email", nullable=True)
    v.string("legal_name", min_length=1, max_length=150)          # invoice issuer name (db 021)
    v.string("invoice_accent", nullable=True, max_length=7)       # e.g. #6251DA
    data = _require_changes(v.validate())
    if data.get("invoice_accent") and not re.fullmatch(r"#[0-9A-Fa-f]{6}", data["invoice_accent"]):
        raise ValidationError("Invalid colour", {"invoice_accent": ["Use a hex colour like #6251DA"]})
    return ok(branches_service.update_branch(branch_id, data).to_dict())


def list_shifts(branch_id: int):
    return ok([s.to_dict() for s in branches_service.list_shifts(branch_id)])


def replace_shifts(branch_id: int):
    def shift_rules(item: Validator) -> None:
        item.integer("day_of_week", required=True, min_value=1)
        item.time("opens_at", required=True)
        item.time("closes_at", required=True)
        if item.cleaned.get("day_of_week", 1) > 7:
            item.cleaned.pop("day_of_week")
            item._error("day_of_week", "Must be 1 (Monday) to 7 (Sunday)")

    v = Validator(json_body())
    v.list_of("shifts", shift_rules, required=True)
    return ok([s.to_dict() for s in branches_service.replace_shifts(branch_id, v.validate()["shifts"])])


def list_holidays():
    v = Validator(request.args.to_dict())
    v.integer("year", min_value=2000)
    v.integer("branch_id", min_value=1)
    filters = v.validate()
    return ok([h.to_dict() for h in branches_service.list_holidays(filters.get("year"), filters.get("branch_id"))])


def create_holiday():
    v = Validator(json_body())
    v.integer("branch_id", nullable=True, default=None, min_value=1)
    v.date("holiday_date", required=True)
    v.string("name", required=True, max_length=100)
    return created(branches_service.create_holiday(v.validate()).to_dict())


def delete_holiday(holiday_id: int):
    branches_service.delete_holiday(holiday_id)
    return no_content()


# ---------------------------------------------------------------- concession limits / settings

def list_concession_limits():
    return ok([limit.to_dict() for limit in settings_service.list_concession_limits()])


def replace_concession_limits():
    def limit_rules(item: Validator) -> None:
        item.string("role_code", required=True, upper=True, max_length=50)
        item.decimal("max_percent", nullable=True, default=None, min_value=0, max_value=100)
        item.decimal("max_amount", nullable=True, default=None, min_value=0)

    v = Validator(json_body())
    v.list_of("limits", limit_rules, required=True)
    limits = settings_service.replace_concession_limits(v.validate()["limits"])
    return ok([limit.to_dict() for limit in limits])


def list_settings():
    return ok([s.to_dict() for s in settings_service.list_settings()])


def update_settings():
    values = _require_changes(json_body())
    return ok([s.to_dict() for s in settings_service.update_settings(values)])
