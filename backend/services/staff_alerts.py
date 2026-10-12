"""WhatsApp alerts to staff (db 042), on the staff member's own number (users.phone) — never a learner's.

One helper, send(), for every staff message: payment verified / failed, new lead assigned, approval waiting, payment
to verify, and the trainer's demo alert. Rules it enforces so callers can't forget them:
  - app setting whatsapp_staff_alerts_enabled (default on, db 042) switches all of them off;
  - the person doing the action is never told about their own action (actor_id());
  - no phone on file -> the row is saved as Skipped ("No WhatsApp number on file"), never sent to the learner;
  - the row carries recipient_user_id, so it stays out of the learner's WhatsApp conversation (the managers'
    /whatsapp list shows it labelled Staff);
  - one message per event_key, and a failure here never breaks the business change.

| Event                                   | Template                              | Who                                              |
|-----------------------------------------|---------------------------------------|--------------------------------------------------|
| Payment verified / failed               | nipuna_staff_payment_status_v1        | the deal's owner counsellor                      |
| Lead assigned (one, or a summary of >5) | nipuna_staff_lead_assigned_v1 / _leads_assigned_v1 | the new owner                       |
| Special closing request raised / late   | nipuna_staff_approval_waiting_v1      | approvers who may decide it (Branch Manager, or  |
|                                         |                                       | Founder / Super Admin); again at escalation      |
| Payment claim recorded                  | nipuna_staff_payment_to_verify_v1     | the branch's Accounts users                      |
| Demo to take                            | nipuna_staff_demo_reminder_v1         | the trainer (demo reminders)                     |
"""
import hashlib
import logging
from datetime import datetime, timezone

from sqlalchemy import func, select

from config.database import db
from models import LeadActivity, Person, User, WhatsappOutbox
from repositories import settings as settings_repo
from repositories import users as users_repo
from services import persons as persons_service
from services import whatsapp
from services import whatsapp_templates as templates
from services.reports import business_now
from services.context import actor_id
from services.whatsapp_templates import WhatsAppTemplate

logger = logging.getLogger(__name__)

SETTING = "whatsapp_staff_alerts_enabled"
SUMMARY_OVER = 5  # a bulk assignment of more than this many leads to one person sends a single summary


def enabled() -> bool:
    return bool(settings_repo.get(SETTING, False))


def send(user_id: int, template: WhatsAppTemplate, values: dict, event_key: str, *, person: Person, branch_id: int,
         source_type: str, source_id: int, skip_actor: bool = True):
    """Queue `template` to staff member `user_id`'s phone. `person` is the learner it is about (shown on /whatsapp);
    `staff_name` is filled in. Returns the outbox row, or None (switched off, the actor themselves, already queued,
    or it could not be stored). Never raises."""
    try:
        if not enabled() or (skip_actor and user_id == actor_id()):
            return None
        with db.session.begin_nested():
            staff = db.session.get(User, user_id)
            if staff is None or not staff.is_active:
                return None
            phone = persons_service.normalise_phone(staff.phone) if staff.phone else None
            return whatsapp.queue(
                template, person=person, branch_id=branch_id, source_type=source_type, source_id=source_id,
                event_key=event_key, values={"staff_name": staff.full_name, **values},
                to_phone=whatsapp.digits(phone), recipient_user_id=user_id)
    except Exception:
        logger.exception("Staff WhatsApp alert %s failed", event_key)
        return None


# ---------------------------------------------------------------- lead assigned

def _response_note(lead, imported: bool) -> str:
    """'First response due by 02:30 PM.' while the 10-staffed-minute target is still ahead; never for an import."""
    due = lead.first_attempt_due_at
    if imported or due is None or due <= datetime.now(timezone.utc):
        return "Please contact the learner soon."
    local = due.astimezone(business_now().tzinfo)
    return f"First response due by {local:%I:%M %p}{'' if local.date() == business_now().date() else local.strftime(' on %d %b')}."


