"""Task board queries (task_board view)."""
from sqlalchemy import Select, false, or_, select

from models import Role, Task, TaskBoard, TaskType


def board_stmt(filters: dict, user, managed_branches: set[int] | None) -> Select:
    """view=my: tasks I own. view=team: my branches' tasks — all of them for managers, otherwise mine plus
    unassigned tasks for one of my roles."""
    stmt = select(TaskBoard).order_by(TaskBoard.due_at, TaskBoard.task_id)
    branch_ids = user.branch_ids()
    if branch_ids is not None:
        stmt = stmt.where(TaskBoard.branch_id.in_(branch_ids))
    if filters.get("view", "my") == "my":
        stmt = stmt.where(TaskBoard.owner_user_id == user.user_id)
    elif managed_branches is not None:
        my_roles = select(Role.role_id).where(Role.role_code.in_(user.role_codes))
        stmt = stmt.where(or_(
            TaskBoard.branch_id.in_(managed_branches) if managed_branches else false(),
            TaskBoard.owner_user_id == user.user_id,
            (TaskBoard.owner_user_id.is_(None)) & (TaskBoard.team_role_id.in_(my_roles) | TaskBoard.team_role_id.is_(None)),
        ))
    for field, column in (("status", TaskBoard.status), ("branch_id", TaskBoard.branch_id),
                          ("owner_user_id", TaskBoard.owner_user_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    for flag, column in (("overdue", TaskBoard.is_overdue), ("unassigned", TaskBoard.is_unassigned),
                         ("due_today", TaskBoard.is_due_today)):
        if filters.get(flag) is not None:
            stmt = stmt.where(column == filters[flag])
    if filters.get("open"):
        stmt = stmt.where(TaskBoard.status.not_in(("Completed", "Cancelled")))
    links = {field: filters[field] for field in Task.LINK_FIELDS if filters.get(field) is not None}
    if links:
        linked = select(Task.task_id).where(*(getattr(Task, field) == value for field, value in links.items()))
        stmt = stmt.where(TaskBoard.task_id.in_(linked))
    if filters.get("type"):
        stmt = stmt.where(TaskBoard.task_type == select(TaskType.label).where(TaskType.code == filters["type"])
                          .scalar_subquery())
    return stmt
