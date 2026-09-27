"""Tasks (#10), Communications (#11), Notifications, Placement & Alumni (#13)."""
from flask import Blueprint

from controllers import communications as comms_controller
from controllers import placement as placement_controller
from controllers import tasks as tasks_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES, LEAD_ROLES, STAFF_ROLES

operations_bp = Blueprint("operations", __name__)
PLACEMENT_ROLES = ADMIN_ROLES + ("PLACEMENT", "BRANCH_MANAGER")


def route(rule: str, method: str, roles=None, fresh=False, endpoint=None):
    def decorator(view):
        wrapped = fresh_auth(view) if fresh else view
        if roles:
            wrapped = require_roles(*roles)(wrapped)
        return getattr(operations_bp, method)(rule, endpoint=endpoint)(login_required(wrapped))
    return decorator


# ---------------------------------------------------------------- tasks

@route("/tasks", "get", STAFF_ROLES)
def list_tasks():
    return tasks_controller.list_tasks()


@route("/tasks", "post", STAFF_ROLES)
def create_task():
    return tasks_controller.create_task()


@route("/tasks/<int:task_id>", "get", STAFF_ROLES)
def get_task(task_id: int):
    return tasks_controller.get_task(task_id)


@route("/tasks/<int:task_id>", "patch", STAFF_ROLES)
def update_task(task_id: int):
    return tasks_controller.update_task(task_id)


@route("/tasks/<int:task_id>/<any(start, block, complete, cancel):action>", "post", STAFF_ROLES)
def transition_task(task_id: int, action: str):
    return tasks_controller.transition(task_id, action)


@route("/tasks/<int:task_id>/revise-deadline", "post", STAFF_ROLES)
def revise_deadline(task_id: int):
    return tasks_controller.revise_deadline(task_id)


# ---------------------------------------------------------------- communications

@route("/communications", "get", LEAD_ROLES)
def list_communications():
    return comms_controller.list_communications()


@route("/communications", "post", LEAD_ROLES)
def record_communication():
    return comms_controller.record_communication()


@route("/communications/<int:communication_id>/reply", "post", LEAD_ROLES)
def reply_communication(communication_id: int):
    return comms_controller.reply(communication_id)


@route("/communications/<int:communication_id>/retry", "post", LEAD_ROLES)
def retry_communication(communication_id: int):
    return comms_controller.retry(communication_id)


@route("/communications/<int:communication_id>/match", "post", LEAD_ROLES)
def match_communication(communication_id: int):
    return comms_controller.match(communication_id)


@route("/branch-channels", "get", ADMIN_ROLES)
def list_channels():
    return comms_controller.list_channels()


@route("/branch-channels", "post", ADMIN_ROLES)
def create_channel():
    return comms_controller.create_channel()


@route("/branch-channels/<int:channel_id>", "patch", ADMIN_ROLES)
def update_channel(channel_id: int):
    return comms_controller.update_channel(channel_id)


# ---------------------------------------------------------------- notifications

@route("/notifications", "get")
def list_notifications():
    return comms_controller.list_notifications()


@route("/notifications/<int:notification_id>/<any(read, acknowledge, complete):action>", "post")
def mark_notification(notification_id: int, action: str):
    return comms_controller.mark_notification(notification_id, action)


@route("/notification-rules", "get", ADMIN_ROLES)
def list_rules():
    return comms_controller.list_rules()


@route("/notification-rules/<int:rule_id>", "patch", ADMIN_ROLES)
def update_rule(rule_id: int):
    return comms_controller.update_rule(rule_id)


# ---------------------------------------------------------------- placement & alumni

@route("/companies", "get", PLACEMENT_ROLES)
def list_companies():
    return placement_controller.list_companies()


@route("/companies", "post", PLACEMENT_ROLES)
def create_company():
    return placement_controller.save_company()


@route("/companies/<int:company_id>", "patch", PLACEMENT_ROLES)
def update_company(company_id: int):
    return placement_controller.save_company(company_id)


@route("/job-openings", "get", PLACEMENT_ROLES)
def list_jobs():
    return placement_controller.list_jobs()


@route("/job-openings", "post", PLACEMENT_ROLES)
def create_job():
    return placement_controller.save_job()


@route("/job-openings/<int:job_id>", "patch", PLACEMENT_ROLES)
def update_job(job_id: int):
    return placement_controller.save_job(job_id)


@route("/persons/<int:person_id>/placement-profile", "get", PLACEMENT_ROLES)
def get_profile(person_id: int):
    return placement_controller.get_profile(person_id)


@route("/persons/<int:person_id>/placement-profile", "put", PLACEMENT_ROLES)
def save_profile(person_id: int):
    return placement_controller.save_profile(person_id)


@route("/placement-profiles/<int:profile_id>/consent", "post", PLACEMENT_ROLES)
def record_consent(profile_id: int):
    return placement_controller.record_consent(profile_id)


@route("/job-applications", "get", PLACEMENT_ROLES)
def list_applications():
    return placement_controller.list_applications()


@route("/job-applications", "post", PLACEMENT_ROLES)
def apply():
    return placement_controller.apply()


@route("/job-applications/<int:application_id>/stage", "post", PLACEMENT_ROLES)
def change_application_stage(application_id: int):
    return placement_controller.change_stage(application_id)


@route("/job-applications/<int:application_id>/events", "post", PLACEMENT_ROLES)
def add_application_event(application_id: int):
    return placement_controller.add_event(application_id)


@route("/alumni", "get", PLACEMENT_ROLES + ("ACADEMIC_COORDINATOR",))
def list_alumni():
    return placement_controller.list_alumni()


@route("/admissions/<int:admission_id>/support-extensions", "post", ADMIN_ROLES, fresh=True)
def extend_support(admission_id: int):
    return placement_controller.extend_support(admission_id)
