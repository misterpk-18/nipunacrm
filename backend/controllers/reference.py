from flask import request

from controllers.common import Validator, ok
from services import reference as reference_service


def list_roles():
    return ok([r.to_dict() for r in reference_service.list_roles()])


def list_staff():
    v = Validator({k: request.args[k] for k in ("branch_id",) if k in request.args})
    v.integer("branch_id", min_value=1)
    branch_id = v.validate().get("branch_id")
    roles = [code.strip().upper() for value in request.args.getlist("role") for code in value.split(",") if code.strip()]
    return ok(reference_service.list_staff(branch_id, roles or None))
