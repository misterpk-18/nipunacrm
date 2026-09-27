"""Steps 5 and 6: pipeline board / table, and demos."""
from sqlalchemy import select

from config.database import db
from models import Demo, Lead, Task
from tests.helpers import API, call, create_lead, future


def move(client, headers, lead_id, stage):
    return call(client, "post", f"/leads/{lead_id}/stage", headers, json={"stage": stage})


# ---------------------------------------------------------------- pipeline

def test_pipeline_board_counts_cards_and_scope(client, people, course):
    sravani = people["sravani"]["h"]
    a = create_lead(client, sravani, course_id=course)
    b = create_lead(client, people["bm"]["h"], person={"full_name": "Vamsi", "phone": "9123456789"})
    create_lead(client, people["mounika"]["h"], branch_id=2, person={"full_name": "Karthik", "phone": "9111111111"})
    move(client, sravani, a["lead_id"], "Counselling")

    board = call(client, "get", "/pipeline", sravani)
    assert [s["stage"] for s in board["stages"]][:2] == ["New Enquiry", "Counselling"]
    assert len(board["stages"]) == 8 and board["total"] == 2
    counts = {s["stage"]: s["count"] for s in board["stages"]}
    assert counts["New Enquiry"] == 1 and counts["Counselling"] == 1
    assert board["stages"][1]["leads"][0]["lead_code"] == a["lead_code"]

    mine = call(client, "get", "/pipeline?owner_id=me", sravani)
    assert mine["total"] == 1
    assert call(client, "get", "/pipeline?owner_id=unassigned", sravani)["total"] == 1
    assert call(client, "get", "/pipeline", people["admin"]["h"])["total"] == 3

    table = client.get(f"{API}/pipeline?view=table", headers=sravani).get_json()
    assert [row["lead_code"] for row in table["data"]] == [b["lead_code"], a["lead_code"]]  # stage order
    assert table["meta"]["total"] == 2
    assert client.get(f"{API}/pipeline", headers=people["accounts"]["h"]).status_code == 403
    assert client.get(f"{API}/pipeline?view=grid", headers=sravani).status_code == 400


def test_stage_change_to_admitted_reports_missing(client, people):
    lead = create_lead(client, people["sravani"]["h"])
    response = client.post(f"{API}/leads/{lead['lead_id']}/stage", json={"stage": "Admitted"}, headers=people["sravani"]["h"])
    assert response.status_code == 422
    assert response.get_json()["error"]["details"] == {"missing_fields": ["admission"]}


# ---------------------------------------------------------------- demos

def book(client, headers, lead_id, expected=201, **body):
    return call(client, "post", f"/leads/{lead_id}/demos", headers, expected, json={"scheduled_at": future(48), **body})


def set_past(run_sql, demo_id, hours=2):
    run_sql("UPDATE demos SET scheduled_at = now() - make_interval(hours => :h) WHERE demo_id = :id", h=hours, id=demo_id)


def outcome_body(**overrides):
    return {"status": "Attended", "student_feedback": "Liked the projects", "trainer_feedback": "Good basics",
            "rating": 4, "outcome": "Interested — fee discussion", "next_action": "Fee discussion",
            "next_follow_up_at": future(3), **overrides}


def test_booking_moves_lead_and_creates_reminders(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)

    demo = book(client, sravani, lead["lead_id"], trainer_user_id=people["trainer"]["id"])
    assert demo["demo_code"] == "DM-GNT-0001" and demo["status"] == "Scheduled"
    assert demo["duration_minutes"] == 45 and demo["trainer"]["full_name"] == "Trainer G1"
    assert {r["reminder_type"]: r["state"] for r in demo["reminders"]} == {
        "Booking confirmation": "Pending", "24h student reminder": "Pending", "1h student + trainer reminder": "Pending"}
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["stage"] == "Demo Scheduled"

    soon = book(client, sravani, lead["lead_id"], scheduled_at=future(3))
    assert {r["reminder_type"]: r["state"] for r in soon["reminders"]}["24h student reminder"] == "Skipped"


