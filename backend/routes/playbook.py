"""CRM AI sales playbook (v2.0): Front Office work queue, lead workbench, contact rules, approved knowledge, course
paths, AI controls, recovery lists and measures. Finer checks (owner, cover, branch manager) are in the services."""
from flask import Blueprint

from controllers import playbook as playbook_controller
from routes.decorators import login_required, require_roles
from services.context import ACADEMIC_ROLES, LEAD_ROLES, MANAGER_ROLES

playbook_bp = Blueprint("playbook", __name__)
PATH_ROLES = tuple(dict.fromkeys(ACADEMIC_ROLES + LEAD_ROLES))


def route(rule: str, method: str, *roles: str):
    def decorator(view):
        return getattr(playbook_bp, method)(rule)(login_required(require_roles(*(roles or LEAD_ROLES))(view)))
    return decorator


# ---------------------------------------------------------------- my work

@route("/my-work/today", "get")
def my_work_today():
    return playbook_controller.my_work_today()


@route("/my-work/handover", "get")
def handover():
    return playbook_controller.handover()


@route("/leads/<int:lead_id>/handover-note", "post")
def handover_note(lead_id: int):
    return playbook_controller.handover_note(lead_id)


# ---------------------------------------------------------------- lead workbench

@route("/leads/<int:lead_id>/workbench", "get", *LEAD_ROLES, "ACCOUNTS")  # read-only Lead 360
def workbench(lead_id: int):
    return playbook_controller.workbench(lead_id)


@route("/leads/<int:lead_id>/outcome", "post")
def save_outcome(lead_id: int):
    return playbook_controller.save_outcome(lead_id)


@route("/leads/<int:lead_id>/next-action/disposition", "post")
def dispose_next_action(lead_id: int):
    return playbook_controller.dispose_next_action(lead_id)


@route("/leads/<int:lead_id>/objections", "post")
def add_objection(lead_id: int):
    return playbook_controller.add_objection(lead_id)


@route("/objections/<int:objection_id>", "patch")
def update_objection(objection_id: int):
    return playbook_controller.update_objection(objection_id)


@route("/objections/guide", "get")
def objection_guide():
    return playbook_controller.objection_guide()


@route("/persons/<int:person_id>/stop-contact", "post")
def stop_contact(person_id: int):
    return playbook_controller.stop_contact(person_id)


@route("/persons/<int:person_id>/stop-contact/clear", "post", *MANAGER_ROLES)
def clear_stop_contact(person_id: int):
    return playbook_controller.clear_stop_contact(person_id)


@route("/leads/<int:lead_id>/reply-draft", "post")
def reply_draft(lead_id: int):
    return playbook_controller.reply_draft(lead_id)


@route("/leads/<int:lead_id>/messages", "post")
def record_message(lead_id: int):
    return playbook_controller.record_message(lead_id)


@route("/leads/<int:lead_id>/ai/counselling-brief", "post")
def counselling_brief(lead_id: int):
    return playbook_controller.counselling_brief(lead_id)


# ---------------------------------------------------------------- knowledge and templates

@route("/sales-knowledge", "get")
def list_knowledge():
    return playbook_controller.list_knowledge()


@route("/sales-knowledge", "post", *MANAGER_ROLES)
def create_knowledge():
    return playbook_controller.create_knowledge()


@route("/sales-knowledge/<int:knowledge_id>", "patch", *MANAGER_ROLES)
def update_knowledge(knowledge_id: int):
    return playbook_controller.update_knowledge(knowledge_id)


@route("/sales-knowledge/<int:knowledge_id>/approve", "post", *MANAGER_ROLES)
def approve_knowledge(knowledge_id: int):
    return playbook_controller.approve_knowledge(knowledge_id)


@route("/sales-knowledge/<int:knowledge_id>/retire", "post", *MANAGER_ROLES)
def retire_knowledge(knowledge_id: int):
    return playbook_controller.retire_knowledge(knowledge_id)


# ---------------------------------------------------------------- course paths

@route("/course-paths", "get", *PATH_ROLES)
def list_paths():
    return playbook_controller.list_paths()


@route("/course-paths", "post", *ACADEMIC_ROLES)
def create_path():
    return playbook_controller.create_path()


@route("/course-paths/<int:path_id>", "patch", *ACADEMIC_ROLES)
def update_path(path_id: int):
    return playbook_controller.update_path(path_id)


@route("/course-paths/<int:path_id>/approve", "post", *ACADEMIC_ROLES)
def approve_path(path_id: int):
    return playbook_controller.approve_path(path_id)


@route("/course-paths/<int:path_id>/retire", "post", *ACADEMIC_ROLES)
def retire_path(path_id: int):
    return playbook_controller.retire_path(path_id)


# ---------------------------------------------------------------- AI controls

@route("/ai/controls", "get", *MANAGER_ROLES)
def list_controls():
    return playbook_controller.list_controls()


@route("/ai/controls/<int:branch_id>", "patch", *MANAGER_ROLES)
def update_control(branch_id: int):
    return playbook_controller.update_control(branch_id)


# ---------------------------------------------------------------- course suggestions

@route("/persons/<int:person_id>/course-suggestions", "get")
def course_suggestions(person_id: int):
    return playbook_controller.course_suggestions(person_id)


@route("/persons/<int:person_id>/course-suggestions/disposition", "post")
def dispose_course_suggestion(person_id: int):
    return playbook_controller.dispose_course_suggestion(person_id)


# ---------------------------------------------------------------- recovery and measures

@route("/recovery-lists", "get")
def recovery_lists():
    return playbook_controller.recovery_lists()


@route("/recovery-lists/<string:name>", "get")
def recovery_list(name: str):
    return playbook_controller.recovery_list(name)


@route("/recovery-lists/tasks", "post", *MANAGER_ROLES)
def recovery_tasks():
    return playbook_controller.recovery_tasks()


@route("/reports/sales-playbook", "get", *MANAGER_ROLES)
def measures():
    return playbook_controller.measures()
