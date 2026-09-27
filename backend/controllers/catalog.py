"""Course Master, payment plans and Offer Master."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated
from models.enums import COURSE_STATUSES, OFFER_BENEFIT_TYPES, OFFER_STATUSES
from services import courses as courses_service
from services import offers as offers_service
from services import payment_plans as plans_service
from services.context import current_user
from services.errors import ValidationError


def _require_changes(data: dict) -> dict:
    if not data:
        raise ValidationError("Provide at least one field to update")
    return data


# ---------------------------------------------------------------- courses

def list_courses():
    v = Validator(request.args.to_dict())
    v.choice("type", ("standalone", "combo"))
    v.choice("status", COURSE_STATUSES)
    v.string("category", max_length=100)
    v.integer("branch_id", min_value=1)
    v.string("q", max_length=100)
    filters = v.validate()
    page, per_page = get_page_params()
    courses, meta = courses_service.list_courses(filters, page, per_page)
    return paginated([c.to_dict() for c in courses], meta)


def get_course(course_id: int):
    return ok(courses_service.get_course(course_id).to_dict())


def create_course():
    v = Validator(json_body())
    v.string("course_code", required=True, max_length=20, upper=True, pattern=r"[A-Z0-9][A-Z0-9-]*",
             pattern_message="Use capital letters, digits and dashes (e.g. NIT-CRS-018)")
    v.string("course_title", required=True, max_length=255)
    v.string("category", required=True, max_length=100)
    v.decimal("standard_fee", required=True, min_value=0)
    v.boolean("is_combo", default=False)
    v.choice("status", COURSE_STATUSES, default="Active")
    v.id_list("branch_ids")
    return created(courses_service.create_course(v.validate()).to_dict())


def update_course(course_id: int):
    v = Validator(json_body())
    v.string("course_title", min_length=1, max_length=255)
    v.string("category", min_length=1, max_length=100)
    v.decimal("standard_fee", min_value=0)
    v.choice("status", COURSE_STATUSES)
    return ok(courses_service.update_course(course_id, _require_changes(v.validate())).to_dict())


def set_course_branches(course_id: int):
    v = Validator(json_body())
    v.id_list("branch_ids", required=True)
    return ok(courses_service.set_branches(course_id, v.validate()["branch_ids"]).to_dict())


def set_combo_components(course_id: int):
    def component_rules(item: Validator) -> None:
        item.integer("course_id", required=True, min_value=1)
        item.boolean("is_bonus", default=False)
        item.integer("sort_order", min_value=0)

    v = Validator(json_body())
    v.list_of("components", component_rules, required=True, min_items=1)
    return ok(courses_service.set_components(course_id, v.validate()["components"]).to_dict())


# ---------------------------------------------------------------- payment plans

def _installment_rules(item: Validator) -> None:
    item.decimal("percent_of_fee", required=True, min_value=0.01, max_value=100)
    item.integer("due_days_after_admission", default=0, min_value=0)
    item.integer("due_days_min", min_value=0)
    item.integer("due_days_max", min_value=0)


def list_payment_plans():
    v = Validator(request.args.to_dict())
    v.boolean("include_inactive", default=False)
    include_inactive = v.validate()["include_inactive"] and current_user().is_admin
    return ok([p.to_dict() for p in plans_service.list_plans(include_inactive)])


def get_payment_plan(plan_id: int):
    return ok(plans_service.get_plan(plan_id).to_dict())


def create_payment_plan():
    v = Validator(json_body())
    v.string("plan_code", required=True, max_length=30, upper=True, pattern=r"[A-Z][A-Z0-9_]*",
             pattern_message="Use capital letters, digits and underscores (e.g. TWO_INSTALMENTS)")
    v.string("plan_name", required=True, max_length=100)
    v.string("description", nullable=True, default=None)
    v.list_of("installments", _installment_rules, required=True, min_items=1)
    return created(plans_service.create_plan(v.validate()).to_dict())


def update_payment_plan(plan_id: int):
    v = Validator(json_body())
    v.string("plan_name", min_length=1, max_length=100)
    v.string("description", nullable=True)
    v.boolean("is_active")
    v.list_of("installments", _installment_rules, min_items=1)
    return ok(plans_service.update_plan(plan_id, _require_changes(v.validate())).to_dict())


# ---------------------------------------------------------------- offers

def _offer_fields(v: Validator, creating: bool) -> None:
    v.string("offer_name", required=creating, min_length=1, max_length=150)
    v.string("description", nullable=True)
    v.choice("benefit_type", OFFER_BENEFIT_TYPES, required=creating)
    v.decimal("discount_amount", nullable=True, min_value=0.01)
    v.decimal("discount_percent", nullable=True, min_value=0.01, max_value=100)
    v.boolean("allows_stacking")
    v.string("qualifying_payment_rule", nullable=True, max_length=255)
    v.date("valid_from", nullable=True)
    v.date("valid_to", nullable=True)
    v.choice("status", ("Draft", "Configured"))  # activation has its own endpoint


def _scope_fields(v: Validator) -> None:
    v.boolean("applies_to_all_branches")
    v.id_list("branch_ids")
    v.boolean("applies_to_all_courses")
    v.id_list("course_ids")


def _complimentary_rules(item: Validator) -> None:
    item.integer("course_id", required=True, min_value=1)
    item.decimal("min_final_fee", default=0, min_value=0)
    item.integer("access_period_days", nullable=True, min_value=1)


def list_offers():
    v = Validator(request.args.to_dict())
    v.choice("status", OFFER_STATUSES)
    v.string("offer_code", upper=True, max_length=30)
    return ok([o.to_dict() for o in offers_service.list_offers(v.validate())])


def get_offer(offer_id: int):
    return ok(offers_service.get_offer(offer_id).to_dict())


def create_offer():
    v = Validator(json_body())
    v.string("offer_code", required=True, max_length=30, upper=True, pattern=r"[A-Z0-9][A-Z0-9-]*",
             pattern_message="Use capital letters, digits and dashes (e.g. OM-2026-10)")
    _offer_fields(v, creating=True)
    _scope_fields(v)
    v.list_of("complimentary_courses", _complimentary_rules)
    return created(offers_service.create_offer(v.validate()).to_dict())


def update_offer(offer_id: int):
    v = Validator(json_body())
    _offer_fields(v, creating=False)
    return ok(offers_service.update_offer(offer_id, _require_changes(v.validate())).to_dict())


def new_offer_version(offer_id: int):
    return created(offers_service.new_version(offer_id).to_dict())


def activate_offer(offer_id: int):
    return ok(offers_service.activate(offer_id).to_dict())


def deactivate_offer(offer_id: int):
    return ok(offers_service.deactivate(offer_id).to_dict())


def set_offer_scope(offer_id: int):
    v = Validator(json_body())
    _scope_fields(v)
    return ok(offers_service.set_scope(offer_id, _require_changes(v.validate())).to_dict())


def set_offer_complimentary(offer_id: int):
    v = Validator(json_body())
    v.list_of("courses", _complimentary_rules, required=True)
    return ok(offers_service.set_complimentary(offer_id, v.validate()["courses"]).to_dict())
