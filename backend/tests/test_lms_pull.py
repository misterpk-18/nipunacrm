"""LMS status pull (db 028): the CRM mirrors logins, LMS status, batches, allocations, completion and certificates;
academic writes are refused while the LMS owns them; pause / resume reach the LMS."""
import pytest
from sqlalchemy import select

from config.database import db
from models import (
    Admission, AdmissionCurriculum, Batch, BatchAllocation, Certificate, CurriculumVersion, LmsOutbox, LmsPullHold,
    Person, Task, User,
)
from services import lms_delivery, lms_pull
from tests.helpers import API, admitted, call

AS_OF = "2026-10-01T09:00:00.123456+00:00"


@pytest.fixture
def lms_owned(run_sql):
    run_sql("UPDATE app_settings SET setting_value = 'true' WHERE setting_key = 'academics_managed_in_lms'")


class FakePull:
    """Stands in for GET /integrations/crm/status: returns the queued answers in turn and keeps each `since`."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.since = []

    def __call__(self, since):
        self.since.append(since)
        answer = self.answers.pop(0)
        if isinstance(answer, lms_delivery.Answer):
            return answer
        return lms_delivery.Answer(200, {"data": {"persons": [], "admissions": [], "academics": [], "batches": [],
                                                  "certificates": [], "as_of": AS_OF, **answer}})


@pytest.fixture
def fake_pull(monkeypatch):
    def _install(*answers):
        fake = FakePull(*answers)
        monkeypatch.setattr(lms_delivery, "pull_status", fake)
        return fake
    return _install


def batch_entry(**overrides):
    return {"lms_course_id": "NIT-GNT-BAT-2026-000101", "crm_batch_id": None, "course_code": "NIT-CRS-018",
            "branch_code": "NIT-GNT", "delivery_mode": "Classroom", "status": "Open", "capacity": 20,
            "start_date": "2026-10-05", "end_date": "2027-01-30", "curriculum_version_label": "CV 5.1",
            "lead_trainer_email": None, "trainer_emails": [], **overrides}


def academics_entry(admission_id, **overrides):
    return {"crm_admission_id": str(admission_id), "enrolment_status": "Awaiting Batch Allocation",
            "curriculum_status": "Mapped", "curriculum_version_label": "CV 5.1", "service_branch_code": "NIT-GNT",
            "joining_date": None, "academic_completed_at": None, "completion_authorised_by_email": None,
            "allocations": [], **overrides}


def allocation(**overrides):
    return {"course_code": "NIT-CRS-018", "track_code": None, "lms_course_id": "NIT-GNT-BAT-2026-000101",
            "crm_batch_id": None, "status": "Active", "joining_date": None, "allocated_on": "2026-10-02",
            "ended_on": None, "end_reason": None, **overrides}


def email_of(user_id):
    return db.session.get(User, user_id).email


def fresh(model, key):
    return db.session.get(model, key, populate_existing=True)


# ---------------------------------------------------------------- §5.1 login and LMS status

def test_pull_writes_login_and_status_and_moves_watermark(client, people, course, fake_pull):
    flow = admitted(client, people, course)
    aid, pid = flow["admission"]["admission_id"], flow["admission"]["person"]["person_id"]
    fake = fake_pull({
        "persons": [{"crm_person_id": str(pid), "lms_user_id": "NIT-STU-2026-004300",
                     "lms_provisioned_at": "2026-10-01T14:10:56.965536+05:30"},
                    {"crm_person_id": "99999", "lms_user_id": "NIT-STU-X", "lms_provisioned_at": None}],
        "admissions": [{"crm_admission_id": str(aid), "lms_status": "Invited", "lms_last_activity_at": None,
                        "lms_last_synced_at": AS_OF}],
    })
    result = lms_pull.pull()
    assert result == {"persons_applied": 1, "persons_ignored": 1, "admissions_applied": 1}
    assert fake.since == ["1970-01-01T00:00:00+00:00"]

    assert fresh(Person, pid).lms_user_id == "NIT-STU-2026-004300"
    admission = fresh(Admission, aid)
    assert admission.lms_status == "Invited" and admission.lms_last_synced_at is not None
    state = lms_pull.state()
    assert state.since == AS_OF and state.last_success_at is not None and state.locked_until is None

    status = call(client, "get", "/lms/sync-status", people["sravani"]["h"])
    assert status["pull"]["since"] == AS_OF and status["held"] == 0


# ---------------------------------------------------------------- §5.2 allocation, joining, curriculum

def test_allocation_joining_and_curriculum_are_mirrored(client, people, course, fake_pull, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    trainer = email_of(people["trainer"]["id"]).upper()     # matched ignoring case
    fake_pull({
        "batches": [batch_entry(lead_trainer_email=trainer, trainer_emails=[trainer, "guest@lms.test"])],
        "academics": [academics_entry(aid, enrolment_status="In Progress", joining_date="2026-10-06", allocations=[
            allocation(track_code="NIT-CRS-018/T1", joining_date="2026-10-06"),
            allocation(track_code="NIT-CRS-018/T2", joining_date="2026-10-06")])],
    })
    assert lms_pull.pull() == {"batches_applied": 1, "academics_applied": 1}

    batch = db.session.execute(select(Batch).where(Batch.lms_course_id == "NIT-GNT-BAT-2026-000101")).scalar_one()
    assert batch.lms_mirrored and batch.batch_code.startswith("GNT-B-") and batch.status == "Open"
    assert batch.trainer_user_id == people["trainer"]["id"] and batch.trainer_emails[1] == "guest@lms.test"
    assert batch.curriculum_version.version_label == "CV 5.1" and batch.curriculum_version.lms_mirrored

    allocations = db.session.execute(select(BatchAllocation).where(BatchAllocation.admission_id == aid)
                                     .order_by(BatchAllocation.track_code)).scalars().all()
    assert [(a.track_code, a.status, str(a.joining_date)) for a in allocations] == [
        ("NIT-CRS-018/T1", "Active", "2026-10-06"), ("NIT-CRS-018/T2", "Active", "2026-10-06")]
    admission = fresh(Admission, aid)
    assert (admission.enrolment_status, admission.curriculum_status) == ("In Progress", "Mapped")
    mapped = db.session.execute(select(AdmissionCurriculum).where(AdmissionCurriculum.admission_id == aid)).scalars().all()
    assert [m.curriculum_version.version_label for m in mapped] == ["CV 5.1"]

    # A move: T1's allocation closes, a new one opens on another batch — the full history replaces the old set
    fake_pull({
        "batches": [batch_entry(lms_course_id="NIT-GNT-BAT-2026-000102")],
        "academics": [academics_entry(aid, enrolment_status="In Progress", joining_date="2026-10-06", allocations=[
            allocation(track_code="NIT-CRS-018/T1", status="Moved", ended_on="2026-10-10", end_reason="Timing"),
            allocation(track_code="NIT-CRS-018/T1", lms_course_id="NIT-GNT-BAT-2026-000102", allocated_on="2026-10-10"),
            allocation(track_code="NIT-CRS-018/T2", joining_date="2026-10-06")])],
    })
    lms_pull.pull()
    rows = db.session.execute(select(BatchAllocation).where(BatchAllocation.admission_id == aid)
                              .order_by(BatchAllocation.track_code, BatchAllocation.lms_allocated_on)).scalars().all()
    assert [(r.track_code, r.batch.lms_course_id[-3:], r.status) for r in rows] == [
        ("NIT-CRS-018/T1", "101", "Moved"), ("NIT-CRS-018/T1", "102", "Active"), ("NIT-CRS-018/T2", "101", "Active")]


def test_curriculum_mapping_pending_then_mapped(client, people, course, fake_pull):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    fake_pull({"academics": [academics_entry(aid, curriculum_status="Mapping Pending", curriculum_version_label=None)]},
              {"academics": [academics_entry(aid, curriculum_version_label="CV 3.0")]})
    lms_pull.pull()
    assert fresh(Admission, aid).curriculum_status == "Mapping Pending"
    lms_pull.pull()
    assert fresh(Admission, aid).curriculum_status == "Mapped"
    # The LMS runs several versions of a course: mirrored ones don't take the CRM's one-published slot
    labels = db.session.execute(select(CurriculumVersion.version_label).where(CurriculumVersion.lms_mirrored)).scalars().all()
    assert labels == ["CV 3.0"]


# ---------------------------------------------------------------- §5.3 idempotent

def test_same_state_twice_writes_nothing(client, people, course, fake_pull):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    payload = {"batches": [batch_entry()], "academics": [academics_entry(
        aid, enrolment_status="Scheduled", allocations=[allocation()])],
        "admissions": [{"crm_admission_id": str(aid), "lms_status": "Active",
                        "lms_last_activity_at": "2026-10-01T10:00:00+05:30", "lms_last_synced_at": AS_OF}]}
    fake_pull(payload, payload)
    assert lms_pull.pull() == {"batches_applied": 1, "admissions_applied": 1, "academics_applied": 1}
    before = fresh(Admission, aid).updated_at
    assert lms_pull.pull() == {"batches_unchanged": 1, "admissions_unchanged": 1, "academics_unchanged": 1}
    assert fresh(Admission, aid).updated_at == before


# ---------------------------------------------------------------- §5.4 / 5.5 completion and certificates

def certificate(aid, pid, version=1, status="Issued", **overrides):
    return {"certificate_number": "NIT-CERT-2026-000007", "certificate_type": "Course Completion Certificate",
            "version": version, "status": status, "crm_admission_id": str(aid), "crm_person_id": str(pid),
            "course_code": "NIT-CRS-018", "enrolment_code": "ENR-000101", "holder_name": "Ravi Kumar",
            "issue_date": "2026-12-20", "issued_by_email": "ac@lms.test", "revoked_at": None,
            "revoked_by_email": None, "reason": None, "supersedes_version": None,
            "changed_at": "2026-12-20T10:00:00+05:30", **overrides}


def test_completion_and_certificate_register(client, people, course, fake_pull):
    flow = admitted(client, people, course)
    aid, pid = flow["admission"]["admission_id"], flow["admission"]["person"]["person_id"]
    coordinator = email_of(people["coordinator"]["id"])
    fake_pull(
        {"academics": [academics_entry(aid, enrolment_status="Completed", academic_completed_at="2026-12-19T17:00:00+05:30",
                                       completion_authorised_by_email=coordinator)],
         "certificates": [certificate(aid, pid)]},
        {"certificates": [certificate(aid, pid, 2, reason="Name spelling", supersedes_version=1,
                                      issue_date="2026-12-22"),
                          certificate(aid, pid, 1, "Superseded")]},           # out of order on purpose
        {"certificates": [certificate(aid, pid, 2, "Revoked", reason="Issued in error", supersedes_version=1,
                                      revoked_at="2026-12-23T11:00:00+05:30", revoked_by_email="sa@lms.test")]},
    )
    lms_pull.pull()
    admission = fresh(Admission, aid)
    assert admission.enrolment_status == "Completed" and admission.support_until is not None
    assert admission.completion_authorised_by == people["coordinator"]["id"]
    assert admission.completion_authorised_by_email == coordinator

    lms_pull.pull()
    lms_pull.pull()
    certs = db.session.execute(select(Certificate).where(Certificate.admission_id == aid)
                               .order_by(Certificate.version)).scalars().all()
    assert [(c.certificate_number, c.version, c.status) for c in certs] == [
        ("NIT-CERT-2026-000007", 1, "Superseded"), ("NIT-CERT-2026-000007", 2, "Revoked")]
    assert certs[1].reissue_reason is None and certs[1].revoke_reason == "Issued in error"
    assert certs[1].revoked_by is None and certs[1].revoked_by_email == "sa@lms.test"

    tab = call(client, "get", f"/students/{pid}/academic", people["coordinator"]["h"])
    assert "NIT-CERT-2026-000007" in str(tab)


# ---------------------------------------------------------------- §5.6 read-only in the CRM

def test_academic_writes_are_refused_while_the_lms_owns_them(client, people, course, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    for method, url, body, headers in [
        ("patch", f"/admissions/{aid}", {"lms_status": "Active"}, people["bm"]["h"]),
        ("post", "/batches", {"course_id": course, "branch_id": 1, "batch_name": "B", "start_date": "2026-11-01",
                              "capacity": 10}, people["coordinator"]["h"]),
        ("post", f"/admissions/{aid}/complete", {}, people["coordinator"]["h"]),
        ("post", f"/admissions/{aid}/certificates", {}, people["coordinator"]["h"]),
    ]:
        response = client.open(f"{API}{url}", method=method.upper(), json=body, headers=headers)
        assert (response.status_code, response.get_json()["error"]["code"]) == (409, "MANAGED_IN_LMS"), url
    # Other admission edits still work
    call(client, "patch", f"/admissions/{aid}", people["bm"]["h"], json={"handover_status": "Completed"})


# ---------------------------------------------------------------- §5.7 failures keep the watermark

def test_failed_pull_keeps_the_watermark(client, people, fake_pull):
    fake_pull({}, lms_delivery.Answer(503, {"error": {"message": "Down"}}), lms_delivery.Answer(None, None, "LMS unreachable"))
    lms_pull.pull()
    assert lms_pull.state().since == AS_OF
    assert lms_pull.pull() == {"error": "Down", "http": 503}
    assert lms_pull.pull()["error"] == "LMS unreachable"
    state = lms_pull.state()
    assert state.since == AS_OF and state.last_http_status is None and state.locked_until is None


def test_a_running_pull_is_not_started_twice(app, run_sql, fake_pull):
    run_sql("UPDATE lms_pull_state SET locked_until = now() + interval '5 minutes'")
    fake = fake_pull({})
    assert lms_pull.pull() == {"skipped": "another pull is running"} and fake.since == []


# ---------------------------------------------------------------- held records, LMS withdrawals

def test_allocation_to_an_unknown_batch_is_held_then_applied(client, people, course, fake_pull):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    fake_pull({"academics": [academics_entry(aid, enrolment_status="Scheduled", allocations=[allocation()])]},
              {"batches": [batch_entry()]})
    assert lms_pull.pull() == {"academics_held": 1}
    hold = db.session.get(LmsPullHold, f"academics:{aid}")
    assert "NIT-GNT-BAT-2026-000101 has not come from the LMS yet" in hold.reason
    assert lms_pull.state().since == AS_OF                      # the watermark still moves

    assert lms_pull.pull() == {"batches_applied": 1, "retried_applied": 1}
    assert db.session.get(LmsPullHold, f"academics:{aid}", populate_existing=True) is None
    assert fresh(Admission, aid).enrolment_status == "Scheduled"


def test_lms_withdrawal_asks_the_branch_manager(client, people, course, fake_pull):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    fake_pull({"academics": [academics_entry(aid, enrolment_status="Cancelled")]})
    lms_pull.pull()
    assert fresh(Admission, aid).enrolment_status == "Awaiting Batch Allocation"   # cancelling stays a CRM decision
    task = db.session.execute(select(Task).where(Task.dedupe_key == f"lms-withdrawn:{aid}")).scalar_one()
    assert "cancel the admission" in task.title


# ---------------------------------------------------------------- pause / resume

def test_pause_and_resume_reach_the_lms(client, people, course):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    assert client.post(f"{API}/admissions/{aid}/pause", json={"reason": "Exams"},
                       headers=people["coordinator"]["h"]).status_code == 403
    paused = call(client, "post", f"/admissions/{aid}/pause", people["bm"]["h"], json={"reason": "Exams"})
    assert paused["enrolment_status"] == "Paused"
    resumed = call(client, "post", f"/admissions/{aid}/resume", people["bm"]["h"], json={})
    assert resumed["enrolment_status"] == "Awaiting Batch Allocation"
    assert client.post(f"{API}/admissions/{aid}/resume", json={}, headers=people["bm"]["h"]).status_code == 422

    sent = db.session.execute(select(LmsOutbox.payload).where(LmsOutbox.record_key == f"admission:{aid}",
                                                              LmsOutbox.event_type == "AdmissionUpdated")
                              .order_by(LmsOutbox.outbox_id)).scalars().all()
    assert [p["status"] for p in sent] == ["Paused", "Active"]


def test_deferred_is_refused(client, people, course, run_sql):
    from sqlalchemy.exc import IntegrityError

    aid = admitted(client, people, course)["admission"]["admission_id"]
    with pytest.raises(IntegrityError, match="admissions_no_deferred"):
        run_sql("UPDATE admissions SET enrolment_status = 'Deferred' WHERE admission_id = :a", a=aid)
