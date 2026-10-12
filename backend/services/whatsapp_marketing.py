"""Marketing templates (db 033 category Marketing): a counsellor sends one to a lead from Lead 360. Never automatic.

Rules, each with its own message:
  - the person's WhatsApp notifications switch is on (db 044)
  - the learner has Explicit Consent for WhatsApp marketing (db 034); a STOP reply withdraws it
  - no stop contact, and the unanswered-lead WhatsApp ceiling is not reached (services/contact_policy.py)
  - a number is on file
  - the same template is sent to the same lead at most once a day
The message goes through the same outbox as every other (test numbers, switch, retries) and is logged on the lead's
timeline as an outbound WhatsApp, so it counts against the contact ceilings."""
from datetime import date

from config.database import db
from models import Course
from repositories import leads as leads_repo
from services import audit, contact_policy, leads as leads_service, persons as persons_service, whatsapp
from services.context import current_user
from services import whatsapp_templates as templates
from services.errors import BusinessRule, NotFound, ValidationError

CATALOGUE = {
    "course_recommendation": {
        "template": templates.COURSE_RECOMMENDATION, "label": "Course recommendation",
        "needs": ("course", "interest"), "reply_keywords": ("DETAILS",),
        "about": "Suggests a course for what the learner said they are interested in"},
    "course_brochure": {
        "template": templates.COURSE_BROCHURE, "label": "Course brochure", "needs": ("course",),
        "reply_keywords": ("BROCHURE", "CALLBACK"), "about": "Offers the syllabus and course structure"},
    "new_batch": {
        "template": templates.NEW_BATCH, "label": "New batch", "needs": ("course",),
        "reply_keywords": ("BATCH", "DEMO"), "about": "Tells the learner about an upcoming batch at the lead's branch"},
    "enquiry_followup": {
        "template": templates.ENQUIRY_FOLLOWUP, "label": "Enquiry follow-up", "needs": ("course",),
        "reply_keywords": ("INTERESTED", "CALLBACK"), "about": "Asks whether the learner is still exploring the course"},
}


def catalogue() -> list[dict]:
    return [{"key": key, "label": item["label"], "template_name": item["template"].name, "needs": list(item["needs"]),
             "reply_keywords": list(item["reply_keywords"]), "about": item["about"]} for key, item in CATALOGUE.items()]


def send_to_person(person_id: int, data: dict):
    """Send now from Person 360: the same rules, on the person's most recent lead (the contact ceilings, the branch and
    the timeline entry all belong to a lead)."""
    person = persons_service.get_person(person_id)
    leads = leads_repo.leads_for_persons([person_id], current_user().branch_ids())
    if not leads:
        raise BusinessRule(f"{person.full_name} has no enquiry yet. Add one before sending a template")
    return send(leads[-1].lead_id, data)


def send(lead_id: int, data: dict):
    item = CATALOGUE[data["template"]]
    template = item["template"]
    lead = leads_service.get_lead(lead_id)
    person = lead.person
    if not person.whatsapp_notifications:
        raise BusinessRule(f"WhatsApp notifications are switched off for {person.full_name}. Switch them on first")
    if person.whatsapp_consent != "Explicit Consent":
        raise BusinessRule(f"{person.full_name} has not agreed to WhatsApp marketing "
                           f"({person.whatsapp_consent.lower()}). Record their consent first")
    blocked = contact_policy.check(lead, "WhatsApp")
    if blocked:
        raise BusinessRule(blocked)
    phone = whatsapp.recipient_phone(person)
    if phone is None:
        raise BusinessRule(f"{person.full_name} has no WhatsApp number on file")

    course = db.session.get(Course, data["course_id"]) if data.get("course_id") else lead.course
    if course is None:
        raise ValidationError("Choose the course", {"course_id": ["Required: this lead has no course yet"]})
    values = {"customer_name": person.full_name, "course_name": course.course_title, "branch_name": lead.branch.branch_name}
    if "interest" in item["needs"]:
        values["interest"] = data.get("interest") or lead.learner_goal or course.category
        if not values["interest"]:
            raise ValidationError("Say what the learner is interested in", {"interest": ["Required"]})

    key = f"marketing:{data['template']}:{lead.lead_id}:{date.today().isoformat()}"
    row = whatsapp.queue(template, person=person, branch_id=lead.branch_id, source_type="lead", source_id=lead.lead_id,
                         event_key=key, values=values)
    if row is None:
        raise BusinessRule(f"{item['label']} was already sent to {person.full_name} today")
    leads_service.log_activity(lead, "WhatsApp", f"Template message: {row.body_text}", direction="Outbound",
                               outcome="Queued")
    audit.record("WHATSAPP_MARKETING", "lead", lead.lead_id, new={"template": template.name, "outbox_id": row.outbox_id},
                 branch_id=lead.branch_id)
    return row
