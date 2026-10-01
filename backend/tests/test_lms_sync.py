"""LMS outbox (db 026): events written with the change, source versions, delivery to the LMS and the backfill."""
from sqlalchemy import select, text

from config.database import db
from models import LmsOutbox, Task
from services import lms_delivery, lms_finance, lms_sync
from services import reports as reports_service
from tests.helpers import admitted, backdate_installment, call, record_payment

LMS_COURSE = {"course_title": "Java Full Stack Developer", "category": "Software Development", "standard_fee": "25000"}


def rows(record_key=None):
    stmt = select(LmsOutbox).order_by(LmsOutbox.outbox_id)
    if record_key:
        stmt = stmt.where(LmsOutbox.record_key == record_key)
    return db.session.execute(stmt).scalars().all()


def types(record_key=None):
    return [(r.event_type, r.source_version) for r in rows(record_key)]


class FakeLms:
    """Stands in for the LMS: answers per event (default 201 Applied) and keeps every body it received."""

    def __init__(self, answers=None):
        self.answers = answers or (lambda body: None)
        self.received = []

    def __call__(self, envelope):
        self.received.append(envelope)
        answer = self.answers(envelope)
        if answer is not None:
            return answer
        token = "raw-token" if envelope["event_type"] == "AdmissionQualified" else None
        return lms_delivery.Answer(201, {"data": {"status": "Applied", "result": {"ok": True}, "replayed": False,
                                                  "activation_token": token}})


def error(status, message="Nope", details=None):
    return lms_delivery.Answer(status, {"error": {"code": "X", "message": message, "details": details}})


# ---------------------------------------------------------------- events written with the change

def test_verification_writes_admission_and_finance_events(client, people, course):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    assert types(f"admission:{aid}") == [("AdmissionQualified", 1), ("FinanceSummaryUpdated", 1)]

    qualified, finance = rows(f"admission:{aid}")
    person, adm = qualified.payload["person"], qualified.payload["admission"]
    assert person["crm_person_id"] == flow["admission"]["person"]["person_id"]
    assert person["preferred_language"] == "English" and person["phone"].startswith("+91")
    assert adm["crm_admission_id"] == aid and adm["course_code"] == "NIT-CRS-018"
    assert (adm["original_branch_code"], adm["service_branch_code"], adm["collecting_branch_code"]) == ("NIT-GNT",) * 3
    assert adm["delivery_mode"] == "Classroom" and adm["seat_type"] == "Confirmed Seat"

    data = finance.payload
    assert (data["fee_total"], data["verified_paid"], data["balance"], data["payment_completion"]) == \
        ("30000.00", "30000.00", "0.00", "Paid")
    assert data["invoice_numbers"] == [flow["invoice"]["invoice_number"]]
    assert data["receipts"] == [{"receipt_number": flow["verified"]["receipt_number"],
                                 "date": flow["verified"]["payment_date"], "amount": "30000.00"}]
    assert data["installments"][0]["due_position"] == "Paid" and data["next_due_date"] is None


def test_part_payment_then_changes_bump_versions(client, people, course):
    flow = admitted(client, people, course, plan="TWO_INSTALMENTS", amount="15000")
    aid = flow["admission"]["admission_id"]
    finance = rows(f"admission:{aid}")[-1].payload
    assert finance["balance"] == "15000.00" and finance["payment_completion"] == "Part Paid"
    assert finance["next_due_amount"] == "15000.00" and len(finance["installments"]) == 2

    # A new claim counts as pending verification → the summary is sent again
    record_payment(client, people["sravani"]["h"], flow["invoice"]["invoice_id"], "5000")
    last = rows(f"admission:{aid}")[-1]
    assert (last.event_type, last.source_version, last.payload["pending_verification"]) == \
        ("FinanceSummaryUpdated", 2, "5000.00")

    call(client, "post", f"/admissions/{aid}/transfers", people["bm"]["h"], 201, json={"to_branch_id": 2, "reason": "Moved"})
    last = rows(f"admission:{aid}")[-1]
    assert (last.event_type, last.source_version) == ("AdmissionUpdated", 2)
    assert last.payload == {"crm_admission_id": aid, "service_branch_code": "NIT-VIJ"}

    call(client, "patch", f"/admissions/{aid}", people["bm_vij"]["h"], json={"delivery_mode": "Online"})
    assert rows(f"admission:{aid}")[-1].payload == {"crm_admission_id": aid, "delivery_mode": "Online"}

    call(client, "post", f"/admissions/{aid}/cancel", people["bm_vij"]["h"], json={"reason": "Dropped out"})
    assert types(f"admission:{aid}")[-2:] == [("AdmissionCancelled", 4), ("FinanceSummaryUpdated", 3)]
    assert rows(f"admission:{aid}")[-2].payload == {"crm_admission_id": aid, "reason": "Dropped out"}

    # A cancelled admission is not refreshed any more when the person is edited
    count = len(rows())
    call(client, "patch", f"/persons/{flow['admission']['person']['person_id']}", people["sravani"]["h"],
         json={"full_name": "Renamed Student"})
    assert len(rows()) == count


