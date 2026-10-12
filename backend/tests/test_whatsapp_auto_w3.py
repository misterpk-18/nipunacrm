"""Staff WhatsApp alerts (db 042): new lead assigned, approval waiting, payment to verify. Every message goes to the
staff member's own phone (never a learner's), never to the person who did the action, and stays out of the learner's
WhatsApp conversation."""
from sqlalchemy import select, text

from config.database import db
from models import User, WhatsappOutbox
from services import jobs
from tests.helpers import API, call, create_lead, priced_lead, record_payment
from tests.test_payment_ux import two_course_invoice

PHONES = {"bm": "98765 10001", "sravani": "98765 10002", "nikhil": "98765 10003", "accounts": "98765 10004",
          "accounts_vij": "98765 10005", "founder": "98765 10006", "admin": "98765 10007"}


def give_phones(people, *names):
    for name in names or PHONES:
        db.session.get(User, people[name]["id"]).phone = PHONES[name]
    db.session.commit()


def staff_rows(template):
    db.session.expire_all()
    return db.session.execute(select(WhatsappOutbox).where(WhatsappOutbox.template_name == template)
                              .order_by(WhatsappOutbox.outbox_id)).scalars().all()


def digits(name):
    return "91" + PHONES[name].replace(" ", "")


ASSIGNED = "nipuna_staff_lead_assigned_v1"
SUMMARY = "nipuna_staff_leads_assigned_v1"


def new_lead(client, headers, i=0, **extra):
    return create_lead(client, headers, person={"full_name": f"Learner {i}", "phone": f"90000{i:05d}"}, **extra)


# ---------------------------------------------------------------- new lead assigned

def test_lead_created_with_an_owner_alerts_the_owner_only(client, people):
    give_phones(people)
    lead = new_lead(client, people["bm"]["h"], assigned_to=people["sravani"]["id"])
    (row,) = staff_rows(ASSIGNED)
    assert row.status == "Queued" and row.to_phone == digits("sravani")
    assert row.recipient_user_id == people["sravani"]["id"] and row.source_id == lead["lead_id"]
    assert row.params["learner_name"] == "Learner 0" and row.params["branch_name"]
    assert row.params["response_note"].startswith("First response due by")
    assert "Hello Sravani" in row.body_text


def test_nobody_is_alerted_about_a_lead_they_gave_themselves(client, people):
    give_phones(people)
    new_lead(client, people["sravani"]["h"])  # staff-entered leads belong to the counsellor who entered them
    lead = new_lead(client, people["bm"]["h"], 1)
    call(client, "post", f"/leads/{lead['lead_id']}/assign", people["bm"]["h"], json={"assigned_to": people["bm"]["id"]})
    assert staff_rows(ASSIGNED) == []


def test_reassigning_alerts_the_new_owner(client, people):
    give_phones(people)
    lead = new_lead(client, people["bm"]["h"])
    call(client, "post", f"/leads/{lead['lead_id']}/assign", people["bm"]["h"], json={"assigned_to": people["nikhil"]["id"]})
    (row,) = staff_rows(ASSIGNED)
    assert row.to_phone == digits("nikhil") and row.recipient_user_id == people["nikhil"]["id"]
    call(client, "post", f"/leads/{lead['lead_id']}/assign", people["bm"]["h"], json={"assigned_to": people["nikhil"]["id"]})
    assert len(staff_rows(ASSIGNED)) == 1  # no change, no message


def test_staff_without_a_phone_is_skipped_and_never_falls_back_to_the_learner(client, people):
    lead = new_lead(client, people["bm"]["h"], assigned_to=people["sravani"]["id"])  # no phones given
    (row,) = staff_rows(ASSIGNED)
    assert row.status == "Skipped" and row.skip_reason == "No WhatsApp number on file" and row.to_phone is None
    assert lead["person"]["phone"] and row.person_id == lead["person"]["person_id"]


def test_bulk_assign_sends_one_each_up_to_five_and_one_summary_beyond(client, people):
    give_phones(people)
    bm = people["bm"]["h"]
    leads = [new_lead(client, bm, i) for i in range(6)]
    url = f"{API}/leads/bulk-assign"
    call(client, "post", "/leads/bulk-assign", bm, json={
        "lead_ids": [l["lead_id"] for l in leads[:3]], "assigned_to": people["sravani"]["id"]})
    assert len(staff_rows(ASSIGNED)) == 3 and staff_rows(SUMMARY) == []
    call(client, "post", "/leads/bulk-assign", bm, json={
        "lead_ids": [l["lead_id"] for l in leads], "assigned_to": people["nikhil"]["id"]})
    (summary,) = staff_rows(SUMMARY)
    assert summary.params["lead_count"] == "6" and summary.to_phone == digits("nikhil")
    assert len(staff_rows(ASSIGNED)) == 3  # the six went as one message
    assert url


