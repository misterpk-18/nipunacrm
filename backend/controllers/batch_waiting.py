"""Waiting for batch: admitted students the LMS hasn't allocated yet."""
from flask import request

from controllers.common import Validator, get_page_params, paginated
from models.enums import SEAT_TYPES
from services import batch_waiting as batch_waiting_service


def list_waiting():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    v.choice("seat_type", SEAT_TYPES)
    v.string("q", max_length=100)
    page, per_page = get_page_params()
    rows, meta = batch_waiting_service.list_waiting(v.validate(), page, per_page)
    return paginated(rows, meta)