def test_person_edit_resends_the_admission(client, people, course):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    call(client, "patch", f"/persons/{flow['admission']['person']['person_id']}", people["sravani"]["h"],
         json={"full_name": "Anvitha K."})
    last = rows(f"admission:{aid}")[-1]
    assert (last.event_type, last.source_version) == ("AdmissionQualified", 2)
    assert last.payload["person"]["full_name"] == "Anvitha K."


def test_course_master_events(client, people):
    admin = people["admin"]["h"]
    created = call(client, "post", "/courses", admin, 201, json={"course_code": "NIT-CRS-990", **LMS_COURSE})
    call(client, "patch", f"/courses/{created['course_id']}", admin, json={"status": "Inactive"})
    key = f"course:{created['course_id']}"
    assert types(key) == [("CourseUpserted", 1), ("CourseUpserted", 2)]
    assert rows(key)[-1].payload == {"course_code": "NIT-CRS-990", "course_title": "Java Full Stack Developer",
                                     "category": "Software Development", "is_combo": False, "status": "Inactive"}


def test_rolled_back_transaction_writes_nothing(app):
    lms_sync.admission_cancelled(1, "never happened")
    db.session.rollback()
    db.session.commit()
    assert rows() == []


def test_envelope_is_fixed_once_written(client, people, course, run_sql):
    admitted(client, people, course)
    outbox_id = rows()[0].outbox_id
    try:
        run_sql("UPDATE lms_outbox SET payload = '{}' WHERE outbox_id = :id", id=outbox_id)
        raise AssertionError("the envelope guard should refuse")
    except Exception as exc:  # noqa: BLE001 - the trigger's check_violation
        db.session.rollback()
        assert "can't be changed once written" in str(exc)


# ---------------------------------------------------------------- delivery

def test_delivery_marks_rows_and_never_stores_the_token(client, people, course, monkeypatch):
    admitted(client, people, course)
    lms = FakeLms()
    monkeypatch.setattr(lms_delivery, "post_event", lms)
    assert lms_delivery.deliver() == {"delivered": 1}  # one row per admission per run: qualified first
    assert lms_delivery.deliver() == {"delivered": 1}
    qualified, finance = rows()
    assert (qualified.status, finance.status) == ("Delivered", "Delivered")
    assert qualified.activation_token_issued and "raw-token" not in str(qualified.response_result)
    assert qualified.response_status == "Applied" and qualified.delivered_at is not None
    assert [b["event_type"] for b in lms.received] == ["AdmissionQualified", "FinanceSummaryUpdated"]
    body = lms.received[0]
    assert body["event_id"] == str(qualified.event_id) and body["source_version"] == 1
    assert body["occurred_at"].endswith("+05:30") and body["data"] == qualified.payload


