"""Steps 5 and 6: pipeline board / table, and demos."""
from sqlalchemy import select

from config.database import db
from models import Demo, Lead, Task
from models import LostReason
from tests.helpers import API, admitted, call, convert_lead, create_deal, create_lead, error_of, future, lookup_id


def move(client, headers, lead_id, stage):
    return call(client, "post", f"/leads/{lead_id}/stage", headers, json={"stage": stage})


# ---------------------------------------------------------------- pipeline

def test_pipeline_board_counts_cards_and_scope(client, people, course):
    sravani = people["sravani"]["h"]
    a = create_deal(client, sravani, course_id=course)
    b = create_deal(client, people["bm"]["h"], person={"full_name": "Vamsi", "phone": "9123456789"})
    create_deal(client, people["mounika"]["h"], branch_id=2, person={"full_name": "Karthik", "phone": "9111111111"})
    create_lead(client, sravani, person={"full_name": "Still New", "phone": "9222222222"})  # stays a lead
    move(client, people["bm"]["h"], b["lead_id"], "Demo Scheduled")

    board = call(client, "get", "/pipeline", sravani)
    assert [c["label"] for c in board["chips"]] == [
        "Counselling", "Demo scheduled", "Demo attended", "Fee discussion", "Payment review", "Admitted", "Closed lost"]
    counts = {c["stage"]: c["count"] for c in board["chips"]}
    assert counts["Counselling"] == 1 and counts["Demo Scheduled"] == 1 and counts["Admitted"] == 0
    assert [col["label"] for col in board["columns"]] == ["Counselling", "Demo", "Fee discussion", "Payment review"]
    assert board["columns"][1]["stages"] == ["Demo Scheduled", "Demo Attended"] and board["columns"][1]["count"] == 1
    assert board["total"] == 2 and board["stats"]["open_opportunities"] == 2
    # value = standard fees until a version is approved: Data Science ₹30,000 + Foundation ₹20,000
    assert board["stats"]["open_value"] == "50000.00"
    card = board["columns"][0]["cards"][0]
    assert card["person"]["full_name"] == "Ananya Rao" and card["entry_code"].startswith("PL-GNT-")
    assert [row["lead_code"] for row in card["courses"]] == [a["lead_code"]]
    assert card["value"] == "30000.00" and card["delivery_plan_status"] == "Delivery plan needed"
    assert card["courses"][0]["price_basis"] == "Standard fee"

    # Clicking a chip filters the board
    only_demo = call(client, "get", "/pipeline?stage=Demo Scheduled", sravani)
    assert [col["key"] for col in only_demo["columns"]] == ["demo"] and only_demo["stage"] == "Demo Scheduled"
    lost = call(client, "get", "/pipeline?stage=Lost - closed", sravani)
    assert [col["key"] for col in lost["columns"]] == ["lost"] and lost["columns"][0]["cards"] == []
    assert client.get(f"{API}/pipeline?stage=New Enquiry", headers=sravani).status_code == 400

    mine = call(client, "get", "/pipeline?owner_id=me", sravani)
    assert mine["total"] == 1
    assert call(client, "get", "/pipeline?owner_id=unassigned", sravani)["total"] == 1
    assert call(client, "get", "/pipeline?q=vamsi", sravani)["total"] == 1
    assert call(client, "get", f"/pipeline?course_id={course}", sravani)["total"] == 1
    assert card["expected_close_date"] is None
    assert call(client, "get", "/pipeline", people["admin"]["h"])["total"] == 3
    assert call(client, "get", "/pipeline?branch_id=2", people["admin"]["h"])["total"] == 1

    table = client.get(f"{API}/pipeline?view=table", headers=sravani).get_json()
    assert [row["courses"][0]["lead_code"] for row in table["data"]] == [a["lead_code"], b["lead_code"]]  # stage order
    assert table["meta"]["total"] == 2 and table["data"][0]["value"] == "30000.00"
    assert client.get(f"{API}/pipeline", headers=people["accounts"]["h"]).status_code == 403
    assert client.get(f"{API}/pipeline?view=grid", headers=sravani).status_code == 400


