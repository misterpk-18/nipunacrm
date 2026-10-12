"""Drift check between the CRM and the Nipuna LMS (round 3, phase 4): `flask lms reconcile [--admission ID] [--fix]`
and the daily job lms-reconcile.

Per admission the CRM compares what it holds with the LMS's full state from the status pull (all records, or one
admission through the Q5 filter):

| Field                                        | Owner | --fix                                                   |
|----------------------------------------------|-------|---------------------------------------------------------|
| in the LMS at all (no academics entry)       | CRM   | AdmissionQualified + FinanceSummaryUpdated sent again   |
| lms_user_id, lms_status, active allocations  | LMS   | the mirror takes the LMS's entry                        |

Curriculum is not compared: the CRM doesn't hold one. Cancelled admissions are skipped (the LMS withdrew them).
"""
from datetime import datetime, timezone

from sqlalchemy import select

from config.database import db
from models import Admission, BatchAllocation, Branch, Person
from services import lms_delivery, lms_pull, lms_sync, tasks
from services.errors import BusinessRule


def _fetch(admission_id: int | None) -> dict:
    if admission_id is not None:
        admission = db.session.get(Admission, admission_id)
        if admission is None:
            raise BusinessRule(f"No admission {admission_id}")
        data, answer = lms_pull.fetch_admission(admission)
    else:
        answer = lms_delivery.pull_status(lms_pull.FULL_PULL_SINCE)
        body = (answer.body or {}).get("data") if answer.status == 200 else None
        data = {kind: lms_pull._entries(kind, body) for kind in lms_pull.KINDS} if isinstance(body, dict) else None
    if data is None:
        raise BusinessRule(f"The LMS didn't answer: {lms_delivery.error_text(answer)}")
    return data


def _by(entries: list[dict], key: str) -> dict:
    return {lms_pull._int(e.get(key)): e for e in entries}


def _active_batches(admission: Admission) -> list[str]:
    rows = db.session.execute(select(BatchAllocation).where(
        BatchAllocation.admission_id == admission.admission_id, BatchAllocation.status == "Active")).scalars()
    return sorted(a.batch.lms_course_id or a.batch.batch_code for a in rows)


def compare(admission: Admission, lms: dict) -> list[dict]:
    """Drift for one admission: [{field, crm, lms, owner}]."""
    person = db.session.get(Person, admission.person_id)
    academics = lms["academics"].get(admission.admission_id)
    if academics is None:
        return [{"field": "admission", "crm": admission.admission_code, "lms": None, "owner": "CRM"}]
    drift = []
    person_entry = lms["persons"].get(admission.person_id)
    if person_entry is not None and person.lms_user_id != person_entry.get("lms_user_id"):
        drift.append({"field": "lms_user_id", "crm": person.lms_user_id, "lms": person_entry.get("lms_user_id"),
                      "owner": "LMS"})
    status_entry = lms["admissions"].get(admission.admission_id)
    if status_entry is not None and admission.lms_status != status_entry.get("lms_status"):
        drift.append({"field": "lms_status", "crm": admission.lms_status, "lms": status_entry.get("lms_status"),
                      "owner": "LMS"})

    lms_batches = sorted(a.get("lms_course_id") for a in academics.get("allocations") or [] if a.get("status") == "Active")
    if _active_batches(admission) != lms_batches:
        drift.append({"field": "allocation", "crm": _active_batches(admission), "lms": lms_batches, "owner": "LMS"})
    return drift


def _fix(admission: Admission, items: list[dict], data: dict) -> list[dict]:
    """Repair what can be repaired; returns the items still unresolved."""
    unresolved = []
    owners = {item["owner"] for item in items}
    if "LMS" in owners:
        keys = {"persons": admission.person_id, "admissions": admission.admission_id,
                "academics": admission.admission_id}
        for kind in ("batches", "persons", "admissions", "academics"):
            for entry in data[kind]:
                wanted = keys.get(kind)
                if wanted is None or lms_pull._int(entry.get("crm_person_id" if kind == "persons" else
                                                             "crm_admission_id")) == wanted:
                    outcome = lms_pull._apply_one(kind, lms_pull.record_key(kind, entry), entry)
                    if outcome == "held" and kind != "batches":
                        unresolved += [i for i in items if i["owner"] == "LMS"]
    for item in items:
        if item["owner"] != "CRM":
            continue
        if item["field"] == "admission":
            lms_sync.admission_qualified(admission.admission_id)
            lms_sync.finance_changed(admission_id=admission.admission_id)
        db.session.commit()
    return unresolved


def reconcile(admission_id: int | None = None, fix: bool = False) -> dict:
    """Compare the CRM with the LMS. Returns {checked, drift: [{admission_id, admission_code, field, crm, lms, owner}],
    fixed, unresolved}."""
    if not lms_delivery.configured():
        raise BusinessRule("LMS_BASE_URL / LMS_SERVICE_KEY not set")
    db.session.commit()                                   # nothing held open while the LMS answers
    data = _fetch(admission_id)
    lms = {"persons": _by(data["persons"], "crm_person_id"), "admissions": _by(data["admissions"], "crm_admission_id"),
           "academics": _by(data["academics"], "crm_admission_id")}
    stmt = select(Admission).order_by(Admission.admission_id)
    stmt = stmt.where(Admission.admission_id == admission_id) if admission_id is not None else \
        stmt.where(Admission.enrolment_status != "Cancelled")
    drift, unresolved = [], []
    admissions = db.session.execute(stmt).scalars().all()
    for admission in admissions:
        items = compare(admission, lms)
        drift += [{"admission_id": admission.admission_id, "admission_code": admission.admission_code, **i} for i in items]
        if items:
            left = _fix(admission, items, data) if fix else items
            unresolved += [{"admission_id": admission.admission_id, "admission_code": admission.admission_code, **i}
                           for i in left]
    return {"checked": len(admissions), "drift": drift, "fixed": len(drift) - len(unresolved) if fix else 0,
            "unresolved": unresolved}


def daily() -> dict:
    """Job lms-reconcile: once per business day, a Super Admin task when the CRM and the LMS disagree."""
    if not lms_delivery.configured():
        return {"skipped": "LMS_BASE_URL / LMS_SERVICE_KEY not set"}
    tz = lms_sync.business_tz()
    today = datetime.now(tz).date()
    last = lms_pull.state().last_reconcile_at
    if last is not None and last.astimezone(tz).date() == today:
        return {"skipped": "already checked today"}
    result = reconcile()
    lms_pull.state().last_reconcile_at = datetime.now(timezone.utc)
    if result["drift"]:
        lines = [f"{d['admission_code']} {d['field']}: CRM {d['crm']} · LMS {d['lms']} ({d['owner']})"
                 for d in result["drift"][:50]]
        branch_id = db.session.execute(select(Branch.branch_id).order_by(Branch.branch_id).limit(1)).scalar_one()
        tasks.create_system_task(
            "GENERAL", f"CRM and LMS disagree on {len(result['drift'])} item(s)", branch_id, datetime.now(timezone.utc),
            team_role_code="SUPER_ADMIN", description="Run `flask lms reconcile --fix`.\n" + "\n".join(lines),
            dedupe_key=f"lms-reconcile:{today.isoformat()}")
    db.session.flush()
    return {"checked": result["checked"], "drift": len(result["drift"])}