def test_waiting_row_blocks_only_its_own_admission(client, people, course, monkeypatch, run_sql):
    first = admitted(client, people, course)["admission"]["admission_id"]
    second = admitted(client, people, course)["admission"]["admission_id"]
    lms = FakeLms(lambda body: error(422, "Unknown course 'NIT-CRS-018'")
                  if body["data"].get("admission", {}).get("crm_admission_id") == first else None)
    monkeypatch.setattr(lms_delivery, "post_event", lms)

    assert lms_delivery.deliver() == {"retry": 1, "delivered": 1}
    assert lms_delivery.deliver() == {"delivered": 1}  # the second admission's finance; the first waits (backoff)
    waiting = rows(f"admission:{first}")
    assert [r.status for r in waiting] == ["Pending", "Pending"]
    assert waiting[0].attempts == 1 and "Unknown course" in waiting[0].last_error
    assert [r.status for r in rows(f"admission:{second}")] == ["Delivered", "Delivered"]

    # Due again: the same event is sent, byte for byte
    run_sql("UPDATE lms_outbox SET next_attempt_at = now() - interval '1 minute' WHERE outbox_id = :id",
            id=waiting[0].outbox_id)
    lms.answers = lambda body: None
    assert lms_delivery.deliver() == {"delivered": 1}
    retried = [b for b in lms.received if b["event_id"] == str(waiting[0].event_id)]
    assert len(retried) == 2 and retried[0] == retried[1]


def test_bad_payload_fails_with_a_task_and_401_stops(client, people, course, monkeypatch):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    monkeypatch.setattr(lms_delivery, "post_event",
                        FakeLms(lambda body: error(400, "Invalid request data", {"person.mobile": ["Not valid"]})))
    assert lms_delivery.deliver() == {"failed": 1}
    failed = rows(f"admission:{aid}")[0]
    assert failed.status == "Failed" and 'person.mobile' in failed.last_error and failed.last_http_status == 400
    task = db.session.execute(select(Task).where(Task.dedupe_key == f"lms-sync-failed:{failed.outbox_id}")).scalar_one()
    assert "AdmissionQualified" in task.title

    monkeypatch.setattr(lms_delivery, "post_event", FakeLms(lambda body: error(401, "Invalid service key")))
    assert lms_delivery.deliver() == {"stop": 1}
    finance = rows(f"admission:{aid}")[1]
    assert finance.status == "Pending" and finance.attempts == 0 and "LMS_SERVICE_KEY" in finance.last_error

    assert lms_delivery.requeue([failed.outbox_id]) == 1
    assert rows(f"admission:{aid}")[0].status == "Pending"


def test_unreachable_lms_stops_the_run(client, people, course, monkeypatch):
    admitted(client, people, course)
    admitted(client, people, course)
    monkeypatch.setattr(lms_delivery, "post_event", FakeLms(lambda body: lms_delivery.Answer(None, None, "LMS unreachable: refused")))
    assert lms_delivery.deliver() == {"stop": 1, "not_attempted": 1}
    assert [r.attempts for r in rows() if r.event_type == "AdmissionQualified"] == [1, 0]


def test_not_configured_keeps_rows_pending(app, client, people, course):
    admitted(client, people, course)
    app.config["LMS_BASE_URL"] = None
    assert lms_delivery.deliver()["pending"] == 2


# ---------------------------------------------------------------- backfill

def test_backfill_is_resumable(app, client, people, course):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    db.session.execute(text("DELETE FROM lms_outbox"))
    db.session.commit()

    counts = lms_sync.backfill()
    assert counts["CourseUpserted"] >= 1 and counts["AdmissionQualified"] == 1 and counts["FinanceSummaryUpdated"] == 1
    # versions continue from the live events already counted for this admission
    assert types(f"admission:{aid}") == [("AdmissionQualified", 2), ("FinanceSummaryUpdated", 2)]
    again = lms_sync.backfill()
    assert again["AdmissionQualified"] == 0
    assert again["skipped"] == counts["BranchUpserted"] + counts["CourseUpserted"] + 2


def test_backfill_sends_branches_first(app):
    counts = lms_sync.backfill(branches_only=True)
    assert counts["BranchUpserted"] == 2 and counts["CourseUpserted"] == 0
    first = rows()[0]
    assert (first.event_type, first.record_key) == ("BranchUpserted", "branch:1")
    assert first.payload["branch_code"] == "NIT-GNT" and first.payload["receipt_prefix"] == "GNT"
    assert lms_sync.backfill(branches_only=True)["skipped"] == 2


# ---------------------------------------------------------------- branches and the finance snapshot (db 029)

