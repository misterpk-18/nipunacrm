"""Approved sales knowledge, reply templates, course paths, AI branch controls, and optional next-course suggestions
for existing students (playbook pages 13-14, 16-17).

Who maintains what (owner decision 2026-10-02): Founder / CEO, Super Admin and Branch Managers edit and approve
knowledge and templates (a Branch Manager only for their branch); a Branch Manager or an admin approves course
paths. Staff and the AI only ever see Approved rows.
"""
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from config.database import db
from models import (
    Admission, AiAction, AiBranchControl, Branch, ComboCourse, Course, CourseBranch, CoursePath, Lead, Person, SalesKnowledge,
)
from models.enums import CLOSED_STAGES
from repositories import leads as leads_repo
from services import audit
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError
from services.playbook import POLICY_VERSION, fingerprint
from services.reports import business_now

KNOWLEDGE_FIELDS = ("kind", "title", "course_id", "branch_id", "situation", "language", "body", "link_url",
                    "owner_user_id", "review_due_on")
PATH_FIELDS = ("from_course_id", "to_course_id", "learner_benefit", "helps_when", "skip_when", "prerequisites",
               "suggested_question")


# ---------------------------------------------------------------- knowledge

def _can_edit_knowledge(branch_id: int | None) -> bool:
    user = current_user()
    return user.is_admin or (branch_id is not None and user.has_role("BRANCH_MANAGER", branch_id=branch_id))


def _editable(knowledge_id: int) -> SalesKnowledge:
    item = db.session.get(SalesKnowledge, knowledge_id)
    if item is None or (item.branch_id and not current_user().can_access_branch(item.branch_id)):
        raise NotFound("Knowledge item not found")
    if not _can_edit_knowledge(item.branch_id):
        raise Forbidden("Only admins, or the Branch Manager of its branch, can change this item"
                        + (" (company-wide items are admin-only)" if item.branch_id is None else ""))
    return item


def list_knowledge(filters: dict) -> list[dict]:
    user = current_user()
    stmt = select(SalesKnowledge).order_by(SalesKnowledge.kind, SalesKnowledge.title, SalesKnowledge.knowledge_id)
    branch_ids = user.branch_ids()
    if branch_ids is not None:
        stmt = stmt.where(or_(SalesKnowledge.branch_id.is_(None), SalesKnowledge.branch_id.in_(branch_ids)))
    manager = user.is_admin or user.has_role("BRANCH_MANAGER")
    if not manager:
        stmt = stmt.where(SalesKnowledge.status == "Approved")
    elif filters.get("status"):
        stmt = stmt.where(SalesKnowledge.status == filters["status"])
    for field in ("kind", "course_id", "branch_id", "situation"):
        if filters.get(field) is not None:
            stmt = stmt.where(getattr(SalesKnowledge, field) == filters[field])
    today = business_now().date()
    return [k.to_dict(today) for k in db.session.execute(stmt).scalars()]


def _check_knowledge(data: dict) -> None:
    kind = data.get("kind")
    if kind == "Reply template" and not data.get("situation"):
        raise ValidationError("A reply template needs a situation", {"situation": ["Required for reply templates"]})
    if kind and kind != "Reply template" and data.get("situation"):
        raise ValidationError("Only reply templates have a situation", {"situation": ["Leave empty"]})
    if kind in ("Syllabus", "Brochure") and not data.get("link_url"):
        raise ValidationError(f"A {kind.lower()} needs its approved link", {"link_url": ["Required"]})


def create_knowledge(data: dict) -> SalesKnowledge:
    if not _can_edit_knowledge(data.get("branch_id")):
        raise Forbidden("Branch Managers add items for their own branch; company-wide items are admin-only")
    _check_knowledge(data)
    user = current_user()
    item = SalesKnowledge(**{k: data.get(k) for k in KNOWLEDGE_FIELDS if k in data}, status="Draft",
                          owner_user_id=data.get("owner_user_id") or user.user_id, created_by=user.user_id)
    db.session.add(item)
    db.session.flush()
    db.session.refresh(item)
    audit.record("KNOWLEDGE_CREATED", "sales_knowledge", item.knowledge_id, new={"title": item.title, "kind": item.kind},
                 branch_id=item.branch_id)
    return item


