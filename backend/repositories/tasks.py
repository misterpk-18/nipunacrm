"""Task board queries (task_board view)."""
from sqlalchemy import Select

from models import TaskBoard
from repositories.common import raw_select, text

# Equality filters on the board: request field -> fixed SQL (the value always travels as a :named parameter).
_EQUALS_FILTERS = {
    "status": "tb.status = :f_status",
    "branch_id": "tb.branch_id = :f_branch_id",
    "owner_user_id": "tb.owner_user_id = :f_owner_user_id",
}
_FLAG_FILTERS = {
    "overdue": "tb.is_overdue = :f_overdue",
    "unassigned": "tb.is_unassigned = :f_unassigned",
    "due_today": "tb.is_due_today = :f_due_today",
}
# Link filters (the tasks.<link> columns a task can point at): request field -> fixed SQL.
_LINK_FILTERS = {
    "lead_id": "t.lead_id = :link_lead_id",
    "demo_id": "t.demo_id = :link_demo_id",
    "fee_discussion_id": "t.fee_discussion_id = :link_fee_discussion_id",
    "scr_id": "t.scr_id = :link_scr_id",
    "admission_id": "t.admission_id = :link_admission_id",
    "payment_id": "t.payment_id = :link_payment_id",
    "refund_case_id": "t.refund_case_id = :link_refund_case_id",
    "document_id": "t.document_id = :link_document_id",
    "communication_id": "t.communication_id = :link_communication_id",
    "support_case_id": "t.support_case_id = :link_support_case_id",
    "enquiry_id": "t.enquiry_id = :link_enquiry_id",
    "invoice_id": "t.invoice_id = :link_invoice_id",
    "correction_request_id": "t.correction_request_id = :link_correction_request_id",
}


def board_stmt(filters: dict, user, managed_branches: set[int] | None) -> Select:
    """view=my: tasks I own. view=team: my branches' tasks — all of them for managers, otherwise mine plus
    unassigned tasks for one of my roles."""
    conditions = ["TRUE"]
    params = {}
    branch_ids = user.branch_ids()
    if branch_ids is not None:
        conditions.append("tb.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("view", "my") == "my":
        conditions.append("tb.owner_user_id = :user_id")
        params["user_id"] = user.user_id
    elif managed_branches is not None:
        conditions.append("""(
            """ + ("tb.branch_id = ANY(:managed_branches)" if managed_branches else "FALSE") + """
            OR tb.owner_user_id = :user_id
            OR (tb.owner_user_id IS NULL AND (tb.team_role_id IN (SELECT r.role_id FROM roles r
                                                                   WHERE r.role_code = ANY(:role_codes))
                                              OR tb.team_role_id IS NULL)))""")
        params["user_id"] = user.user_id
        params["role_codes"] = list(user.role_codes)
        if managed_branches:
            params["managed_branches"] = list(managed_branches)
    for field, fragment in _EQUALS_FILTERS.items():
        if filters.get(field) is not None:
            conditions.append(fragment)
            params["f_" + field] = filters[field]
    for flag, fragment in _FLAG_FILTERS.items():
        if filters.get(flag) is not None:
            conditions.append(fragment)
            params["f_" + flag] = filters[flag]
    if filters.get("open"):
        conditions.append("NOT (CAST(tb.status AS text) = ANY(:closed_statuses))")
        params["closed_statuses"] = ["Completed", "Cancelled"]
    links = [field for field in _LINK_FILTERS if filters.get(field) is not None]
    if links:
        conditions.append("tb.task_id IN (SELECT t.task_id FROM tasks t WHERE "
                          + " AND ".join(_LINK_FILTERS[field] for field in links) + ")")
        for field in links:
            params["link_" + field] = filters[field]
    if filters.get("type"):
        conditions.append("tb.task_type = (SELECT tt.label FROM task_types tt WHERE tt.code = :task_type)")
        params["task_type"] = filters["type"]
    sql = text("SELECT tb.* FROM task_board tb WHERE " + " AND ".join(conditions))
    return raw_select(TaskBoard, sql, params, "due_at, task_id")
