"""Leads section: persons, enquiries, leads, activities. Admins, Branch Managers, Sales and Front Office."""
from flask import Blueprint

from controllers import leads as leads_controller
from routes.decorators import login_required, require_roles
from services.context import LEAD_ROLES

leads_bp = Blueprint("leads", __name__)


def lead_route(rule: str, method: str):
    """Every route here needs login + one of the lead roles; finer checks (owner, branch manager) are in the service."""
    def decorator(view):
        return getattr(leads_bp, method)(rule)(login_required(require_roles(*LEAD_ROLES)(view)))
    return decorator


# ---------------------------------------------------------------- persons

@lead_route("/persons/search", "get")
def search_persons():
    return leads_controller.search_persons()


@lead_route("/persons", "post")
def create_person():
    return leads_controller.create_person()


@lead_route("/persons/<int:person_id>", "get")
def get_person(person_id: int):
    return leads_controller.get_person(person_id)


@lead_route("/persons/<int:person_id>", "patch")
def update_person(person_id: int):
    return leads_controller.update_person(person_id)


# ---------------------------------------------------------------- enquiries

@lead_route("/enquiries", "post")
def create_enquiry():
    return leads_controller.create_enquiry()


@lead_route("/enquiries", "get")
def list_enquiries():
    return leads_controller.list_enquiries()


@lead_route("/enquiries/<int:enquiry_id>", "get")
def get_enquiry(enquiry_id: int):
    return leads_controller.get_enquiry(enquiry_id)


@lead_route("/enquiries/<int:enquiry_id>/link", "post")
def link_enquiry(enquiry_id: int):
    return leads_controller.link_enquiry(enquiry_id)


@lead_route("/enquiries/<int:enquiry_id>/convert", "post")
def convert_enquiry(enquiry_id: int):
    return leads_controller.convert_enquiry(enquiry_id)


# ---------------------------------------------------------------- leads

@lead_route("/leads", "post")
def create_lead():
    return leads_controller.create_lead()


@lead_route("/leads", "get")
def list_leads():
    return leads_controller.list_leads()


@lead_route("/leads/workspace", "get")
def workspace():
    return leads_controller.workspace()


@lead_route("/leads/bulk-assign", "post")
def bulk_assign():
    return leads_controller.bulk_assign()


@lead_route("/leads/<int:lead_id>", "get")
def get_lead(lead_id: int):
    return leads_controller.get_lead(lead_id)


@lead_route("/leads/<int:lead_id>", "patch")
def update_lead(lead_id: int):
    return leads_controller.update_lead(lead_id)


@lead_route("/leads/<int:lead_id>/assign", "post")
def assign_lead(lead_id: int):
    return leads_controller.assign_lead(lead_id)


@lead_route("/leads/<int:lead_id>/stage", "post")
def change_stage(lead_id: int):
    return leads_controller.change_stage(lead_id)


@lead_route("/leads/<int:lead_id>/follow-up", "post")
def schedule_follow_up(lead_id: int):
    return leads_controller.schedule_follow_up(lead_id)


@lead_route("/leads/<int:lead_id>/lost", "post")
def mark_lost(lead_id: int):
    return leads_controller.mark_lost(lead_id)


@lead_route("/leads/<int:lead_id>/reactivate", "post")
def reactivate(lead_id: int):
    return leads_controller.reactivate(lead_id)


@lead_route("/leads/<int:lead_id>/activities", "get")
def list_activities(lead_id: int):
    return leads_controller.list_activities(lead_id)


@lead_route("/leads/<int:lead_id>/activities", "post")
def add_activity(lead_id: int):
    return leads_controller.add_activity(lead_id)


@lead_route("/leads/<int:lead_id>/enquiries", "get")
def list_lead_enquiries(lead_id: int):
    return leads_controller.list_lead_enquiries(lead_id)


@lead_route("/leads/<int:lead_id>/follow-up-log", "post")
def log_follow_up(lead_id: int):
    return leads_controller.log_follow_up(lead_id)


# ---------------------------------------------------------------- saved views

@lead_route("/saved-views", "get")
def list_saved_views():
    return leads_controller.list_saved_views()


@lead_route("/saved-views", "post")
def create_saved_view():
    return leads_controller.create_saved_view()


@lead_route("/saved-views/<int:view_id>", "delete")
def delete_saved_view(view_id: int):
    return leads_controller.delete_saved_view(view_id)


# ---------------------------------------------------------------- CSV imports

@lead_route("/lead-imports", "post")
def upload_import():
    return leads_controller.upload_import()


@lead_route("/lead-imports/<int:import_id>", "get")
def get_import(import_id: int):
    return leads_controller.get_import(import_id)


@lead_route("/lead-imports/<int:import_id>/import", "post")
def run_import(import_id: int):
    return leads_controller.run_import(import_id)