def update_knowledge(knowledge_id: int, data: dict) -> SalesKnowledge:
    item = _editable(knowledge_id)
    if item.status == "Retired":
        raise BusinessRule("Retired knowledge can't be edited; create a new item")
    if "branch_id" in data and not _can_edit_knowledge(data["branch_id"]):
        raise Forbidden("You can't move this item to that branch")
    merged = {k: data.get(k, getattr(item, k)) for k in KNOWLEDGE_FIELDS}
    _check_knowledge(merged)
    old = {k: getattr(item, k) for k in data}
    for k, v in data.items():
        setattr(item, k, v)
    db.session.flush()
    db.session.refresh(item)  # editing an Approved item makes it a new Draft version (trigger)
    audit.record("KNOWLEDGE_UPDATED", "sales_knowledge", item.knowledge_id, old=old, new=data, branch_id=item.branch_id)
    return item


def set_knowledge_status(knowledge_id: int, status: str) -> SalesKnowledge:
    item = _editable(knowledge_id)
    if item.status == status:
        raise BusinessRule(f"Already {status.lower()}")
    if item.status == "Retired":
        raise BusinessRule("Retired knowledge can't be brought back; create a new item")
    item.status = status
    db.session.flush()
    db.session.refresh(item)
    audit.record(f"KNOWLEDGE_{status.upper()}", "sales_knowledge", item.knowledge_id, new={"version": item.version},
                 branch_id=item.branch_id)
    return item


# ---------------------------------------------------------------- course paths

def _can_edit_paths() -> bool:
    user = current_user()
    return user.is_admin or user.has_role("BRANCH_MANAGER")


def list_paths(filters: dict) -> list[CoursePath]:
    stmt = select(CoursePath).order_by(CoursePath.status, CoursePath.from_course_id, CoursePath.to_course_id)
    if not (_can_edit_paths() or current_user().has_role("BRANCH_MANAGER")):
        stmt = stmt.where(CoursePath.status == "Approved")
    elif filters.get("status"):
        stmt = stmt.where(CoursePath.status == filters["status"])
    return list(db.session.execute(stmt).scalars())


def _path(path_id: int) -> CoursePath:
    if not _can_edit_paths():
        raise Forbidden("Only a Branch Manager or an admin can change course paths")
    path = db.session.get(CoursePath, path_id)
    if path is None:
        raise NotFound("Course path not found")
    return path


def create_path(data: dict) -> CoursePath:
    if not _can_edit_paths():
        raise Forbidden("Only a Branch Manager or an admin can add course paths")
    if data["from_course_id"] == data["to_course_id"]:
        raise ValidationError("A path goes to a different course", {"to_course_id": ["Same as the starting course"]})
    for field in ("from_course_id", "to_course_id"):
        if db.session.get(Course, data[field]) is None:
            raise ValidationError("Unknown course", {field: ["Not found"]})
    existing = db.session.execute(select(CoursePath).where(CoursePath.from_course_id == data["from_course_id"],
                                                           CoursePath.to_course_id == data["to_course_id"])).scalar()
    if existing:
        raise BusinessRule(f"This path already exists ({existing.status}); edit it instead")
    path = CoursePath(**{k: data.get(k) for k in PATH_FIELDS}, created_by=current_user().user_id)
    db.session.add(path)
    db.session.flush()
    db.session.refresh(path)
    return path


def update_path(path_id: int, data: dict) -> CoursePath:
    path = _path(path_id)
    if path.status == "Retired":
        raise BusinessRule("A retired course path can't be edited; create it again")
    for k, v in data.items():
        setattr(path, k, v)
    db.session.flush()
    db.session.refresh(path)
    return path


def set_path_status(path_id: int, status: str) -> CoursePath:
    path = _path(path_id)
    if path.status == status:
        raise BusinessRule(f"Already {status.lower()}")
    if path.status == "Retired":
        raise BusinessRule("A retired course path can't be brought back; create it again")
    path.status = status
    db.session.flush()
    db.session.refresh(path)
    audit.record(f"COURSE_PATH_{status.upper()}", "course_path", path.course_path_id)
    return path


# ---------------------------------------------------------------- AI branch controls

def list_controls() -> list[AiBranchControl]:
    branch_ids = current_user().branch_ids()
    stmt = select(AiBranchControl).order_by(AiBranchControl.branch_id)
    if branch_ids is not None:
        stmt = stmt.where(AiBranchControl.branch_id.in_(branch_ids))
    return list(db.session.execute(stmt).scalars())


