"""CRM AI sales playbook: My work today, lead workbench, outcomes, objections, stop contact, reply drafts,
knowledge, course paths, AI controls, course suggestions, recovery lists and measures."""
from flask import request

from controllers.common import Validator, created, json_body, ok, require_changes
from models.enums import (
    AI_EXECUTION_PROFILES, CONTACT_OUTCOMES, KNOWLEDGE_KINDS, LANGUAGES, OBJECTION_CATEGORIES,
    OBJECTION_STATUSES, REPLY_SITUATIONS, REVIEW_STATUSES,
)
from services import ai as ai_service
from services import knowledge as knowledge_service
from services import playbook as playbook_service
from services import recovery as recovery_service
from services.recovery import LISTS

OUTCOME_CHANNELS = ("Call", "WhatsApp", "Email", "SMS", "Meeting")
MESSAGE_CHANNELS = ("WhatsApp", "Email", "SMS")
DISPOSITIONS = ("Used", "Edited", "Ignored", "Snoozed")
PERIODS = ("Today", "Yesterday", "This Week", "Last Week", "This Month", "Last Month", "Custom")


def _need_rules(v: Validator) -> None:
    v.string("learner_goal", nullable=True)
    v.string("prior_experience", nullable=True)
    v.string("preferred_timing", nullable=True, max_length=150)
    v.string("joining_window", nullable=True, max_length=150)
    v.string("open_question", nullable=True)


def _objection_rules(v: Validator) -> None:
    v.string("learner_words", required=True)
    v.choice("category", OBJECTION_CATEGORIES, nullable=True)
    v.string("action_taken", nullable=True)


# ---------------------------------------------------------------- my work

def my_work_today():
    v = Validator(request.args.to_dict())
    v.string("owner", max_length=20)
    v.integer("branch_id", min_value=1)
    return ok(playbook_service.my_work_today(v.validate()))


def handover():
    v = Validator(request.args.to_dict())
    v.string("owner", max_length=20)
    v.integer("branch_id", min_value=1)
    return ok(playbook_service.handover(v.validate()))


def handover_note(lead_id: int):
    v = Validator(json_body())
    v.string("note", required=True)
    v.integer("cover_user_id", nullable=True, min_value=1)
    return created(playbook_service.handover_note(lead_id, v.validate()))


# ---------------------------------------------------------------- lead workbench

def workbench(lead_id: int):
    return ok(playbook_service.workbench(lead_id))


def save_outcome(lead_id: int):
    v = Validator(json_body())
    v.choice("channel", OUTCOME_CHANNELS, required=True)
    v.choice("direction", ("Inbound", "Outbound"))
    v.choice("outcome", CONTACT_OUTCOMES, required=True)
    v.string("note", nullable=True)
    v.string("next_action", nullable=True)
    v.datetime("next_action_at", nullable=True)
    v.choice("contact_state", ("Awaiting reply", "Next action missing"), nullable=True)
    v.nested("need", _need_rules, nullable=True)
    v.nested("objection", _objection_rules, nullable=True)
    v.integer("ai_action_id", nullable=True, min_value=1)
    return created(playbook_service.save_outcome(lead_id, v.validate()))


def dispose_next_action(lead_id: int):
    v = Validator(json_body())
    v.string("action_code", required=True, max_length=80)
    v.choice("status", DISPOSITIONS, required=True)
    v.string("final_text", nullable=True)
    v.string("note", nullable=True)
    v.datetime("remind_at", nullable=True)
    return created(playbook_service.dispose_next_action(lead_id, v.validate()).to_dict())


def add_objection(lead_id: int):
    v = Validator(json_body())
    _objection_rules(v)
    return created(playbook_service.add_objection(lead_id, v.validate()).to_dict())


def update_objection(objection_id: int):
    v = Validator(json_body())
    v.choice("category", OBJECTION_CATEGORIES, nullable=True)
    v.string("action_taken", nullable=True)
    v.choice("status", OBJECTION_STATUSES)
    v.string("resolution", nullable=True)
    return ok(playbook_service.update_objection(objection_id, require_changes(v.validate())).to_dict())


def objection_guide():
    return ok(playbook_service.objection_guide())


