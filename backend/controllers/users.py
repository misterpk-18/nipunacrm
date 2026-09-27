from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated
from services import users as users_service
from services.errors import ValidationError


def _scope_rules(v: Validator) -> None:
    v.string("role_code", required=True, max_length=50)
    v.integer("branch_id", nullable=True, default=None)
    v.datetime("expires_at", nullable=True, default=None)


def list_users():
    v = Validator(request.args.to_dict())
    v.string("role")
    v.integer("branch_id")
    v.boolean("is_active")
    v.string("q")
    filters = v.validate()

    page, per_page = get_page_params()
    users, meta = users_service.list_users(filters, page, per_page)
    return paginated([u.to_dict() for u in users], meta)


def create_user():
    v = Validator(json_body())
    v.string("full_name", required=True, max_length=150)
    v.email("email", required=True)
    v.string("phone", nullable=True, default=None, max_length=20)
    v.integer("person_id", nullable=True, default=None)
    v.boolean("is_recovery_account", default=False)
    v.list_of("scopes", _scope_rules, required=True, min_items=1)
    data = v.validate()

    user, temporary_password = users_service.create_user(data)
    # The temporary password is shown once; the user must change it at first login
    return created({"user": user.to_dict(), "temporary_password": temporary_password})


def get_user(user_id: int):
    return ok(users_service.get_user(user_id).to_dict())


def update_user(user_id: int):
    v = Validator(json_body())
    v.string("full_name", required=False, min_length=1, max_length=150)
    v.email("email")
    v.string("phone", nullable=True, max_length=20)
    v.boolean("is_active")
    data = v.validate()
    if not data:
        raise ValidationError("Provide at least one field to update")

    return ok(users_service.update_user(user_id, data).to_dict())


def reset_password(user_id: int):
    user, temporary_password = users_service.reset_password(user_id)
    return ok({"user": user.to_dict(), "temporary_password": temporary_password})


def list_scopes(user_id: int):
    return ok([s.to_dict(detail=True) for s in users_service.list_scopes(user_id)])


def grant_scope(user_id: int):
    v = Validator(json_body())
    _scope_rules(v)
    return created(users_service.grant_scope(user_id, v.validate()).to_dict(detail=True))


def revoke_scope(user_id: int, scope_id: int):
    return ok(users_service.revoke_scope(user_id, scope_id).to_dict(detail=True))