def update_control(branch_id: int, data: dict) -> AiBranchControl:
    user = current_user()
    control = db.session.get(AiBranchControl, branch_id)
    if control is None or not user.can_access_branch(branch_id):
        raise NotFound("Branch not found")
    if not user.is_manager_of(branch_id):
        raise Forbidden("Only the Branch Manager or an admin can change AI assistance for a branch")
    if data.get("execution_profile") == "Approved automatic":
        raise BusinessRule("Approved automatic needs a live WhatsApp / telephony channel that has passed the retry, "
                           "stale-send and opt-out tests; none is connected yet")
    old = {"execution_profile": control.execution_profile, "is_paused": control.is_paused}
    if "execution_profile" in data:
        control.execution_profile = data["execution_profile"]
    if "is_paused" in data:
        if data["is_paused"] and not data.get("pause_reason"):
            raise ValidationError("Pausing needs a reason", {"pause_reason": ["Required"]})
        control.is_paused = data["is_paused"]
        control.pause_reason = data.get("pause_reason") if data["is_paused"] else None
        control.paused_by = user.user_id if data["is_paused"] else None
        control.paused_at = datetime.now(timezone.utc) if data["is_paused"] else None
    control.updated_by = user.user_id
    db.session.flush()
    db.session.refresh(control)
    audit.record("AI_CONTROL_UPDATED", "ai_branch_control", branch_id, old=old, new=data, branch_id=branch_id)
    return control


# ---------------------------------------------------------------- next-course suggestions (existing students)

def _visible_person(person_id: int) -> Person:
    person = db.session.get(Person, person_id)
    if person is None or not leads_repo.person_visible(person_id, current_user().branch_ids()):
        raise NotFound("Person not found")
    return person


def _owned(person_id: int) -> tuple[list[Admission], set[int]]:
    """Non-cancelled admissions (paid, included or complimentary) and every course they give access to."""
    admissions = list(db.session.execute(select(Admission).where(Admission.person_id == person_id,
                                                                 Admission.cancelled_at.is_(None))
                                         .order_by(Admission.admission_id)).scalars())
    owned = {a.course_id for a in admissions}
    if owned:
        owned |= set(db.session.execute(select(ComboCourse.component_course_id)
                                        .where(ComboCourse.combo_course_id.in_(owned))).scalars())
    return admissions, owned


def _candidates(person: Person) -> tuple[list[dict], list[dict]]:
    admissions, owned = _owned(person.person_id)
    if not admissions:
        return [], []
    latest = admissions[-1]
    branch_id = latest.service_branch_id or latest.original_branch_id
    goal = db.session.execute(select(Lead.learner_goal).where(Lead.person_id == person.person_id,
                                                              Lead.learner_goal.is_not(None))
                              .order_by(Lead.updated_at.desc())).scalar()
    open_leads = {lead.course_id: lead for lead in db.session.execute(
        select(Lead).where(Lead.person_id == person.person_id, Lead.stage.not_in(CLOSED_STAGES))).scalars()}
    branch = db.session.get(Branch, branch_id)
    offered = set(db.session.execute(select(CourseBranch.course_id).where(CourseBranch.branch_code == branch.branch_code)).scalars())
    paths = db.session.execute(select(CoursePath).where(CoursePath.status == "Approved",
                                                        CoursePath.from_course_id.in_(owned))
                               .order_by(CoursePath.course_path_id)).scalars()
    cards, skipped = [], []
    seen = set()
    for path in paths:
        to = path.to_course
        if to.course_id in seen:
            continue
        seen.add(to.course_id)
        if to.course_id in owned:
            skipped.append({"course": to.to_summary(), "reason": "Already owned or included: support the existing entitlement"})
            continue
        if to.status != "Active" or to.course_id not in offered:
            skipped.append({"course": to.to_summary(), "reason": f"Not currently offered at {branch.branch_name}"})
            continue
        overlap = []
        if to.is_combo:
            parts = db.session.execute(select(ComboCourse).where(ComboCourse.combo_course_id == to.course_id)).scalars()
            overlap = [p.component.to_summary() for p in parts if p.component_course_id in owned]
        evidence = [{"type": "admission", "id": a.admission_id, "code": a.admission_code, "course_id": a.course_id}
                    for a in admissions] + [{"type": "course_path", "id": path.course_path_id}]
        missing = ["Confirm the learner's goal needs this skill" if not goal else None,
                   f"Check prerequisites: {path.prerequisites}" if path.prerequisites else None,
                   "Check current batch availability and workload with the Branch Manager"]
        open_lead = open_leads.get(to.course_id)
        cards.append({
            "action_code": f"course:{path.from_course_id}>{to.course_id}",
            "fingerprint": fingerprint("course", sorted(owned), to.course_id, goal, path.course_path_id, path.updated_at),
            "course": to.to_summary(), "from_course": path.from_course.to_summary(),
            "learner_benefit": path.learner_benefit, "helps_when": path.helps_when, "skip_when": path.skip_when,
            "goal": goal, "evidence": evidence, "missing_checks": [m for m in missing if m],
            "overlap": overlap, "availability": f"Offered at {branch.branch_name}", "branch_id": branch_id,
            "suggested_question": path.suggested_question or f"Would {to.course_title} help with what you want to do?",
            "open_lead": {"lead_id": open_lead.lead_id, "lead_code": open_lead.lead_code, "stage": open_lead.stage} if open_lead else None,
        })
    # Usefulness first: a stated goal that mentions the course's words ranks higher. Never by fee.
    if goal:
        words = {w for w in goal.lower().split() if len(w) > 3}
        cards.sort(key=lambda c: -len(words & set(c["course"]["course_title"].lower().split())))
    return cards, skipped


