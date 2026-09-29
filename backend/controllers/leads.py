"""Persons, enquiries, leads and lead activities."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, no_content, ok, paginated
from models.enums import (
    ACTIVITY_DIRECTIONS, INTAKE_STATUSES, LANGUAGES, LEAD_PRIORITIES, LEAD_STAGES, LEAD_STATUSES, QUALIFICATION_CHECKS,
)
from repositories.leads import QUEUES
from services import enquiries as enquiries_service
from services import lead_imports as imports_service
from services import leads as leads_service
from services import persons as persons_service
from services import qualification as qualification_service
from services import saved_views as saved_views_service
from services.context import current_user
from services.errors import ValidationError

# Intake statuses staff can set by hand (Duplicate Review is set by matching)
MANUAL_INTAKE = ("New", "Incomplete", "Outreach Prospect", "Invalid-Spam", "Test")
FOLLOW_UP_PURPOSES = ("Counselling call", "Demo confirmation", "Post-demo follow-up", "Fee follow-up",
                      "Collection follow-up", "Document follow-up")
FOLLOW_UP_RESPONSES = ("Interested", "Call back later", "Not reachable", "Needs time", "Not interested")
REACTIVATE_STAGES = ("New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited")


def _require_changes(data: dict) -> dict:
    if not data:
        raise ValidationError("Provide at least one field to update")
    return data


def _person_rules(v: Validator, creating: bool = True) -> None:
    v.string("full_name", required=creating, min_length=1, max_length=150)
    v.phone("phone", required=creating)
    v.phone("alternate_phone", nullable=True)
    v.phone("whatsapp_number", nullable=True)  # empty = same as mobile
    v.email("email", nullable=True)
    v.string("city", nullable=True, max_length=100)
    v.string("highest_qualification", nullable=True, max_length=100)
    v.choice("preferred_language", LANGUAGES)


def _clean_person(data: dict) -> dict:
    if data.get("whatsapp_number") == "":
        data["whatsapp_number"] = None
    return data


def _person_with_leads(person, open_leads) -> dict:
    return {**person.to_dict(), "open_leads": [lead.to_summary() for lead in open_leads]}


# ---------------------------------------------------------------- persons

def search_persons():
    v = Validator(request.args.to_dict())
    v.phone("phone")
    v.email("email")
    v.string("name", max_length=150)
    params = v.validate()
    results = persons_service.search(params.get("phone"), params.get("email"), params.get("name"))
    return ok([_person_with_leads(person, leads) for person, leads in results])


def list_persons():
    v = Validator(request.args.to_dict())
    v.string("q", max_length=100)
    v.integer("branch_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = persons_service.list_persons(v.validate(), page, per_page)
    return paginated(rows, meta)


def person_overview(person_id: int):
    return ok(persons_service.overview(person_id))


def create_person():
    v = Validator(json_body())
    _person_rules(v)
    v.integer("registered_branch_id", required=True, min_value=1)
    return created(persons_service.create_person(_clean_person(v.validate())).to_dict())


def get_person(person_id: int):
    return ok(persons_service.get_person(person_id).to_dict())


def update_person(person_id: int):
    v = Validator(json_body())
    _person_rules(v, creating=False)
    return ok(persons_service.update_person(person_id, _require_changes(_clean_person(v.validate()))).to_dict())


# ---------------------------------------------------------------- enquiries

def create_enquiry():
    v = Validator(json_body())
    v.integer("branch_id", required=True, min_value=1)
    v.integer("course_id", nullable=True, min_value=1)
    v.integer("lead_source_id", required=True, min_value=1)
    v.integer("contact_channel_id", required=True, min_value=1)
    v.integer("entry_method_id", required=True, min_value=1)
    v.choice("intake_status", MANUAL_INTAKE, default="New")
    v.boolean("is_genuine")
    v.integer("owner_user_id", nullable=True, min_value=1)
    v.string("raw_name", nullable=True, max_length=150)
    v.phone("raw_phone", nullable=True)
    v.email("raw_email", nullable=True)
    v.string("message", nullable=True)
    data = v.validate()
    if not (data.get("raw_phone") or data.get("raw_email")):
        raise ValidationError("An enquiry needs a phone or an email", {"raw_phone": ["Phone or email required"]})

    enquiry, persons, open_leads = enquiries_service.create_enquiry(data)
    return created({
        "enquiry": enquiry.to_dict(),
        "matches": {"persons": [p.to_summary() for p in persons], "open_leads": [lead.to_summary() for lead in open_leads]},
    })


def list_enquiries():
    v = Validator(request.args.to_dict())
    v.choice("intake_status", INTAKE_STATUSES)
    v.integer("branch_id", min_value=1)
    v.boolean("linked")
    v.string("q", max_length=100)
    filters = v.validate()
    page, per_page = get_page_params()
    enquiries, meta = enquiries_service.list_enquiries(filters, page, per_page)
    return paginated([e.to_dict() for e in enquiries], meta)


def get_enquiry(enquiry_id: int):
    return ok(enquiries_service.get_enquiry(enquiry_id).to_dict())


def link_enquiry(enquiry_id: int):
    v = Validator(json_body())
    v.integer("lead_id", required=True, min_value=1)
    return ok(enquiries_service.link_to_lead(enquiry_id, v.validate()["lead_id"]).to_dict())


def convert_enquiry(enquiry_id: int):
    v = Validator(json_body())
    v.integer("person_id", nullable=True, min_value=1)
    v.nested("person", _person_rules, nullable=True)
    v.integer("course_id", nullable=True, min_value=1)
    v.integer("assigned_to", nullable=True, min_value=1)
    v.datetime("next_follow_up_at", nullable=True)
    v.choice("intake_status", MANUAL_INTAKE)
    return created(enquiries_service.convert_to_lead(enquiry_id, v.validate()).to_dict())


# ---------------------------------------------------------------- leads

def create_lead():
    v = Validator(json_body())
    v.integer("person_id", nullable=True, min_value=1)
    v.nested("person", _person_rules, nullable=True)
    v.integer("branch_id", required=True, min_value=1)
    v.integer("course_id", nullable=True, min_value=1)
    v.integer("lead_source_id", required=True, min_value=1)
    v.integer("contact_channel_id", required=True, min_value=1)
    v.integer("entry_method_id", required=True, min_value=1)
    v.integer("assigned_to", nullable=True, min_value=1)
    v.datetime("next_follow_up_at", nullable=True)
    v.choice("intake_status", MANUAL_INTAKE)
    v.string("campaign", nullable=True, max_length=150)
    v.string("remarks", nullable=True)
    v.string("message", nullable=True)
    data = v.validate()
    if data.get("person"):
        _clean_person(data["person"])
    return created(leads_service.create_lead(data).to_dict())


def list_leads():
    args = request.args.to_dict()
    assigned = args.pop("assigned_to", None)
    v = Validator(args)
    v.integer("branch_id", min_value=1)
    v.choice("stage", LEAD_STAGES)
    v.integer("course_id", min_value=1)
    v.integer("source_id", min_value=1)
    v.choice("intake_status", INTAKE_STATUSES)
    v.choice("priority", LEAD_PRIORITIES)
    v.choice("queue", tuple(QUEUES))
    v.string("q", max_length=100)
    # Leads = Active enquiries (New Enquiry) by default; a stage or queue filter searches all of them
    v.choice("lead_status", LEAD_STATUSES + ("All",),
             default="All" if args.get("stage") or args.get("queue") else "Active")
    filters = v.validate()
    if filters["lead_status"] == "All":
        del filters["lead_status"]

    if assigned == "me":
        filters["assigned_to"] = current_user().user_id
    elif assigned == "unassigned":
        filters["assigned_to"] = None
    elif assigned is not None:
        owner = Validator({"assigned_to": assigned})
        owner.integer("assigned_to", min_value=1)
        filters.update(owner.validate())

    page, per_page = get_page_params()
    leads, meta = leads_service.list_leads(filters, page, per_page)
    return paginated([lead.to_row() for lead in leads], meta)


def workspace():
    page, per_page = get_page_params()
    leads, meta, counts = leads_service.workspace(page, per_page)
    return ok({"counts": counts, "leads": [lead.to_row() for lead in leads]}, meta=meta)


def get_lead(lead_id: int):
    return ok(leads_service.get_lead(lead_id).to_dict())


def update_lead(lead_id: int):
    v = Validator(json_body())
    v.integer("course_id", nullable=True, min_value=1)
    v.choice("intake_status", MANUAL_INTAKE)
    v.string("campaign", nullable=True, max_length=150)
    v.string("remarks", nullable=True)
    return ok(leads_service.update_lead(lead_id, _require_changes(v.validate())).to_dict())


def assign_lead(lead_id: int):
    v = Validator(json_body())
    v.integer("assigned_to", required=True, min_value=1)
    return ok(leads_service.assign(lead_id, v.validate()["assigned_to"]).to_dict())


def bulk_assign():
    v = Validator(json_body())
    v.id_list("lead_ids", required=True, min_items=1)
    v.integer("assigned_to", required=True, min_value=1)
    data = v.validate()
    leads = leads_service.bulk_assign(data["lead_ids"], data["assigned_to"])
    return ok([lead.to_row() for lead in leads])


def change_stage(lead_id: int):
    v = Validator(json_body())
    v.choice("stage", LEAD_STAGES, required=True)
    v.string("note", nullable=True)
    data = v.validate()
    return ok(leads_service.change_stage(lead_id, data["stage"], data.get("note")).to_dict())


def schedule_follow_up(lead_id: int):
    v = Validator(json_body())
    v.datetime("next_follow_up_at", required=True)
    v.string("note", nullable=True)
    data = v.validate()
    return ok(leads_service.schedule_follow_up(lead_id, data["next_follow_up_at"], data.get("note")).to_dict())


def log_follow_up(lead_id: int):
    v = Validator(json_body())
    v.choice("purpose", FOLLOW_UP_PURPOSES, required=True)
    v.choice("response", FOLLOW_UP_RESPONSES, required=True)
    v.string("notes", nullable=True)
    v.datetime("next_follow_up_at", required=True)
    lead, activity, task = leads_service.log_follow_up(lead_id, v.validate())
    return created({"lead": lead.to_dict(), "activity": activity.to_dict(), "task": task.to_dict()})


def mark_lost(lead_id: int):
    v = Validator(json_body())
    v.integer("lost_reason_id", required=True, min_value=1)
    v.string("lost_competitor", nullable=True, max_length=150)
    v.string("lost_notes", nullable=True)
    v.date("reactivation_date", nullable=True)
    return ok(leads_service.mark_lost(lead_id, v.validate()).to_dict())


def reactivate(lead_id: int):
    v = Validator(json_body())
    v.choice("stage", REACTIVATE_STAGES, default="Counselling")
    v.datetime("next_follow_up_at", nullable=True, default=None)
    data = v.validate()
    return ok(leads_service.reactivate(lead_id, data["stage"], data["next_follow_up_at"]).to_dict())


# ---------------------------------------------------------------- qualification / convert (db 019)

def get_qualification(lead_id: int):
    return ok(qualification_service.checklist(lead_id))


def set_qualification_check(lead_id: int):
    v = Validator(json_body())
    v.choice("check", QUALIFICATION_CHECKS, required=True)
    v.boolean("reviewed", required=True)
    v.string("notes", nullable=True, max_length=1000)
    data = v.validate()
    return ok(qualification_service.set_check(lead_id, data["check"], data["reviewed"], data.get("notes")))


def qualify_lead(lead_id: int):
    return ok(qualification_service.qualify(lead_id))


def convert_lead(lead_id: int):
    v = Validator(json_body())
    v.id_list("course_ids", required=True, min_items=1)
    v.integer("branch_id", min_value=1)
    v.integer("assigned_to", nullable=True, min_value=1)
    v.date("expected_close_date", nullable=True)
    result = qualification_service.convert(lead_id, v.validate())
    return ok({**result, "pipeline_entry": result["pipeline_entry"].to_dict()})


def list_activities(lead_id: int):
    page, per_page = get_page_params()
    activities, meta = leads_service.list_activities(lead_id, page, per_page)
    return paginated([a.to_dict() for a in activities], meta)


def add_activity(lead_id: int):
    v = Validator(json_body())
    v.choice("activity_type", leads_service.MANUAL_ACTIVITY_TYPES, required=True)
    v.choice("direction", ACTIVITY_DIRECTIONS, nullable=True)
    v.integer("contact_channel_id", nullable=True, min_value=1)
    v.string("outcome", nullable=True, max_length=100)
    v.string("summary", nullable=True)
    v.integer("call_duration_seconds", nullable=True, min_value=0)
    v.datetime("occurred_at", nullable=True)
    return created(leads_service.add_activity(lead_id, v.validate()).to_dict())


def list_lead_enquiries(lead_id: int):
    return ok([e.to_dict() for e in leads_service.list_enquiries(lead_id)])


# ---------------------------------------------------------------- saved views

def list_saved_views():
    v = Validator(request.args.to_dict())
    v.string("module", default="leads", max_length=50)
    return ok([view.to_dict() for view in saved_views_service.list_views(v.validate()["module"])])


def create_saved_view():
    v = Validator(json_body())
    v.string("module", default="leads", max_length=50)
    v.string("name", required=True, max_length=100)
    v.nested("filters", _saved_view_filter_rules, required=True)
    v.boolean("shared", default=False)
    return created(saved_views_service.create_view(v.validate()).to_dict())


def _saved_view_filter_rules(v: Validator) -> None:
    """Saved lead views keep the GET /leads query params."""
    v.integer("branch_id", min_value=1)
    v.choice("stage", LEAD_STAGES)
    v.integer("course_id", min_value=1)
    v.integer("source_id", min_value=1)
    v.choice("intake_status", INTAKE_STATUSES)
    v.choice("priority", LEAD_PRIORITIES)
    v.choice("queue", tuple(QUEUES))
    v.string("assigned_to", max_length=20)
    v.string("q", max_length=100)


def delete_saved_view(view_id: int):
    saved_views_service.delete_view(view_id)
    return no_content()


# ---------------------------------------------------------------- CSV imports

def upload_import():
    upload = request.files.get("file")
    if upload is not None:
        file_name, content = upload.filename or "import.csv", upload.read().decode("utf-8-sig", errors="replace")
    else:
        v = Validator(json_body())
        v.string("file_name", default="import.csv", max_length=255)
        v.string("content", required=True, strip=False)
        data = v.validate()
        file_name, content = data["file_name"], data["content"]
    return created(imports_service.upload(file_name, content).to_dict())


def get_import(import_id: int):
    return ok(imports_service.get_import(import_id).to_dict())


def run_import(import_id: int):
    return ok(imports_service.run_import(import_id).to_dict())
