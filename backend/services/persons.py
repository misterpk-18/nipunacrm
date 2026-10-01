"""Persons: the one canonical record per human. Duplicates are searched for, never auto-merged."""
import re

from sqlalchemy import or_, select

from config.database import db
from models import Admission, Person, PipelineEntry
from repositories import leads as leads_repo
from repositories.common import paginate
from services import audit, lms_sync
from services.context import current_user
from services.errors import Forbidden, NotFound, ValidationError

def normalise_phone(raw: str) -> str | None:
    """'98765 43210' / '098765-43210' / '+91 98765 43210' -> '+919876543210'. None if not a phone number."""
    digits = re.sub(r"[\s\-().]", "", raw)
    if digits.startswith("+"):
        return digits if re.fullmatch(r"\+\d{10,15}", digits) else None
    digits = digits.lstrip("0")
    if re.fullmatch(r"\d{10}", digits):
        return "+91" + digits
    if re.fullmatch(r"91\d{10}", digits):
        return "+" + digits
    return None


PROFILE_FIELDS = ("full_name", "phone", "alternate_phone", "whatsapp_number", "email", "city", "highest_qualification",
                  "preferred_language")


def search(phone: str | None, email: str | None, name: str | None) -> list[tuple[Person, list]]:
    """Across all branches, so a person enquiring at a second branch is still found. Returns (person, open leads)."""
    if not (phone or email or (name and len(name) >= 3)):
        raise ValidationError("Search by phone, email, or at least 3 letters of the name")
    persons = leads_repo.search_persons(phone, email, name)
    open_leads = leads_repo.open_leads_for_persons([p.person_id for p in persons])
    return [(p, [lead for lead in open_leads if lead.person_id == p.person_id]) for p in persons]


def list_persons(filters: dict, page: int, per_page: int) -> tuple[list[dict], dict]:
    """Persons section rows: the person plus lead counts and open pipeline cards at the user's branches."""
    branch_ids = current_user().branch_ids()
    if filters.get("branch_id") and not current_user().can_access_branch(filters["branch_id"]):
        raise Forbidden("You can only see persons at your own branches")
    persons, meta = paginate(leads_repo.persons_stmt(filters, branch_ids), page, per_page)
    ids = [p.person_id for p in persons]
    leads = leads_repo.leads_for_persons(ids, branch_ids)
    cards = _open_cards(ids, branch_ids)
    rows = []
    for person in persons:
        own = [lead for lead in leads if lead.person_id == person.person_id]
        rows.append({
            **person.to_dict(),
            "leads_count": len(own),
            "active_leads": [lead.to_summary() for lead in own if lead.lead_status == "Active"],
            "open_cards": [card.to_summary() | {"branch": card.branch.to_summary()}
                           for card in cards if card.person_id == person.person_id],
        })
    return rows, meta


def _open_cards(person_ids: list[int], branch_ids: set[int] | None) -> list[PipelineEntry]:
    if not person_ids:
        return []
    stmt = select(PipelineEntry).where(PipelineEntry.person_id.in_(person_ids),
                                       PipelineEntry.stage.not_in(("Admitted", "Lost - closed")))
    if branch_ids is not None:
        stmt = stmt.where(PipelineEntry.branch_id.in_(branch_ids))
    return list(db.session.execute(stmt).unique().scalars())


def overview(person_id: int) -> dict:
    """Person 360: profile, pipeline cards (open first), every lead and every admission at the user's branches."""
    person = get_person(person_id)
    branch_ids = current_user().branch_ids()
    cards = select(PipelineEntry).where(PipelineEntry.person_id == person_id).order_by(
        PipelineEntry.closed_at.desc().nulls_first(), PipelineEntry.pipeline_entry_id.desc())
    admissions = select(Admission).where(Admission.person_id == person_id).order_by(Admission.admission_id.desc())
    if branch_ids is not None:
        cards = cards.where(PipelineEntry.branch_id.in_(branch_ids))
        admissions = admissions.where(or_(Admission.original_branch_id.in_(branch_ids),
                                          Admission.service_branch_id.in_(branch_ids)))
    return {
        "person": person.to_dict(),
        "pipeline_cards": [card.to_row() | {"is_open": card.is_open, "closed_at": card.closed_at}
                           for card in db.session.execute(cards).unique().scalars()],
        "leads": [lead.to_row() for lead in reversed(leads_repo.leads_for_persons([person_id], branch_ids))],
        "admissions": [admission.to_row() for admission in db.session.execute(admissions).unique().scalars()],
    }


def get_person(person_id: int) -> Person:
    person = db.session.get(Person, person_id)
    if person is None or not leads_repo.person_visible(person_id, current_user().branch_ids()):
        raise NotFound("Person not found")
    return person


def create_person(data: dict) -> Person:
    if not current_user().can_access_branch(data["registered_branch_id"]):
        raise Forbidden("You can only register people at your own branches")
    person = Person(**data, created_by=current_user().user_id)
    db.session.add(person)
    db.session.flush()
    db.session.refresh(person)  # person_code comes from a trigger
    audit.record("PERSON_CREATED", "person", person.person_id, new=person.to_summary(),
                 branch_id=person.registered_branch_id)
    return person


def update_person(person_id: int, data: dict) -> Person:
    person = get_person(person_id)
    old = {f: getattr(person, f) for f in PROFILE_FIELDS}
    for field, value in data.items():
        setattr(person, field, value)
    db.session.flush()
    audit.record("PERSON_UPDATED", "person", person_id, old=old, new={f: getattr(person, f) for f in PROFILE_FIELDS})
    lms_sync.person_changed(person_id, [f for f in PROFILE_FIELDS if old[f] != getattr(person, f)])
    return person
