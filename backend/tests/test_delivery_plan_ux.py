"""Delivery plan UX (db 037): preferred LMS batch, how the learner accepted (in person / call / WhatsApp YES), the
confirmation message, and who can be invoiced once the plan is accepted."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from config.database import db
from models import DeliveryPlan, LeadActivity, WhatsappOutbox
from services import whatsapp, whatsapp_events
from tests.helpers import API, call, create_deal, create_lead, convert_lead, error_of, priced_lead, ready_deal
from tests.test_whatsapp_phases import NUMBER, callback, inbound, meta
from tests.test_admissions import make_batch

TEMPLATE = "nipuna_delivery_plan_confirm_v1"


@pytest.fixture(autouse=True)
def quiet_accepted_message(monkeypatch):
    """The "plan accepted" notice is covered in test_whatsapp_phases.py; here only the confirmation message matters."""
    monkeypatch.setattr(whatsapp_events, "delivery_plan_accepted", lambda *args, **kwargs: None)


def confirmations():
    return db.session.execute(select(WhatsappOutbox).where(WhatsappOutbox.template_name == TEMPLATE)
                              .order_by(WhatsappOutbox.outbox_id)).scalars().all()


def plan_row(lead_id):
    return db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id == lead_id)).scalar_one()


def draft(client, headers, lead_id, **body):
    return call(client, "put", f"/leads/{lead_id}/delivery-plan", headers,
                json={"delivery_mode": "Classroom", "capacity_review": "Checked", **body})


def sent_plan(client, people, course, **body):
    """A deal with a saved draft plan that was sent to the learner for confirmation."""
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    draft(client, sravani, lead["lead_id"], **body)
    state = call(client, "post", f"/leads/{lead['lead_id']}/delivery-plan/send-for-confirmation", sravani)
    return lead, state


def reply(client, text_body, wamid, at=None):
    at = at or int((datetime.now(timezone.utc) + timedelta(minutes=5)).timestamp())
    return callback(client, meta(messages=[inbound(text_body, wamid=wamid, at=at)]))["result"]


# ---------------------------------------------------------------- the columns

def test_migration_037_columns_and_constraints(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    plan = draft(client, sravani, lead["lead_id"])["plan"]
    assert plan["preferred_lms_batch_code"] is None and plan["acceptance_method"] is None
    assert plan["confirmation_requested_at"] is None
    # the guard forgets a method on a plan that is not accepted
    run_sql("UPDATE delivery_plans SET acceptance_method = 'call' WHERE lead_id = :l", l=lead["lead_id"])
    assert plan_row(lead["lead_id"]).acceptance_method is None
    user = people["sravani"]["id"]
    with pytest.raises(Exception, match="acceptance_method_valid"):
        run_sql("UPDATE delivery_plans SET student_accepted = TRUE, accepted_by = :u, accepted_at = now(), "
                "acceptance_method = 'carrier_pigeon' WHERE lead_id = :l", l=lead["lead_id"], u=user)
    db.session.rollback()
    with pytest.raises(Exception, match="acceptance_recorded"):  # nobody accepted it and it wasn't on WhatsApp
        run_sql("UPDATE delivery_plans SET student_accepted = TRUE, accepted_at = now(), acceptance_method = 'call' "
                "WHERE lead_id = :l", l=lead["lead_id"])
    db.session.rollback()
    run_sql("UPDATE delivery_plans SET student_accepted = TRUE, accepted_at = now(), acceptance_method = 'whatsapp' "
            "WHERE lead_id = :l", l=lead["lead_id"])  # a WhatsApp acceptance has no staff member
    assert plan_row(lead["lead_id"]).accepted_by is None


# ---------------------------------------------------------------- preferred batch

def lms_batch(client, people, course, run_sql, code="NIT-GNT-BAT-2026-000777", **extra):
    batch = make_batch(client, people, course, capacity=3, **extra)
    run_sql("UPDATE batches SET lms_course_id = :c, start_date = current_date + 10 WHERE batch_id = :b",
            c=code, b=batch["batch_id"])
    return batch


def test_batch_hints_and_preferred_batch_are_saved_with_the_plan(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lms_batch(client, people, course, run_sql)
    lead = create_deal(client, sravani, course_id=course)
    hints = call(client, "get", f"/leads/{lead['lead_id']}/delivery-plan/batches", sravani)["batches"]
    (hint,) = hints
    assert hint["lms_batch_code"] == "NIT-GNT-BAT-2026-000777" and hint["is_offerable"] and hint["seats_left"] == 3
    assert hint["timing"].startswith("Sat, Sun") and hint["start_date"] == (date.today() + timedelta(days=10)).isoformat()
    assert call(client, "get", f"/leads/{lead['lead_id']}/delivery-plan/batches?branch_id=2", sravani)["batches"] == []

    plan = draft(client, sravani, lead["lead_id"], planned_start_date=hint["start_date"],
                 preferred_lms_batch_code=hint["lms_batch_code"])["plan"]
    assert plan["preferred_lms_batch_code"] == "NIT-GNT-BAT-2026-000777"
    assert "Sat, Sun" in plan["preferred_lms_batch_label"] and plan["planned_start_date"] == hint["start_date"]

    cleared = draft(client, sravani, lead["lead_id"], preferred_lms_batch_code=None)["plan"]
    assert cleared["preferred_lms_batch_code"] is None and cleared["preferred_lms_batch_label"] is None
    assert cleared["planned_start_date"] == hint["start_date"]  # the date stays: it is a free input


def test_preferred_batch_must_be_a_real_offerable_batch_of_the_course(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    batch = lms_batch(client, people, course, run_sql)
    lead = create_deal(client, sravani, course_id=course)
    url = f"/leads/{lead['lead_id']}/delivery-plan"
    unknown = client.put(f"{API}{url}", headers=sravani, json={"delivery_mode": "Classroom", "preferred_lms_batch_code": "NOPE"})
    assert unknown.status_code == 400 or unknown.status_code == 422
    run_sql("UPDATE batches SET status = 'Cancelled' WHERE batch_id = :b", b=batch["batch_id"])
    cancelled = client.put(f"{API}{url}", headers=sravani, json={
        "delivery_mode": "Classroom", "preferred_lms_batch_code": "NIT-GNT-BAT-2026-000777"})
    assert cancelled.status_code in (400, 422)
    assert call(client, "get", url, sravani)["plan"] is None


# ---------------------------------------------------------------- manual acceptance

def test_manual_acceptance_records_how_the_learner_accepted(client, people, course):
    sravani = people["sravani"]["h"]
    lead, _, version = priced_lead(client, people, course)
    call(client, "post", f"/fee-discussion-versions/{version['version_id']}/approve", sravani)
    url = f"/leads/{lead['lead_id']}/delivery-plan/accept"
    body = {"delivery_mode": "Classroom", "capacity_review": "Checked", "student_accepted": True}
    assert client.post(f"{API}{url}", json={**body, "acceptance_method": "whatsapp"}, headers=sravani).status_code in (400, 422)
    state = call(client, "post", url, sravani, json={**body, "acceptance_method": "call"})
    assert state["plan"]["status"] == "Accepted" and state["plan"]["acceptance_method"] == "call"
    assert state["plan"]["accepted_by"] is not None
    notes = db.session.execute(select(LeadActivity.summary).where(LeadActivity.lead_id == lead["lead_id"])).scalars().all()
    assert any("accepted (on a call)" in n for n in notes if n)

    reopened = call(client, "post", f"/leads/{lead['lead_id']}/delivery-plan/reopen", sravani, json={"reason": "Changed mode"})
    assert reopened["plan"]["acceptance_method"] is None and reopened["plan"]["status"] == "Draft"


def test_accept_without_a_method_still_works(client, people, course):
    lead, _, _ = ready_deal(client, people, course)
    plan = call(client, "get", f"/leads/{lead['lead_id']}/delivery-plan", people["sravani"]["h"])["plan"]
    assert plan["status"] == "Accepted" and plan["acceptance_method"] is None


# ---------------------------------------------------------------- send for confirmation + YES

def test_send_for_confirmation_queues_the_template(client, people, course, run_sql):
    lms_batch(client, people, course, run_sql)
    start = (date.today() + timedelta(days=10)).isoformat()
    lead, state = sent_plan(client, people, course, planned_start_date=start,
                            preferred_lms_batch_code="NIT-GNT-BAT-2026-000777")
    auto, row = confirmations()  # the saved draft was complete, so it went out by itself; the button is a resend
    assert auto.event_key.endswith(":1") and row.status == "Queued" and row.category == "Utility" and row.to_phone == NUMBER
    assert row.event_key == f"delivery-plan-confirm:{state['plan']['delivery_plan_id']}:2"
    assert row.params["delivery_plan_no"] == state["plan"]["plan_code"] and row.params["learning_mode"] == "Classroom"
    assert "preferred batch" in row.params["start_window"] and "reply YES to confirm" in row.body_text
    assert state["plan"]["confirmation_requested_at"] and state["confirmation"]["awaiting_reply"] is True
    assert state["confirmation"]["status"] == "Queued"

    again = call(client, "post", f"/leads/{lead['lead_id']}/delivery-plan/send-for-confirmation", people["sravani"]["h"])
    assert len(confirmations()) == 3 and again["confirmation"]["outbox_id"] != state["confirmation"]["outbox_id"]


def test_send_for_confirmation_rules(client, people, course, monkeypatch):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    url = f"/leads/{lead['lead_id']}/delivery-plan/send-for-confirmation"
    assert client.post(f"{API}{url}", headers=sravani).status_code == 422  # no plan yet
    draft(client, sravani, lead["lead_id"])
    assert client.post(f"{API}{url}", headers=people["accounts"]["h"]).status_code == 403
    with monkeypatch.context() as patched:  # a learner with no number can't be asked on WhatsApp
        patched.setattr(whatsapp, "recipient_phone", lambda person: None)
        no_number = client.post(f"{API}{url}", headers=sravani)
        assert no_number.status_code == 422 and "no WhatsApp number" in error_of(no_number)["message"]
    assert confirmations() == []
    call(client, "post", url, sravani)
    call(client, "post", f"/leads/{lead['lead_id']}/delivery-plan/accept", sravani,
         json={"delivery_mode": "Classroom", "student_accepted": True, "acceptance_method": "in_person"})
    assert client.post(f"{API}{url}", headers=sravani).status_code == 422  # already accepted


def test_editing_the_plan_withdraws_the_request(client, people, course):
    lead, state = sent_plan(client, people, course)
    plan = draft(client, people["sravani"]["h"], lead["lead_id"], delivery_mode="Online")["plan"]
    assert plan["confirmation_requested_at"] is None
    assert reply(client, "YES", "wamid.LATE").endswith("no delivery plan awaiting confirmation")
    assert plan_row(lead["lead_id"]).accepted_at is None


def test_yes_reply_accepts_the_plan_with_method_whatsapp(client, people, course):
    lead, state = sent_plan(client, people, course)
    assert reply(client, " yes please", "wamid.YES1").endswith(f"delivery plan {state['plan']['plan_code']} accepted")
    plan = call(client, "get", f"/leads/{lead['lead_id']}/delivery-plan", people["sravani"]["h"])
    assert plan["plan"]["status"] == "Accepted" and plan["plan"]["acceptance_method"] == "whatsapp"
    assert plan["plan"]["accepted_by"] is None and plan["plan"]["student_accepted"] is True
    notes = db.session.execute(select(LeadActivity.summary).where(LeadActivity.lead_id == lead["lead_id"])).scalars().all()
    assert any("accepted on WhatsApp" in n for n in notes if n)
    assert reply(client, "YES", "wamid.YES2").endswith("no delivery plan awaiting confirmation")  # already done


def test_yes_is_case_insensitive_and_needs_the_word_yes(client, people, course):
    lead, _ = sent_plan(client, people, course)
    assert "accepted" not in reply(client, "Yesterday I was busy", "wamid.NO1")
    assert "accepted" not in reply(client, "No thanks", "wamid.NO2")
    assert "accepted" in reply(client, "Yes", "wamid.OK1")


def test_yes_with_nothing_awaiting_confirmation_only_lands_in_the_inbox(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    draft(client, sravani, lead["lead_id"])  # a draft that was never sent
    assert reply(client, "YES", "wamid.NONE").endswith("no delivery plan awaiting confirmation")
    assert plan_row(lead["lead_id"]).accepted_at is None


def test_yes_from_an_unknown_or_ambiguous_number_accepts_nothing(client, people, course, run_sql):
    lead, _ = sent_plan(client, people, course)
    # a second person with the same number makes the sender ambiguous (Match Review), so nothing is accepted
    run_sql("INSERT INTO persons (full_name, phone, registered_branch_id) VALUES ('Twin Rao', '+919876543210', 1)")
    result = reply(client, "YES", "wamid.AMB")
    assert "accepted" not in result and "no matching person" in result
    assert plan_row(lead["lead_id"]).accepted_at is None
    stranger = callback(client, meta(messages=[{**inbound("YES", wamid="wamid.STR"), "from": "919000000001"}]))["result"]
    assert "accepted" not in stranger


def test_a_yes_sent_before_the_request_does_not_count(client, people, course):
    lead, _ = sent_plan(client, people, course)
    old = int((datetime.now(timezone.utc) - timedelta(hours=2)).timestamp())
    assert "accepted" not in reply(client, "YES", "wamid.OLD", at=old)
    assert plan_row(lead["lead_id"]).accepted_at is None


def test_yes_accepts_the_latest_plan_sent_when_several_wait(app, client, people, course):
    sravani = people["sravani"]["h"]
    first, _ = sent_plan(client, people, course)
    from tests.test_fees_invoices import _second_course

    second = create_lead(client, sravani, person=None, person_id=first["person"]["person_id"], course_id=_second_course(app))
    convert_lead(client, sravani, second["lead_id"])
    draft(client, sravani, second["lead_id"])
    call(client, "post", f"/leads/{second['lead_id']}/delivery-plan/send-for-confirmation", sravani)
    assert "accepted" in reply(client, "YES", "wamid.TWO")
    assert plan_row(second["lead_id"]).accepted_at is not None
    assert plan_row(first["lead_id"]).accepted_at is None and plan_row(first["lead_id"]).confirmation_requested_at is not None


# ---------------------------------------------------------------- invoice eligibility

def test_whatsapp_accepted_plan_makes_the_course_invoiceable_with_all_eligible_courses(client, people, course):
    sravani = people["sravani"]["h"]
    first, _, v1 = priced_lead(client, people, course)
    call(client, "post", f"/fee-discussion-versions/{v1['version_id']}/approve", sravani)
    opts = call(client, "get", f"/invoices/options?lead_id={first['lead_id']}", sravani)
    mine = next(c for c in opts["courses"] if c["lead"]["lead_id"] == first["lead_id"])
    assert mine["eligible"] is False and "Delivery plan not accepted" in mine["reasons"]

    draft(client, sravani, first["lead_id"])
    call(client, "post", f"/leads/{first['lead_id']}/delivery-plan/send-for-confirmation", sravani)
    reply(client, "YES", "wamid.INV")
    opts = call(client, "get", f"/invoices/options?lead_id={first['lead_id']}", sravani)
    mine = next(c for c in opts["courses"] if c["lead"]["lead_id"] == first["lead_id"])
    assert mine["eligible"] is True and mine["delivery_plan"]["acceptance_method"] == "whatsapp"
    invoice = call(client, "post", "/invoices", sravani, 201, json={"lead_ids": [first["lead_id"]]})
    assert invoice["invoice_id"]
    assert call(client, "get", f"/leads/{first['lead_id']}/delivery-plan", sravani)["invoice"]["invoice_id"] == invoice["invoice_id"]
