"""Persons: the one canonical record per human. Duplicates are searched for, never auto-merged."""
import re

from config.database import db
from models import Person
from repositories import leads as leads_repo
from services import audit
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
    return person