def stop_contact(person_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return ok(playbook_service.stop_contact(person_id, v.validate()["reason"]).to_dict())


def clear_stop_contact(person_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return ok(playbook_service.clear_stop_contact(person_id, v.validate()["reason"]).to_dict())


def reply_draft(lead_id: int):
    v = Validator(json_body())
    v.choice("situation", REPLY_SITUATIONS, required=True)
    v.choice("language", LANGUAGES)
    data = v.validate()
    return created(playbook_service.reply_draft(lead_id, data["situation"], data.get("language")))


def record_message(lead_id: int):
    v = Validator(json_body())
    v.choice("channel", MESSAGE_CHANNELS, required=True)
    v.string("text", required=True)
    v.integer("ai_action_id", nullable=True, min_value=1)
    return created(playbook_service.record_message(lead_id, v.validate()))


def counselling_brief(lead_id: int):
    v = Validator(json_body())
    v.choice("language", LANGUAGES)
    return created(ai_service.counselling_brief(lead_id, v.validate().get("language")).to_dict())


# ---------------------------------------------------------------- knowledge

def _knowledge_rules(v: Validator, required: bool) -> None:
    v.choice("kind", KNOWLEDGE_KINDS, required=required)
    v.string("title", required=required, max_length=200)
    v.integer("course_id", nullable=True, min_value=1)
    v.integer("branch_id", nullable=True, min_value=1)
    v.choice("situation", REPLY_SITUATIONS, nullable=True)
    v.choice("language", LANGUAGES)
    v.string("body", required=required)
    v.string("link_url", nullable=True)
    v.integer("owner_user_id", nullable=True, min_value=1)
    v.date("review_due_on", nullable=True)


def list_knowledge():
    v = Validator(request.args.to_dict())
    v.choice("kind", KNOWLEDGE_KINDS)
    v.choice("status", REVIEW_STATUSES)
    v.choice("situation", REPLY_SITUATIONS)
    v.integer("course_id", min_value=1)
    v.integer("branch_id", min_value=1)
    return ok(knowledge_service.list_knowledge(v.validate()))


def create_knowledge():
    v = Validator(json_body())
    _knowledge_rules(v, True)
    return created(knowledge_service.create_knowledge(v.validate()).to_dict())


def update_knowledge(knowledge_id: int):
    v = Validator(json_body())
    _knowledge_rules(v, False)
    return ok(knowledge_service.update_knowledge(knowledge_id, require_changes(v.validate())).to_dict())


def approve_knowledge(knowledge_id: int):
    return ok(knowledge_service.set_knowledge_status(knowledge_id, "Approved").to_dict())


def retire_knowledge(knowledge_id: int):
    return ok(knowledge_service.set_knowledge_status(knowledge_id, "Retired").to_dict())


# ---------------------------------------------------------------- course paths

def _path_rules(v: Validator, required: bool) -> None:
    v.integer("from_course_id", required=required, min_value=1)
    v.integer("to_course_id", required=required, min_value=1)
    v.string("learner_benefit", required=required)
    for field in ("helps_when", "skip_when", "prerequisites", "suggested_question"):
        v.string(field, nullable=True)


def list_paths():
    v = Validator(request.args.to_dict())
    v.choice("status", REVIEW_STATUSES)
    return ok([p.to_dict() for p in knowledge_service.list_paths(v.validate())])


def create_path():
    v = Validator(json_body())
    _path_rules(v, True)
    return created(knowledge_service.create_path(v.validate()).to_dict())


def update_path(path_id: int):
    v = Validator(json_body())
    v.string("learner_benefit")
    for field in ("helps_when", "skip_when", "prerequisites", "suggested_question"):
        v.string(field, nullable=True)
    return ok(knowledge_service.update_path(path_id, require_changes(v.validate())).to_dict())


def approve_path(path_id: int):
    return ok(knowledge_service.set_path_status(path_id, "Approved").to_dict())


def retire_path(path_id: int):
    return ok(knowledge_service.set_path_status(path_id, "Retired").to_dict())


# ---------------------------------------------------------------- AI controls

def list_controls():
    return ok([c.to_dict() for c in knowledge_service.list_controls()])


def update_control(branch_id: int):
    v = Validator(json_body())
    v.choice("execution_profile", AI_EXECUTION_PROFILES)
    v.boolean("is_paused")
    v.string("pause_reason", nullable=True)
    return ok(knowledge_service.update_control(branch_id, require_changes(v.validate())).to_dict())


# ---------------------------------------------------------------- course suggestions

def course_suggestions(person_id: int):
    return ok(knowledge_service.course_suggestions(person_id))


def dispose_course_suggestion(person_id: int):
    v = Validator(json_body())
    v.integer("course_id", required=True, min_value=1)
    v.choice("status", DISPOSITIONS, required=True)
    v.string("final_text", nullable=True)
    v.string("note", nullable=True)
    v.datetime("remind_at", nullable=True)
    return created(knowledge_service.dispose_course_suggestion(person_id, v.validate()).to_dict())


# ---------------------------------------------------------------- recovery and measures

def _list_filters(v: Validator) -> None:
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    v.integer("owner_id", min_value=1)


def recovery_lists():
    v = Validator(request.args.to_dict())
    _list_filters(v)
    return ok(recovery_service.list_counts(v.validate()))


def recovery_list(name: str):
    v = Validator({**request.args.to_dict(), "list": name})
    v.choice("list", tuple(LISTS), required=True)
    _list_filters(v)
    return ok(recovery_service.recovery_list(v.validate()))


def recovery_tasks():
    v = Validator(json_body())
    v.choice("list", tuple(LISTS), required=True)
    v.id_list("lead_ids", required=True, min_items=1)
    v.datetime("due_at", nullable=True)
    return created(recovery_service.create_tasks(v.validate()))


def measures():
    v = Validator(request.args.to_dict())
    v.choice("period", PERIODS)
    v.date("from")
    v.date("to")
    v.integer("branch_id", min_value=1)
    return ok(recovery_service.measures(v.validate()))

