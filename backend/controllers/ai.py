"""AI Copilot and Ask Nipuna. Every output is advisory and marked for human review."""
from flask import request

from controllers.common import Validator, created, json_body, ok
from models.enums import AI_FEEDBACK_RATINGS, LANGUAGES
from services import ai as ai_service
from services import reports as reports_service


def lead_brief(lead_id: int):
    v = Validator(json_body())
    v.choice("language", LANGUAGES)
    brief, why = ai_service.lead_brief(lead_id, v.validate().get("language"))
    return created({"brief": brief.to_dict(), "priority_explanation": why.to_dict()})


def lead_insights(lead_id: int):
    return ok([i.to_dict() for i in ai_service.lead_insights(lead_id)])


def next_best_action():
    v = Validator(json_body())
    v.integer("limit", default=10, min_value=1, max_value=25)
    return created([i.to_dict() for i in ai_service.next_best_actions(v.validate()["limit"])])


def _scope_rules(v: Validator) -> None:
    v.choice("period", reports_service.PERIODS, default="This Month")
    v.date("from")
    v.date("to")
    v.integer("branch_id", min_value=1)


def ask():
    v = Validator(json_body())
    v.string("question", required=True, max_length=2000)
    v.choice("language", LANGUAGES, default="English")
    _scope_rules(v)
    return created(ai_service.ask(v.validate()).to_dict())


def feedback():
    v = Validator(json_body())
    v.integer("insight_id", min_value=1)
    v.integer("query_id", min_value=1)
    v.choice("rating", AI_FEEDBACK_RATINGS, required=True)
    v.string("comment", nullable=True)
    return created(ai_service.feedback(v.validate()).to_dict())


def management_brief():
    v = Validator(request.args.to_dict())
    _scope_rules(v)
    return ok(ai_service.management_brief(v.validate()).to_dict())