def test_closed_chips_and_next_actions(client, people, course):
    from tests.helpers import accept_delivery_plan, admitted, create_invoice, record_payment

    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    admitted(client, people, course)                                           # an Admitted card (all-time chip)
    plan_needed = create_deal(client, sravani, person={"full_name": "Plan Needed", "phone": "9000000601"})
    demo = create_deal(client, sravani, person={"full_name": "Demo Booked", "phone": "9000000602"})
    call(client, "post", f"/leads/{demo['lead_id']}/demos", sravani, 201, json={"scheduled_at": future(48)})
    def approved_deal(name, phone):
        lead = create_deal(client, sravani, course_id=course, person={"full_name": name, "phone": phone})
        disc = call(client, "post", f"/leads/{lead['lead_id']}/fee-discussions", sravani, 201, json={})
        ver = call(client, "post", f"/fee-discussions/{disc['fee_discussion_id']}/versions", sravani, 201, json={})
        call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", sravani)
        accept_delivery_plan(client, sravani, lead["lead_id"])
        return lead

    approved_deal("Ready To Bill", "9000000603")
    paying = approved_deal("Paying Now", "9000000604")
    invoice = create_invoice(client, sravani, [paying["lead_id"]])
    record_payment(client, sravani, invoice["invoice_id"], "2000")
    create_deal(client, people["mounika"]["h"], branch_id=2, person={"full_name": "Other Branch", "phone": "9000000605"})

    board = call(client, "get", "/pipeline", bm)
    counts = {c["stage"]: c["count"] for c in board["chips"]}
    assert counts["Admitted"] == 1 and board["stats"]["admitted"] == 1
    admitted_col = call(client, "get", "/pipeline?stage=Admitted", bm)["columns"]
    assert admitted_col[0]["key"] == "admitted" and admitted_col[0]["cards"][0]["courses"][0]["price_basis"] == "Admitted fee"

    actions = call(client, "get", "/pipeline/next-actions", bm)
    by_person = {a["person"]["full_name"]: a["action"] for a in actions}
    assert by_person == {"Paying Now": "review_payment", "Demo Booked": "record_demo_outcome",
                         "Plan Needed": "confirm_delivery_plan", "Ready To Bill": "prepare_invoice"}
    assert [a["action"] for a in actions] == ["review_payment", "record_demo_outcome", "confirm_delivery_plan",
                                             "prepare_invoice"]
    assert next(a for a in actions if a["action"] == "review_payment")["invoice"]["invoice_id"] == invoice["invoice_id"]
    assert all(a["branch"]["branch_id"] == 1 for a in actions)
    assert [a["person"]["full_name"] for a in call(client, "get", "/pipeline/next-actions", people["mounika"]["h"])] == [
        "Other Branch"]
    assert plan_needed["lead_id"] in {a["lead_id"] for a in actions}


def test_leads_list_shows_active_leads_only(client, people):
    sravani = people["sravani"]["h"]
    a = create_deal(client, sravani)
    b = create_lead(client, sravani, person={"full_name": "Vamsi", "phone": "9123456789"})
    assert a["lead_status"] == "Inactive" and a["pipeline_entry_id"] is not None

    codes = lambda url: [row["lead_code"] for row in call(client, "get", url, sravani)]  # noqa: E731
    assert codes("/leads") == [b["lead_code"]]
    assert codes("/leads?lead_status=Inactive") == [a["lead_code"]]
    assert set(codes("/leads?lead_status=All")) == {a["lead_code"], b["lead_code"]}
    assert codes("/leads?stage=Counselling") == [a["lead_code"]]  # a stage filter searches every lead
    assert client.get(f"{API}/leads?lead_status=Gone", headers=sravani).status_code == 400


def test_card_holds_every_course_of_the_person(client, people, course):
    sravani = people["sravani"]["h"]
    a = create_deal(client, sravani, course_id=course)
    entry_id = a["pipeline_entry_id"]
    # Another enquiry of the same person stays in Leads until it is converted (db 019)
    b = create_lead(client, sravani, person_id=a["person"]["person_id"], course_id=second_course())
    assert b["stage"] == "New Enquiry" and b["pipeline_entry_id"] is None
    move(client, sravani, a["lead_id"], "Demo Scheduled")  # moving one course moves the card
    assert call(client, "get", f"/pipeline-entries/{entry_id}", sravani)["stage"] == "Demo Scheduled"

    converted = convert_lead(client, sravani, b["lead_id"])  # joins the open card at the card's stage
    assert converted["pipeline_entry"]["pipeline_entry_id"] == entry_id
    card = call(client, "get", f"/pipeline-entries/{entry_id}", sravani)
    assert [row["lead_code"] for row in card["courses"]] == [a["lead_code"], b["lead_code"]]
    assert {row["stage"] for row in card["courses"]} == {"Demo Scheduled"}

    # Moving the card moves every course
    card = call(client, "post", f"/pipeline-entries/{entry_id}/stage", sravani,
                json={"stage": "Demo Attended", "note": "Both demos done"})
    assert {row["stage"] for row in card["courses"]} == {"Demo Attended"}
    notes = call(client, "get", f"/leads/{a['lead_id']}/activities", sravani)
    assert any(n["summary"] == "Both demos done" for n in notes)

    # A course can't move back to New Enquiry
    response = client.post(f"{API}/leads/{a['lead_id']}/stage", json={"stage": "New Enquiry"}, headers=sravani)
    assert response.status_code == 422 and "cannot move back to New Enquiry" in error_of(response)["message"]


