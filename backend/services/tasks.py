"""Tasks: system task creation used by other modules, and the Tasks screen (list, manual tasks, workflow)."""
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from config.database import db
from models import Role, Task, TaskType
from repositories import users as users_repo
from services.context import actor_id, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError


def create_system_task(
    task_type_code: str,
    title: str,
    branch_id: int,
    due_at: datetime,
    *,
    owner_user_id: int | None = None,
    team_role_code: str | None = None,
    description: str | None = None,
    dedupe_key: str | None = None,
    **link: int,
) -> Task:
    """Create a system task linked to at most one record (lead_id=..., admission_id=..., ...).

    With a dedupe_key the call is idempotent: if that task already exists it is returned unchanged.
    """
    unknown = set(link) - set(Task.LINK_FIELDS)
    if unknown:
        raise ValueError(f"Unknown task link fields: {sorted(unknown)}")
    if len(link) > 1:
        raise ValueError("A task links to at most one record")

    task_type_id = db.session.execute(
        select(TaskType.task_type_id).where(TaskType.code == task_type_code, TaskType.is_active)
    ).scalar()
    if task_type_id is None:
        raise ValueError(f"Unknown or inactive task type '{task_type_code}'")
    team_role_id = None
    if team_role_code:
        team_role_id = db.session.execute(select(Role.role_id).where(Role.role_code == team_role_code)).scalar_one()

    values = dict(
        task_type_id=task_type_id, title=title, description=description, branch_id=branch_id,
        owner_user_id=owner_user_id, team_role_id=team_role_id, source="System", dedupe_key=dedupe_key,
        original_due_at=due_at, created_by=actor_id(), **link,
    )
    if dedupe_key is None:
        task = Task(**values)
        db.session.add(task)
        db.session.flush()
        return task

    # Safe under concurrency: a second caller with the same key gets the existing task
    db.session.execute(insert(Task).values(**values).on_conflict_do_nothing(index_elements=[Task.dedupe_key]))
    return db.session.execute(select(Task).where(Task.dedupe_key == dedupe_key)).scalar_one()


def complete_system_task(dedupe_key: str) -> bool:
    """Complete an open system task (e.g. 'assign this lead' once someone assigns it). Returns True if one was closed."""
    result = db.session.execute(
        update(Task)
        .where(Task.dedupe_key == dedupe_key, Task.status.not_in(("Completed", "Cancelled")))
        .values(status="Completed")  # trigger stamps completed_at / completed_by
    )
    return result.rowcount > 0


# ---------------------------------------------------------------- Tasks screen (step 13)

def _branch_managed(user) -> set[int] | None:
    """Branches where the user manages every task; None = all (admins)."""
    if user.is_admin:
        return None
    return {s.branch_id for s in user.scopes if s.role_code == "BRANCH_MANAGER"}


def list_tasks(filters: dict, page: int, per_page: int):
    from repositories import tasks as tasks_repo
    from repositories.common import paginate

    user = current_user()
    return paginate(tasks_repo.board_stmt(filters, user, _branch_managed(user)), page, per_page)


def get_task(task_id: int) -> Task:
    task = db.session.get(Task, task_id)
    user = current_user()
    if task is None or not user.can_access_branch(task.branch_id):
        raise NotFound("Task not found")
    return task


def _workable(task_id: int) -> Task:
    task = get_task(task_id)
    user = current_user()
    team_member = task.owner_user_id is None and (task.team_role is None or task.team_role.role_code in user.role_codes)
    if not (user.is_manager_of(task.branch_id) or task.owner_user_id == user.user_id
            or task.created_by == user.user_id or team_member):
        raise Forbidden("Only the task owner, its team or a branch manager can change this task")
    return task


def _check_owner(owner_id: int, branch_id: int) -> None:
    from services.context import STAFF_ROLES

    if owner_id not in users_repo.user_ids_with_any_role(STAFF_ROLES, branch_id):
        raise ValidationError("Owner must be active staff at the task's branch", {"owner_user_id": ["Not staff here"]})


LINK_MODELS = {"lead_id": "Lead", "demo_id": "Demo", "fee_discussion_id": "FeeDiscussion", "scr_id": "SpecialClosingRequest",
               "admission_id": "Admission", "payment_id": "Payment", "refund_case_id": "RefundCase",
               "document_id": "Document", "communication_id": "Communication", "support_case_id": "SupportCase",
               "enquiry_id": "Enquiry", "invoice_id": "Invoice", "correction_request_id": "PaymentCorrectionRequest"}


def create_manual_task(data: dict) -> Task:
    import models

    user = current_user()
    if not user.can_access_branch(data["branch_id"]):
        raise Forbidden("You can only create tasks at your own branches")
    task_type = db.session.get(TaskType, data["task_type_id"])
    if task_type is None or not task_type.is_active:
        raise ValidationError("Unknown task type", {"task_type_id": ["Not an active type"]})
    if data.get("owner_user_id"):
        _check_owner(data["owner_user_id"], data["branch_id"])
    link = data.get("link") or {}
    if len(link) > 1:
        raise ValidationError("A task links to at most one record", {"link": ["Only one"]})
    for field, record_id in link.items():
        if db.session.get(getattr(models, LINK_MODELS[field]), record_id) is None:
            raise ValidationError("The linked record doesn't exist", {"link": [f"{field} {record_id} not found"]})
    task = Task(task_type_id=task_type.task_type_id, title=data["title"], description=data.get("description"),
                branch_id=data["branch_id"], owner_user_id=data.get("owner_user_id"), source="Manual",
                original_due_at=data["due_at"], created_by=user.user_id, **link)
    db.session.add(task)
    db.session.flush()
    return task


def update_task(task_id: int, data: dict) -> Task:
    """Title, description, owner. Reassigning a task never changes the lead's or admission's owner."""
    task = _workable(task_id)
    if not task.is_open:
        raise BusinessRule(f"Task is {task.status}")
    if data.get("owner_user_id"):
        _check_owner(data["owner_user_id"], task.branch_id)
    for field, value in data.items():
        setattr(task, field, value)
    db.session.flush()
    db.session.refresh(task)
    return task


def transition(task_id: int, action: str, reason: str | None = None) -> Task:
    task = _workable(task_id)
    if not task.is_open:
        raise BusinessRule(f"Task is already {task.status}")
    if action == "start":
        task.status, task.blocked_reason = "In Progress", None
        if task.owner_user_id is None:
            task.owner_user_id = current_user().user_id  # starting an unassigned task takes it
    elif action == "block":
        task.status, task.blocked_reason = "Waiting/Blocked", reason
    elif action == "complete":
        task.status = "Completed"  # completed_at / completed_by stamped by the DB
    elif action == "cancel":
        task.status, task.cancel_reason = "Cancelled", reason
    db.session.flush()
    db.session.refresh(task)
    return task


def revise_deadline(task_id: int, due_at: datetime, reason: str) -> Task:
    task = _workable(task_id)
    if not task.is_open:
        raise BusinessRule(f"Task is {task.status}")
    task.revised_due_at = due_at  # the original deadline is never changed
    task.revision_reason = reason
    db.session.flush()
    return task