def test_an_imported_lead_has_no_first_response_line(app, client, people):
    from models import Lead
    from services import staff_alerts

    give_phones(people)
    lead = new_lead(client, people["bm"]["h"])
    row = db.session.get(Lead, lead["lead_id"])
    assert staff_alerts._response_note(row, imported=True) == "Please contact the learner soon."


# ---------------------------------------------------------------- approval waiting

def test_special_closing_alerts_the_branch_manager_not_the_requester_or_admins(client, people, course):
    give_phones(people)
    scr = request_scr(client, people, course, extra="1000")
    rows = staff_rows("nipuna_staff_approval_waiting_v1")
    assert [r.recipient_user_id for r in rows] == [people["bm"]["id"]]
    assert rows[0].to_phone == digits("bm") and rows[0].params["request_code"] == scr["scr_code"]
    assert rows[0].params["requested_extra"] == "1000.00"


def test_special_closing_below_the_floor_goes_to_admins_and_escalation_reaches_them_once(client, people, course):
    give_phones(people)
    below = request_scr(client, people, course, extra="10000")  # floor is 21,000 of 30,000
    rows = staff_rows("nipuna_staff_approval_waiting_v1")
    assert {r.recipient_user_id for r in rows} == {people["founder"]["id"], people["admin"]["id"]}
    assert below["status"] == "Pending"
    db.session.execute(text("UPDATE notifications SET escalate_at = now() - interval '1 minute'"))
    db.session.commit()
    jobs.escalate_notifications()
    assert len(staff_rows("nipuna_staff_approval_waiting_v1")) == 2  # already told: not repeated


def test_an_unattended_request_escalates_to_founder_by_whatsapp(client, people, course):
    give_phones(people)
    request_scr(client, people, course, extra="1000")
    db.session.execute(text("UPDATE notifications SET escalate_at = now() - interval '1 minute'"))
    db.session.commit()
    jobs.escalate_notifications()
    rows = staff_rows("nipuna_staff_approval_waiting_v1")
    assert {r.recipient_user_id for r in rows} == {people["bm"]["id"], people["founder"]["id"], people["admin"]["id"]}
    assert sum(r.event_key.endswith(":escalated") for r in rows) == 2


def request_scr(client, people, course, extra):
    lead, discussion, ver = priced_lead(client, people, course, extra_concession=extra)
    return call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests",
                people["sravani"]["h"], 201, json={"request_reason": "Sibling already enrolled"})


# ---------------------------------------------------------------- payment to verify, and staff rows stay hidden

def test_a_recorded_claim_alerts_the_branchs_accounts_users_and_stays_out_of_the_learner_conversation(
        client, people, course):
    give_phones(people)
    detail, _, (lead, _) = two_course_invoice(client, people, course)
    claim = record_payment(client, people["sravani"]["h"], detail["invoice_id"], "1000")["payment"]
    (row,) = staff_rows("nipuna_staff_payment_to_verify_v1")
    assert row.recipient_user_id == people["accounts"]["id"] and row.to_phone == digits("accounts")
    assert row.params["transaction_no"] == claim["transaction_number"] and row.params["payment_amount"] == "1000.00"
    assert row.params["payment_mode"] and row.params["reference"]  # a cash claim says "not given"

    person_id = lead["person"]["person_id"]
    conversation = call(client, "get", f"/persons/{person_id}/whatsapp", people["bm"]["h"])
    assert all(m.get("recipient_kind") != "Staff" for m in conversation["messages"])
    assert not [m for m in conversation["messages"] if m.get("template_name", "").startswith("nipuna_staff_")]

    listed = call(client, "get", f"/whatsapp/messages?template=nipuna_staff_", people["bm"]["h"])
    staff = [m for m in listed if m["recipient_kind"] == "Staff"]
    assert staff and staff[0]["recipient_name"] == "Accounts" and staff[0]["person_id"] == person_id


def test_the_outcome_alert_is_a_staff_row_hidden_from_the_learner(client, people, course):
    from tests.helpers import verify_payment

    give_phones(people)
    detail, _, (lead, _) = two_course_invoice(client, people, course)
    claim = record_payment(client, people["sravani"]["h"], detail["invoice_id"], "1000")["payment"]
    verify_payment(client, people["accounts"]["h"], claim["payment_id"])
    (row,) = staff_rows("nipuna_staff_payment_status_v1")
    assert row.recipient_user_id == people["sravani"]["id"]
    conversation = call(client, "get", f"/persons/{lead['person']['person_id']}/whatsapp", people["bm"]["h"])
    assert not [m for m in conversation["messages"] if m.get("template_name", "").startswith("nipuna_staff_")]


def test_switching_the_setting_off_stops_every_staff_alert(client, people):
    give_phones(people)
    db.session.execute(text("UPDATE app_settings SET setting_value = 'false' WHERE setting_key = 'whatsapp_staff_alerts_enabled'"))
    db.session.commit()
    new_lead(client, people["bm"]["h"], assigned_to=people["sravani"]["id"])
    assert staff_rows(ASSIGNED) == []