def second_course():
    from models import Course, CourseBranch

    extra = Course(course_code="NIT-CRS-019", course_title="Advanced Excel", category="Data & Analytics",
                   standard_fee=8000, branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(extra)
    db.session.commit()
    return extra.course_id


def test_card_stage_rules(client, people):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani)
    entry_id = lead["pipeline_entry_id"]
    url = f"/pipeline-entries/{entry_id}/stage"

    assert client.post(f"{API}{url}", json={"stage": "Admitted"}, headers=sravani).status_code == 400
    assert client.post(f"{API}{url}", json={"stage": "New Enquiry"}, headers=sravani).status_code == 400
    assert client.post(f"{API}{url}", json={"stage": "Lost - closed"}, headers=sravani).status_code == 400  # reason
    assert client.post(f"{API}{url}", json={"stage": "Demo Scheduled"},
                       headers=people["mounika"]["h"]).status_code == 404  # other branch
    assert client.post(f"{API}{url}", json={"stage": "Demo Scheduled"},
                       headers=people["accounts"]["h"]).status_code == 403

    card = call(client, "post", url, sravani, json={
        "stage": "Lost - closed", "lost_reason_id": lookup_id(LostReason, "FEE_TOO_HIGH"),
        "lost_competitor": "Other Institute"})
    assert card["is_open"] is False and card["lost"]["competitor"] == "Other Institute"
    lost = call(client, "get", f"/leads/{lead['lead_id']}", sravani)
    assert lost["stage"] == "Lost - closed" and lost["lost"]["reason"]
    assert call(client, "get", "/pipeline", sravani)["total"] == 0  # closed cards leave the board
    response = client.post(f"{API}{url}", json={"stage": "Counselling"}, headers=sravani)
    assert response.status_code == 422 and "closed" in error_of(response)["message"]

    # Reactivating the lead opens a new card
    call(client, "post", f"/leads/{lead['lead_id']}/reactivate", people["bm"]["h"],
         json={"stage": "Counselling", "next_follow_up_at": future(24)})
    again = call(client, "get", f"/leads/{lead['lead_id']}", sravani)
    assert again["pipeline_entry_id"] not in (None, entry_id)


def test_card_owner_and_follow_up(client, people):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    lead = create_deal(client, bm, person={"full_name": "Vamsi", "phone": "9123456789"})
    entry_id = lead["pipeline_entry_id"]
    url = f"/pipeline-entries/{entry_id}"

    assert client.patch(f"{API}{url}", json={}, headers=bm).status_code == 400
    assert client.patch(f"{API}{url}", json={"assigned_to": people["mounika"]["id"]}, headers=bm).status_code == 400
    card = call(client, "patch", url, bm, json={"assigned_to": people["sravani"]["id"], "next_follow_up_at": future(5)})
    assert card["owner"]["full_name"] == "Sravani" and card["next_follow_up_at"]
    synced = call(client, "get", f"/leads/{lead['lead_id']}", bm)
    assert synced["owner"]["full_name"] == "Sravani" and synced["next_follow_up_at"] == card["next_follow_up_at"]

    # The owner can move the follow-up, not the owner
    assert client.patch(f"{API}{url}", json={"assigned_to": people["bm"]["id"]}, headers=sravani).status_code == 403
    call(client, "patch", url, sravani, json={"next_follow_up_at": future(10)})
    response = client.patch(f"{API}{url}", json={"next_follow_up_at": future(-1)}, headers=sravani)
    assert response.status_code == 400


def test_admitting_one_course_keeps_the_card_open(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    flow = admitted(client, people, course)
    lead = call(client, "get", f"/leads/{flow['lead']['lead_id']}", sravani)
    assert lead["stage"] == "Admitted"
    card = call(client, "get", f"/pipeline-entries/{lead['pipeline_entry_id']}", sravani)
    assert card["stage"] == "Admitted" and card["is_open"] is False  # its only course


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
    lead = create_deal(client, sravani, course_id=course)

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
    lead = create_deal(client, sravani, course_id=course)
    vij_trainer = make_user(roles=[("TRAINER", 2)])

    book(client, sravani, lead["lead_id"], 400, trainer_user_id=vij_trainer.user_id)
    book(client, sravani, lead["lead_id"], 400, scheduled_at="2020-01-01T10:00:00+05:30")
    too_long = client.post(f"{API}/leads/{lead['lead_id']}/demos", headers=sravani,
                           json={"scheduled_at": future(), "demo_type": "Standard", "duration_minutes": 60})
    assert too_long.status_code == 422
    assert book(client, sravani, lead["lead_id"], demo_type="Practical")["duration_minutes"] == 60
    assert client.post(f"{API}/leads/{lead['lead_id']}/demos", headers=people["mounika"]["h"],
                       json={"scheduled_at": future()}).status_code == 404
    no_course = create_deal(client, sravani, person={"full_name": "No Course", "phone": "9000000301"})
    # a deal always has a course (conversion needs one), so booking defaults to it
    assert book(client, sravani, no_course["lead_id"])["course"]["course_id"] == no_course["course"]["course_id"]
    book(client, sravani, no_course["lead_id"], 400, course_id=999999)


def test_protected_stage_is_not_moved_by_booking(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    move(client, sravani, lead["lead_id"], "Payment Pending Verification")
    book(client, sravani, lead["lead_id"])
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["stage"] == "Payment Pending Verification"


def test_confirm_reschedule_cancel(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
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
    lead = create_deal(client, sravani, course_id=course)
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
    lead = create_deal(client, sravani, course_id=course)
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
    lead = create_deal(client, sravani, course_id=course)
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
    lead = create_deal(client, sravani, course_id=course)
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
    lead = create_deal(client, sravani, course_id=course)
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
