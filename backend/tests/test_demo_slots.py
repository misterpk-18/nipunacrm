"""Demo booking by free trainer slots, the trainer's outcome notification, and the pipeline card's next step."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from config.database import db
from models import Batch, Notification
from services.demo_slots import parse_days
from repositories import users as users_repo
from tests.helpers import API, call, create_deal, issued_invoice, priced_lead, ready_deal, record_payment

IST_TZ = ZoneInfo("Asia/Kolkata")


def tomorrow() -> date:
    return datetime.now(IST_TZ).date() + timedelta(days=1)


def next_weekday(day: date) -> date:
    """The first Monday–Saturday on or after `day` (the seeded shifts are Mon–Sat 09:00–19:00)."""
    while day.isoweekday() == 7:
        day += timedelta(days=1)
    return day


def slots(client, headers, course, branch=1, expected=200, **query):
    params = {"course_id": course, "branch_id": branch, "from": next_weekday(tomorrow()).isoformat(), "days": 1, **query}
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return call(client, "get", f"/demos/slots?{qs}", headers, expected)


def trainer_slots(result, user_id):
    return next(t for t in result["trainers"] if t["user_id"] == user_id)["slots"]


def book(client, headers, lead_id, expected=201, **body):
    return call(client, "post", f"/leads/{lead_id}/demos", headers, expected, json=body)


def test_parse_days():
    assert parse_days("Sat, Sun") == {6, 7}
    assert parse_days("Mon-Fri") == {1, 2, 3, 4, 5}
    assert parse_days("Mon Wed Fri") == {1, 3, 5}
    assert parse_days("Fri - Mon") == {5, 6, 7, 1}
    assert parse_days(None) == set() and parse_days("whenever") == set()


def test_slots_follow_working_hours_and_holidays(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    day = next_weekday(tomorrow())
    result = slots(client, sravani, course)
    mine = trainer_slots(result, people["trainer"]["id"])
    assert result["duration_minutes"] == 45 and result["timezone"] == "Asia/Kolkata"
    first, last = datetime.fromisoformat(mine[0]["start"]), datetime.fromisoformat(mine[-1]["end"])
    assert first.astimezone(IST_TZ).time() == time(9, 0) and last.astimezone(IST_TZ).time() <= time(19, 0)
    assert all(datetime.fromisoformat(s["start"]).astimezone(IST_TZ).date() == day for s in mine)
    # 45-minute slots every 30 minutes from 09:00 so the last one ends by 19:00 (18:00 start → 18:45)
    assert datetime.fromisoformat(mine[-1]["start"]).astimezone(IST_TZ).time() == time(18, 0)

    practical = slots(client, sravani, course, type="Practical")
    assert practical["duration_minutes"] == 60
    assert datetime.fromisoformat(trainer_slots(practical, people["trainer"]["id"])[-1]["start"]).astimezone(IST_TZ).time() == time(18, 0)

    run_sql("INSERT INTO holidays (branch_id, holiday_date, name) VALUES (1, :d, 'Test holiday')", d=day)
    assert trainer_slots(slots(client, sravani, course), people["trainer"]["id"]) == []

    sunday = day + timedelta(days=(7 - day.isoweekday()) % 7)
    assert trainer_slots(slots(client, sravani, course, **{"from": sunday.isoformat()}), people["trainer"]["id"]) == []


def test_slots_access(client, people, course):
    slots(client, people["mounika"]["h"], course, expected=404)  # a Vijayawada counsellor can't see Guntur
    assert client.get(f"{API}/demos/slots?course_id={course}&branch_id=1", headers=people["trainer"]["h"]).status_code == 403
    assert client.get(f"{API}/demos/slots?branch_id=1", headers=people["sravani"]["h"]).status_code == 400
    assert client.get(f"{API}/demos/slots?course_id=999999&branch_id=1", headers=people["sravani"]["h"]).status_code == 400


def test_booked_demo_blocks_the_slot_and_clashes_are_refused(client, people, course):
    sravani, trainer = people["sravani"]["h"], people["trainer"]["id"]
    lead_a = create_deal(client, sravani, course_id=course)
    lead_b = create_deal(client, sravani, course_id=course, person={"full_name": "Second", "phone": "9000000402"})
    chosen = trainer_slots(slots(client, sravani, course), trainer)[4]  # 11:00
    start = datetime.fromisoformat(chosen["start"])

    book(client, sravani, lead_a["lead_id"], scheduled_at=chosen["start"], trainer_user_id=trainer)
    after = [s["start"] for s in trainer_slots(slots(client, sravani, course), trainer)]
    # 11:00 demo (45 min) removes the 10:30 (overlaps), 11:00 and 11:30 (starts 11:30 < 11:45) slots; 12:00 stays free
    blocked = {(start + timedelta(minutes=m)).isoformat() for m in (-30, 0, 30)}
    assert not blocked & set(after)
    assert (start + timedelta(minutes=60)).isoformat() in after and (start - timedelta(minutes=60)).isoformat() in after

    refused = client.post(f"{API}/leads/{lead_b['lead_id']}/demos", headers=sravani,
                          json={"scheduled_at": (start + timedelta(minutes=30)).isoformat(), "trainer_user_id": trainer})
    assert refused.status_code == 409 and "busy" in refused.get_json()["error"]["message"]
    # back to back is fine, and a demo with no trainer never clashes
    book(client, sravani, lead_b["lead_id"], scheduled_at=(start + timedelta(minutes=45)).isoformat(), trainer_user_id=trainer)
    book(client, sravani, lead_b["lead_id"], scheduled_at=chosen["start"])


def test_reschedule_and_trainer_change_are_checked(client, people, course, make_user):
    sravani, trainer = people["sravani"]["h"], people["trainer"]["id"]
    lead_a = create_deal(client, sravani, course_id=course)
    lead_b = create_deal(client, sravani, course_id=course, person={"full_name": "Second", "phone": "9000000403"})
    free = trainer_slots(slots(client, sravani, course), trainer)
    first = book(client, sravani, lead_a["lead_id"], scheduled_at=free[0]["start"], trainer_user_id=trainer)
    second = book(client, sravani, lead_b["lead_id"], scheduled_at=free[6]["start"], trainer_user_id=trainer)

    clash = client.post(f"{API}/demos/{second['demo_id']}/reschedule", headers=sravani,
                        json={"scheduled_at": free[1]["start"], "reason": "Student requested"})
    assert clash.status_code == 409
    # moving a demo onto its own old time window is not a clash with itself
    call(client, "post", f"/demos/{first['demo_id']}/reschedule", sravani, 201,
         json={"scheduled_at": free[1]["start"], "reason": "Student requested"})

    other = make_user(roles=[("TRAINER", 1)], full_name="Trainer Two")
    free2 = trainer_slots(slots(client, sravani, course), other.user_id)
    third = book(client, sravani, lead_b["lead_id"], scheduled_at=free2[0]["start"], trainer_user_id=other.user_id)
    # 09:00 overlaps the first trainer's rescheduled 09:30 demo: refused; a free time for them is fine
    assert client.patch(f"{API}/demos/{third['demo_id']}", headers=sravani, json={"trainer_user_id": trainer}).status_code == 409
    fourth = book(client, sravani, lead_b["lead_id"], scheduled_at=free2[12]["start"], trainer_user_id=other.user_id)
    assert client.patch(f"{API}/demos/{fourth['demo_id']}", headers=sravani, json={"trainer_user_id": trainer}).status_code == 200


def test_batch_timetable_blocks_the_trainer(client, people, course):
    sravani, trainer = people["sravani"]["h"], people["trainer"]["id"]
    day = next_weekday(tomorrow())
    db.session.add(Batch(batch_name="Evening DS", course_id=course, branch_id=1, start_date=day - timedelta(days=5),
                         end_date=day + timedelta(days=30), capacity=20, status="In Progress", trainer_user_id=trainer,
                         schedule_days="Mon-Sat", start_time=time(10, 0), end_time=time(12, 0), lms_mirrored=False))
    db.session.commit()

    result = slots(client, sravani, course)
    mine = trainer_slots(result, trainer)
    starts = {datetime.fromisoformat(s["start"]).astimezone(IST_TZ).time() for s in mine}
    assert time(9, 0) in starts                 # 09:00–09:45 ends before the 10:00 batch
    assert time(9, 30) not in starts and time(10, 0) not in starts and time(11, 30) not in starts
    assert time(12, 0) in starts
    assert next(t for t in result["trainers"] if t["user_id"] == trainer)["teaches_course"] is True

    lead = create_deal(client, sravani, course_id=course)
    ten = datetime.combine(day, time(10, 0), tzinfo=IST_TZ).isoformat()
    refused = client.post(f"{API}/leads/{lead['lead_id']}/demos", headers=sravani, json={"scheduled_at": ten, "trainer_user_id": trainer})
    assert refused.status_code == 409 and "batch" in refused.get_json()["error"]["message"]


def test_lms_batch_blocks_trainer_by_email_and_unconfirmed_timetable_blocks_nothing(client, people, course, make_user):
    sravani = people["sravani"]["h"]
    lms_trainer = make_user(roles=[("TRAINER", 1)], full_name="LMS Trainer", email="lms.trainer@nipuna.test")
    day = next_weekday(tomorrow())
    db.session.add_all([
        Batch(batch_name="LMS batch", course_id=course, branch_id=1, start_date=day, capacity=20, status="Open",
              lms_course_id="BATCH-X", lms_mirrored=True, lead_trainer_email="Someone.Else@nipuna.test",
              trainer_emails=["LMS.Trainer@nipuna.test"], schedule_days="Mon, Tue, Wed, Thu, Fri, Sat",
              start_time=time(14, 0), end_time=time(16, 0)),
        Batch(batch_name="No timetable", course_id=course, branch_id=1, start_date=day, capacity=20, status="Open",
              lms_course_id="BATCH-Y", lms_mirrored=True, trainer_emails=["lms.trainer@nipuna.test"]),
    ])
    db.session.commit()
    mine = trainer_slots(slots(client, sravani, course), lms_trainer.user_id)
    starts = {datetime.fromisoformat(s["start"]).astimezone(IST_TZ).time() for s in mine}
    assert time(14, 0) not in starts and time(15, 30) not in starts and time(13, 0) in starts and time(16, 0) in starts


def test_trainer_records_outcome_and_owner_is_notified(client, people, course, run_sql):
    sravani, trainer = people["sravani"]["h"], people["trainer"]
    lead = create_deal(client, sravani, course_id=course)
    demo = book(client, sravani, lead["lead_id"], scheduled_at=(datetime.now(IST_TZ) + timedelta(days=2)).isoformat(),
                trainer_user_id=trainer["id"])
    due = client.get(f"{API}/demos?trainer_id={trainer['id']}&outcome_due=true", headers=trainer["h"]).get_json()["data"]
    assert due == []  # the slot has not ended

    run_sql("UPDATE demos SET scheduled_at = now() - interval '30 minutes' WHERE demo_id = :id", id=demo["demo_id"])
    assert client.get(f"{API}/demos?trainer_id={trainer['id']}&outcome_due=true", headers=trainer["h"]).get_json()["data"] == []  # still running
    run_sql("UPDATE demos SET scheduled_at = now() - interval '3 hours' WHERE demo_id = :id", id=demo["demo_id"])
    due = client.get(f"{API}/demos?trainer_id={trainer['id']}&outcome_due=true", headers=trainer["h"]).get_json()["data"]
    assert [d["demo_id"] for d in due] == [demo["demo_id"]]

    body = {"status": "Attended", "outcome": "Interested — fee discussion", "next_action": "Fee discussion",
            "next_follow_up_at": (datetime.now(IST_TZ) + timedelta(days=2)).isoformat()}
    call(client, "post", f"/demos/{demo['demo_id']}/outcome", trainer["h"], json=body)
    notes = db.session.execute(select(Notification).where(Notification.entity_type == "lead",
                                                          Notification.entity_id == str(lead["lead_id"]))).scalars().all()
    mine = [n for n in notes if n.event_key == f"demo.outcome:{demo['demo_code']}"]
    assert {n.recipient_user_id for n in mine} == {people["sravani"]["id"], *users_repo.admin_user_ids()}
    assert "start the fee discussion" in mine[0].title
    assert client.get(f"{API}/demos?trainer_id={trainer['id']}&outcome_due=true", headers=trainer["h"]).get_json()["data"] == []

    # a counsellor recording it herself is not notified about her own action
    other = create_deal(client, sravani, course_id=course, person={"full_name": "Own Entry", "phone": "9000000404"})
    own = book(client, sravani, other["lead_id"], scheduled_at=(datetime.now(IST_TZ) + timedelta(days=2)).isoformat())
    run_sql("UPDATE demos SET scheduled_at = now() - interval '3 hours' WHERE demo_id = :id", id=own["demo_id"])
    call(client, "post", f"/demos/{own['demo_id']}/outcome", sravani, json=body)
    assert not db.session.execute(select(Notification).where(Notification.event_key == f"demo.outcome:{own['demo_code']}")).first()


# ---------------------------------------------------------------- pipeline card: next step, blocker, days in stage

def card_of(client, headers, entry_code_or_lead):
    board = call(client, "get", "/pipeline?per_stage=50", headers)
    cards = [c for col in board["columns"] for c in col["cards"]]
    return next(c for c in cards if entry_code_or_lead in [row["lead_id"] for row in c["courses"]])


def test_card_walks_the_funnel_with_next_step_and_blocker(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    lead_id = lead["lead_id"]

    card = card_of(client, sravani, lead_id)
    assert card["next_step"]["action"] == "book_demo" and card["quick_action"] == {
        "action": "book_demo", "label": "Book demo", "lead_id": lead_id}
    assert card["blocker"] is None and card["days_in_stage"] == 0 and card["stalled"] is False

    demo = book(client, sravani, lead_id, scheduled_at=(datetime.now(IST_TZ) + timedelta(days=1)).isoformat())
    card = card_of(client, sravani, lead_id)
    assert card["next_step"]["label"] == "Attend the demo" and card["quick_action"] is None
    assert card["next_step"]["due_at"] is not None and card["next_step"]["overdue"] is False

    run_sql("UPDATE demos SET scheduled_at = now() - interval '3 hours' WHERE demo_id = :id", id=demo["demo_id"])
    card = card_of(client, sravani, lead_id)
    assert card["next_step"]["action"] == "record_demo_outcome" and card["next_step"]["overdue"] is True
    assert card["blocker"] == "Demo outcome pending"

    call(client, "post", f"/demos/{demo['demo_id']}/outcome", sravani, json={
        "status": "Attended", "outcome": "Interested — fee discussion", "next_follow_up_at": (datetime.now(IST_TZ) + timedelta(days=2)).isoformat()})
    card = card_of(client, sravani, lead_id)
    assert card["next_step"]["action"] == "fee_discussion"
    assert card["next_step"]["due_at"] is not None and card["next_step"]["overdue"] is False

    run_sql("UPDATE pipeline_entries SET stage_changed_at = now() - interval '9 days' WHERE pipeline_entry_id = :id", id=card["pipeline_entry_id"])
    card = card_of(client, sravani, lead_id)
    assert card["days_in_stage"] == 9 and card["stalled"] is True


def test_card_blockers_for_approval_plan_and_payment(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]

    lead, discussion, version = priced_lead(client, people, course, extra_concession="1000")
    card = card_of(client, sravani, lead["lead_id"])
    assert card["next_step"]["action"] == "request_approval" and card["blocker"] is None
    call(client, "post", f"/fee-discussion-versions/{version['version_id']}/special-closing-requests", sravani, 201,
         json={"request_reason": "Student has a competing offer"})
    card = card_of(client, sravani, lead["lead_id"])
    assert card["next_step"]["label"] == "Wait for approval" and card["blocker"] == "Waiting approval"
    assert card["quick_action"] is None

    other, _, ver = priced_lead(client, people, course, headers=bm)
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", bm)
    card = card_of(client, bm, other["lead_id"])
    assert card["next_step"]["action"] == "accept_plan" and card["blocker"] == "Plan not accepted"
    assert card["quick_action"]["action"] == "accept_plan"


def test_card_after_invoice_and_payment(client, people, course):
    sravani = people["sravani"]["h"]
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS")
    lead_id = flow["lead"]["lead_id"]
    card = card_of(client, sravani, lead_id)
    assert card["next_step"]["action"] == "record_payment" and card["blocker"] is None

    record_payment(client, sravani, flow["invoice"]["invoice_id"], "1000")
    card = card_of(client, sravani, lead_id)
    assert card["next_step"]["action"] == "verify_payment" and card["blocker"] == "Payment under review"

    ready, _, _ = ready_deal(client, people, course, headers=sravani)
    assert card_of(client, sravani, ready["lead_id"])["next_step"]["action"] == "create_invoice"