def lead_assigned(leads: list, owner_id: int, *, imported: bool = False) -> None:
    """Tell the new owner. One message per lead; more than SUMMARY_OVER leads at once (a bulk assignment) send one
    summary with the count. Nothing when the owner is the person who assigned them."""
    if not leads or owner_id == actor_id() or not enabled():
        return
    if len(leads) > SUMMARY_OVER:
        first = leads[0]
        branches = ", ".join(sorted({lead.branch.branch_name for lead in leads}))
        key = "staff-leads-assigned:" + hashlib.sha1(",".join(f"{l.lead_id}.{_assignment_count(l)}" for l in sorted(leads, key=lambda l: l.lead_id)).encode()
                                                      ).hexdigest()[:16] + f":{owner_id}"
        send(owner_id, templates.STAFF_LEADS_ASSIGNED, {"lead_count": len(leads), "branch_name": branches}, key,
             person=first.person, branch_id=first.branch_id, source_type="lead", source_id=first.lead_id)
        return
    for lead in leads:
        # the owner may change again later, so the key carries the activity moment: one message per assignment
        send(owner_id, templates.STAFF_LEAD_ASSIGNED,
             {"learner_name": lead.person.full_name, "course_name": lead.course.course_title if lead.course else "a course to be decided",
              "branch_name": lead.branch.branch_name, "response_note": _response_note(lead, imported)},
             f"staff-lead-assigned:{lead.lead_id}:{owner_id}:{_assignment_count(lead)}",
             person=lead.person, branch_id=lead.branch_id, source_type="lead", source_id=lead.lead_id)


def _assignment_count(lead) -> int:
    """How many assignment changes the lead has had, so assigning back to the same person later sends again."""
    return db.session.execute(select(func.count()).select_from(LeadActivity).where(
        LeadActivity.lead_id == lead.lead_id, LeadActivity.activity_type == "Assignment Change")).scalar() or 0


# ---------------------------------------------------------------- approval waiting / payment to verify

def approvers(scr, escalated: bool = False) -> list[int]:
    """Who is asked to decide this special closing request, by the same routing as the approval queue: below the floor
    only Founder / Super Admin; otherwise the branch's Branch Managers whose limit covers the extra, and Founder /
    Super Admin only when no Branch Manager can (above the BM limit), or when it escalates. The requester is never one of them."""
    from services.context import ADMIN_ROLES
    from services.fees import approver_limit

    version = scr.version
    branch_id = version.discussion.branch_id

    def within_limit(ids):
        return sorted(i for i in ids if (limit := approver_limit(i, branch_id, version.standard_fee)) is None
                      or scr.requested_extra <= limit)

    admins = users_repo.user_ids_with_any_role(ADMIN_ROLES, branch_id) - {scr.requested_by}
    if version.is_below_floor:
        return sorted(admins)
    if escalated:
        return within_limit(admins)
    managers = within_limit(users_repo.user_ids_with_any_role(("BRANCH_MANAGER",), branch_id) - {scr.requested_by})
    return managers or within_limit(admins)


def approval_waiting(scr, *, escalated: bool = False) -> None:
    """A special closing request was raised (or sat 5 staffed minutes undecided: escalated, which only tells
    Founder / Super Admin who were not already told)."""
    try:
        with db.session.begin_nested():
            discussion = scr.version.discussion
            person = discussion.lead.person
            recipients = approvers(scr, escalated)
            for user_id in recipients:
                key = f"staff-approval:{scr.scr_id}:{user_id}"
                if escalated and db.session.execute(select(func.count()).select_from(WhatsappOutbox).where(
                        WhatsappOutbox.event_key == key)).scalar():
                    continue  # already told the first time (below the floor): don't repeat
                send(user_id, templates.STAFF_APPROVAL_WAITING,
                     {"request_code": scr.scr_code, "learner_name": person.full_name,
                      "requested_extra": f"{scr.requested_extra:.2f}", "branch_name": discussion.branch.branch_name},
                     key + (":escalated" if escalated else ""), person=person, branch_id=discussion.branch_id,
                     source_type="special_closing_request", source_id=scr.scr_id, skip_actor=not escalated)
    except Exception:
        logger.exception("Could not alert approvers about %s", scr.scr_code)