def test_branch_edit_sends_branch_upserted(client, people):
    admin = people["admin"]["h"]
    call(client, "patch", "/branches/1", admin, json={"phone": "0863-2345678"})
    assert rows("branch:1") == []  # the LMS doesn't keep the phone
    call(client, "patch", "/branches/1", admin, json={"city": "Guntur City", "email": "guntur@nipunacareers.com"})
    assert types("branch:1") == [("BranchUpserted", 1)]
    payload = rows("branch:1")[0].payload
    assert payload == {"branch_code": "NIT-GNT", "branch_name": payload["branch_name"], "city": "Guntur City",
                       "receipt_prefix": "GNT", "email": "guntur@nipunacareers.com", "is_active": True}


def snapshot(branch_id=1):
    return rows(f"branch-finance:{branch_id}")[-1].payload


def test_finance_snapshot_without_a_target(client, people, course, run_sql):
    flow = admitted(client, people, course, plan="TWO_INSTALMENTS", amount="15000")
    invoice_id = flow["invoice"]["invoice_id"]
    backdate_installment(run_sql, invoice_id, 2, 10)
    record_payment(client, people["sravani"]["h"], invoice_id, "2000")

    assert lms_finance.send_snapshots() == {"written": 2, "not_due": 0, "superseded": 0, "pruned": 0}
    data = snapshot()
    assert data["branch_code"] == "NIT-GNT" and data["as_of"].endswith("+05:30")
    month = reports_service.period_range("This Month")
    assert data["period"] == {"label": f"{month[0]:%b %Y}", "start": month[0].isoformat(), "end": month[1].isoformat()}
    assert data["collections"] == {"verified": "15000.00", "target": None}
    assert data["paid_admissions"] == {"count": 1, "target": None}
    assert data["overdue"]["count"] == 1 and data["overdue"]["by_age_band"][0]["band"] == "8–15 days"
    assert data["overdue"]["amount"] == data["overdue"]["by_age_band"][0]["amount"]
    verifications = data["verifications"]
    assert (verifications["pending_count"], verifications["pending_amount"], verifications["overdue_count"]) == \
        (1, "2000.00", 0)
    assert verifications["oldest_at"] is not None
    assert set(data["followups"]) == {"overdue_count", "broken_promises"}
    assert snapshot(2)["paid_admissions"]["count"] == 0  # every active branch gets one


def test_finance_snapshot_with_an_approved_target(app, people, run_sql):
    version_id = run_sql(
        "INSERT INTO target_versions (period_start, period_end) VALUES (date_trunc('month', current_date)::date, "
        "(date_trunc('month', current_date) + interval '1 month - 1 day')::date) RETURNING target_version_id").scalar_one()
    run_sql("INSERT INTO target_lines (target_version_id, branch_id, verified_collections_target, paid_admissions_target) "
            "VALUES (:v, 1, 500000, 40), (:v, NULL, 900000, 70)", v=version_id)
    run_sql("UPDATE target_versions SET status = 'Approved', approved_by = :u, approved_at = now() "
            "WHERE target_version_id = :v", u=people["admin"]["id"], v=version_id)

    lms_finance.send_snapshots(force=True)
    data = snapshot()
    assert data["period"]["start"].endswith("-01") and len(data["period"]["label"]) == 8  # e.g. "Oct 2026"
    assert data["collections"]["target"] == "500000.00" and data["paid_admissions"]["target"] == 40
    other = snapshot(2)  # no line for Vijayawada: the version's period, no targets
    assert other["period"] == data["period"] and other["collections"]["target"] is None
    assert other["paid_admissions"]["target"] is None


def test_finance_snapshot_supersedes_an_unsent_one(app, monkeypatch):
    lms_finance.send_snapshots()
    assert lms_finance.send_snapshots() == {"written": 0, "not_due": 2, "superseded": 0, "pruned": 0}  # 15 minutes
    assert lms_finance.send_snapshots(force=True)["superseded"] == 2
    assert [(r.status, r.source_version) for r in rows("branch-finance:1")] == [("Superseded", 1), ("Pending", 2)]

    lms = FakeLms()
    monkeypatch.setattr(lms_delivery, "post_event", lms)
    assert lms_delivery.deliver() == {"delivered": 2}
    assert [b["source_version"] for b in lms.received] == [2, 2]


def test_finance_snapshot_waits_for_lms_configuration(app):
    app.config["LMS_BASE_URL"] = None
    assert "skipped" in lms_finance.send_snapshots() and rows() == []