def _latest(person_id: int, course_id: int) -> AiAction | None:
    return db.session.execute(select(AiAction).where(AiAction.person_id == person_id, AiAction.course_id == course_id,
                                                     AiAction.action_type == "Course suggestion")
                              .order_by(AiAction.ai_action_id.desc())).scalars().first()


def course_suggestions(person_id: int) -> dict:
    person = _visible_person(person_id)
    cards, skipped = _candidates(person)
    now = datetime.now(timezone.utc)
    shown, hidden = [], []
    for card in cards:
        last = _latest(person.person_id, card["course"]["course_id"])
        card["disposition"] = {"status": last.status, "at": last.disposition_at, "remind_at": last.remind_at,
                               "note": last.disposition_note} if last else None
        dismissed = last is not None and last.fingerprint == card["fingerprint"] and last.status == "Ignored"
        snoozed = last is not None and last.status == "Snoozed" and last.remind_at > now
        (hidden if dismissed or snoozed else shown).append(card)
    return {"person_id": person.person_id, "is_student": bool(_owned(person.person_id)[0]),
            "stop_contact": person.stop_contact_at is not None, "suggestions": shown, "hidden": hidden,
            "skipped": skipped, "note": None if shown else "No useful next course right now. That is a valid result."}


def dispose_course_suggestion(person_id: int, data: dict) -> AiAction:
    """Use (discussed with the learner) / Edit / Ignore / Remind later. None of these creates a deal: confirmed
    interest is recorded by adding a lead for the course under the same person."""
    person = _visible_person(person_id)
    user = current_user()
    if not user.has_role("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE"):
        raise Forbidden("Only sales staff or managers can act on course suggestions")
    cards, _ = _candidates(person)
    card = next((c for c in cards if c["course"]["course_id"] == data["course_id"]), None)
    if card is None:
        raise BusinessRule("This course is not a current suggestion for the learner (owned, unavailable or no approved path)")
    status = data["status"]
    if status == "Snoozed" and (data.get("remind_at") is None or data["remind_at"] <= datetime.now(timezone.utc)):
        raise ValidationError("Remind later needs a future date", {"remind_at": ["Must be in the future"]})
    if status == "Edited" and not data.get("final_text"):
        raise ValidationError("Edit needs the reviewed wording", {"final_text": ["Required"]})
    if person.stop_contact_at is not None and status in ("Used", "Edited"):
        raise BusinessRule("Stop contact is recorded for this person; a course suggestion can't be discussed proactively")
    action = AiAction(action_type="Course suggestion", action_code=card["action_code"], fingerprint=card["fingerprint"],
                      person_id=person.person_id, branch_id=card["branch_id"], course_id=card["course"]["course_id"],
                      suggestion=f"{card['course']['course_title']}: {card['learner_benefit']}",
                      reason=card["suggested_question"], evidence=json.loads(json.dumps(card["evidence"], default=str)),
                      payload={"missing_checks": card["missing_checks"], "overlap": card["overlap"]},
                      status=status, final_text=data.get("final_text"), disposition_note=data.get("note"),
                      remind_at=data.get("remind_at") if status == "Snoozed" else None, disposition_by=user.user_id,
                      disposition_at=datetime.now(timezone.utc), model="rules", policy_version=POLICY_VERSION,
                      created_by=user.user_id, expires_at=datetime.now(timezone.utc) + timedelta(days=90))
    db.session.add(action)
    db.session.flush()
    return action
