"""Enquiries: capture, duplicate review (never auto-merge), link to an existing lead, or convert to a new lead."""
from config.database import db
from models import Enquiry, Person
from repositories import leads as leads_repo
from repositories.common import paginate
from services import audit
from services import leads as leads_service
from services import persons as persons_service
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError


def create_enquiry(data: dict) -> tuple[Enquiry, list[Person], list]:
    """Record the enquiry and suggest matches. A match puts it in Duplicate Review; nothing is merged automatically."""
    if not current_user().can_access_branch(data["branch_id"]):
        raise Forbidden("You can only record enquiries at your own branches")

    persons = leads_repo.persons_matching(data.get("raw_phone"), data.get("raw_email"))
    open_leads = leads_repo.open_leads_for_persons([p.person_id for p in persons], data["branch_id"])

    enquiry = Enquiry(**data, created_by=current_user().user_id)
    if persons:
        enquiry.intake_status = "Duplicate Review"
    db.session.add(enquiry)
    db.session.flush()
    db.session.refresh(enquiry)  # enquiry_code comes from a trigger
    audit.record("ENQUIRY_CREATED", "enquiry", enquiry.enquiry_id,
                 new={"intake_status": enquiry.intake_status, "matches": [p.person_id for p in persons]},
                 branch_id=enquiry.branch_id)
    return enquiry, persons, open_leads


def list_enquiries(filters: dict, page: int, per_page: int):
    return paginate(leads_repo.enquiries_stmt(filters, current_user().branch_ids()), page, per_page)


def get_enquiry(enquiry_id: int) -> Enquiry:
    enquiry = db.session.get(Enquiry, enquiry_id)
    if enquiry is None or not current_user().can_access_branch(enquiry.branch_id):
        raise NotFound("Enquiry not found")
    return enquiry


def _unlinked(enquiry_id: int) -> Enquiry:
    enquiry = get_enquiry(enquiry_id)
    if enquiry.lead_id is not None:
        raise BusinessRule(f"Enquiry is already linked to {enquiry.lead.lead_code}")
    return enquiry


def link_to_lead(enquiry_id: int, lead_id: int) -> Enquiry:
    """A repeat enquiry for an existing lead (the staff member's decision after duplicate review)."""
    enquiry = _unlinked(enquiry_id)
    lead = leads_service.get_lead(lead_id)
    if lead.branch_id != enquiry.branch_id:
        raise ValidationError("The lead is at a different branch; convert the enquiry into a lead there instead",
                              {"lead_id": ["Different branch"]})

    enquiry.lead_id = lead.lead_id
    enquiry.person_id = lead.person_id
    enquiry.owner_user_id = lead.assigned_to
    enquiry.intake_status = "New"
    summary = f"Repeat enquiry {enquiry.enquiry_code} via {enquiry.channel.label}"
    if enquiry.message:
        summary += f": {enquiry.message}"
    leads_service.log_activity(lead, "Note", summary)
    db.session.flush()
    audit.record("ENQUIRY_LINKED", "enquiry", enquiry_id, new={"lead_id": lead_id}, branch_id=enquiry.branch_id)
    return enquiry


def convert_to_lead(enquiry_id: int, data: dict):
    """New lead from the enquiry, for an existing person (person_id) or a new one (person details or the raw fields)."""
    enquiry = _unlinked(enquiry_id)

    if data.get("person_id"):
        person = persons_service.get_person(data["person_id"])
    else:
        details = data.get("person") or {"full_name": enquiry.raw_name, "phone": enquiry.raw_phone,
                                         "email": enquiry.raw_email}
        if not details.get("full_name") or not details.get("phone"):
            raise ValidationError("A name and phone are needed to create the person", {"person": ["Name and phone required"]})
        person = persons_service.create_person({**details, "registered_branch_id": enquiry.branch_id})

    return leads_service.create_from_enquiry(enquiry, person, data)