def test_booking_validation(client, people, course, make_user):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    vij_trainer = make_user(roles=[("TRAINER", 2)])

    book(client, sravani, lead["lead_id"], 400, trainer_user_id=vij_trainer.user_id)
    book(client, sravani, lead["lead_id"], 400, scheduled_at="2020-01-01T10:00:00+05:30")
    too_long = client.post(f"{API}/leads/{lead['lead_id']}/demos", headers=sravani,
                           json={"scheduled_at": future(), "demo_type": "Standard", "duration_minutes": 60})
    assert too_long.status_code == 422
    assert book(client, sravani, lead["lead_id"], demo_type="Practical")["duration_minutes"] == 60
    assert client.post(f"{API}/leads/{lead['lead_id']}/demos", headers=people["mounika"]["h"],
                       json={"scheduled_at": future()}).status_code == 404
    no_course = create_lead(client, sravani, person={"full_name": "No Course", "phone": "9000000301"})
    assert book(client, sravani, no_course["lead_id"])["course"] is None  # a course is optional
    book(client, sravani, no_course["lead_id"], 400, course_id=999999)


def test_protected_stage_is_not_moved_by_booking(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    move(client, sravani, lead["lead_id"], "Payment Pending Verification")
    book(client, sravani, lead["lead_id"])
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["stage"] == "Payment Pending Verification"


def test_confirm_reschedule_cancel(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    demo = book(client, sravani, lead["lead_id"])

    assert call(client, "post", f"/demos/{demo['demo_id']}/confirm", sravani)["status"] == "Confirmed"
    assert client.post(f"{API}/demos/{demo['demo_id']}/reschedule", json={"scheduled_at": future(72)},
                       headers=sravani).status_code == 400
    new = call(client, "post", f"/demos/{demo['demo_id']}/reschedule", sravani, 201,
               json={"scheduled_at": future(72), "reason": "Trainer unavailable"})
    assert new["rescheduled_from_demo_id"] == demo["demo_id"] and new["status"] == "Scheduled"
    old = call(client, "get", f"/demos/{demo['demo_id']}", sravani)
    assert old["status"] == "Rescheduled" and old["reschedule_reason"] == "Trainer unavailable"
    assert {r["state"] for r in old["reminders"]} == {"Superseded"}
    assert client.post(f"{API}/demos/{demo['demo_id']}/cancel", json={"reason": "Other"}, headers=sravani).status_code == 422

    assert client.post(f"{API}/demos/{new['demo_id']}/cancel", json={}, headers=sravani).status_code == 400
    cancelled = call(client, "post", f"/demos/{new['demo_id']}/cancel", sravani, json={"reason": "Course changed"})
    assert cancelled["status"] == "Cancelled"
    reminders = call(client, "get", f"/demos/{new['demo_id']}/reminders", sravani)
    assert {r["state"] for r in reminders} == {"Cleared"}


def test_outcome_moves_lead_and_creates_commercial_follow_up(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    demo = book(client, sravani, lead["lead_id"], trainer_user_id=people["trainer"]["id"])

    early = client.post(f"{API}/demos/{demo['demo_id']}/outcome", json=outcome_body(), headers=people["trainer"]["h"])
    assert early.status_code == 422
    set_past(run_sql, demo["demo_id"])
    assert client.post(f"{API}/demos/{demo['demo_id']}/outcome", json=outcome_body(next_follow_up_at=None),
                       headers=people["trainer"]["h"]).status_code == 400

    done = call(client, "post", f"/demos/{demo['demo_id']}/outcome", people["trainer"]["h"], json=outcome_body())
    assert done["status"] == "Attended" and done["commercial_follow_up_due_at"] is not None
    assert done["commercial_owner"]["full_name"] == "Sravani"
    assert {r["state"] for r in done["reminders"]} == {"Not needed"}
    lead_now = call(client, "get", f"/leads/{lead['lead_id']}", sravani)
    assert lead_now["stage"] == "Demo Attended" and lead_now["next_follow_up_at"] is not None

    task = db.session.execute(select(Task).where(Task.dedupe_key == f"demo-follow-up:{demo['demo_id']}")).scalar_one()
    assert task.task_type.code == "CALL" and task.owner_user_id == people["sravani"]["id"]
    assert task.original_due_at == db.session.get(Demo, demo["demo_id"]).commercial_follow_up_due_at

    listed = client.get(f"{API}/demos?lead_id={lead['lead_id']}", headers=sravani).get_json()["data"]
    assert listed[0]["attended_demos"] == "1 of 2"
    assert client.post(f"{API}/demos/{demo['demo_id']}/outcome", json=outcome_body(),
                       headers=sravani).status_code == 422  # already recorded


def test_no_show_keeps_stage_and_protected_leads_never_move(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    demo = book(client, sravani, lead["lead_id"])
    set_past(run_sql, demo["demo_id"])
    call(client, "post", f"/demos/{demo['demo_id']}/outcome", sravani,
         json=outcome_body(status="No Show", outcome="No-show — reschedule attempt"))
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["stage"] == "Demo Scheduled"

    second = book(client, sravani, lead["lead_id"])
    move(client, sravani, lead["lead_id"], "Payment Pending Verification")
    set_past(run_sql, second["demo_id"])
    call(client, "post", f"/demos/{second['demo_id']}/outcome", sravani, json=outcome_body())
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["stage"] == "Payment Pending Verification"


def test_third_demo_after_two_attended_needs_approval(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    for _ in range(2):
        demo = book(client, sravani, lead["lead_id"])
        set_past(run_sql, demo["demo_id"])
        call(client, "post", f"/demos/{demo['demo_id']}/outcome", sravani, json=outcome_body())

    blocked = client.post(f"{API}/leads/{lead['lead_id']}/demos", json={"scheduled_at": future()}, headers=sravani)
    assert blocked.status_code == 422 and "needs Academic Coordinator or Branch Manager approval" in blocked.get_json()["error"]["message"]
    # naming an approver who isn't one doesn't work either
    book(client, sravani, lead["lead_id"], 422, extra_demo_approved_by=people["nikhil"]["id"])
    approved = book(client, sravani, lead["lead_id"], extra_demo_approved_by=people["coordinator"]["id"])
    assert approved["extra_demo_approved_by"] == people["coordinator"]["id"]
    by_bm = book(client, people["bm"]["h"], lead["lead_id"])  # a branch manager booking approves it themselves
    assert by_bm["extra_demo_approved_by"] == people["bm"]["id"]


def test_approve_extra_and_confirm(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    pending = book(client, sravani, lead["lead_id"])
    for _ in range(2):
        demo = book(client, sravani, lead["lead_id"])
        set_past(run_sql, demo["demo_id"])
        call(client, "post", f"/demos/{demo['demo_id']}/outcome", sravani, json=outcome_body())

    assert client.post(f"{API}/demos/{pending['demo_id']}/confirm", headers=sravani).status_code == 422
    assert client.post(f"{API}/demos/{pending['demo_id']}/approve-extra", headers=sravani).status_code == 403
    call(client, "post", f"/demos/{pending['demo_id']}/approve-extra", people["coordinator"]["h"])
    assert call(client, "post", f"/demos/{pending['demo_id']}/confirm", sravani)["status"] == "Confirmed"


def test_demo_list_filters_and_scope(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    demo = book(client, sravani, lead["lead_id"], trainer_user_id=people["trainer"]["id"])

    assert len(client.get(f"{API}/demos?trainer_id={people['trainer']['id']}", headers=sravani).get_json()["data"]) == 1
    assert client.get(f"{API}/demos?status=Attended", headers=sravani).get_json()["data"] == []
    assert client.get(f"{API}/demos", headers=people["trainer"]["h"]).status_code == 200
    assert client.get(f"{API}/demos/{demo['demo_id']}", headers=people["mounika"]["h"]).status_code == 404
    assert client.get(f"{API}/demos", headers=people["accounts"]["h"]).status_code == 403
    patched = call(client, "patch", f"/demos/{demo['demo_id']}", sravani, json={"mode": "Online", "meeting_link": "https://meet.test/x"})
    assert patched["mode"] == "Online"
    assert client.patch(f"{API}/demos/{demo['demo_id']}", json={}, headers=sravani).status_code == 400
    assert db.session.get(Lead, lead["lead_id"]).stage == "Demo Scheduled"
