"""WhatsApp phases 2–4 (db 034): the rest of the events, the provider's callback (delivery status and replies), the
message list / retry / consent endpoints, and marketing templates."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from config.database import db
from models import Communication, Lead, LmsOutbox, Payment, Person, Task, WhatsappOutbox, WhatsappWebhookLog
from services import lms_delivery, lms_pull, whatsapp, whatsapp_templates as templates
from tests.helpers import (
    API, admitted, call, create_lead, error_of, future, issued_invoice, lead_body, mode_id, paid_invoice,
    verify_payment,
)
from tests.test_admissions import make_batch
from tests.test_whatsapp import FakeProvider, invoice_row, of, provider, rows

TOKEN = {"X-Webhook-Token": "test-webhook-token"}
NUMBER = "919876543210"


def callback(client, payload, headers=TOKEN, expected=200):
    response = client.post(f"{API}/webhooks/whatsapp", json=payload, headers=headers)
    assert response.status_code == expected, response.get_json()
    return (response.get_json() or {}).get("data")


def meta(statuses=None, messages=None, name="Ananya Rao"):
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "contacts": [{"wa_id": NUMBER, "profile": {"name": name}}],
        "statuses": statuses or [], "messages": messages or []}}]}]}


def status(wamid, state, at=1_790_000_000, **extra):
    return {"id": wamid, "status": state, "timestamp": str(at), "recipient_id": NUMBER, **extra}


def inbound(text_body, wamid="wamid.IN1", at=1_790_000_000):
    return {"from": NUMBER, "id": wamid, "timestamp": str(at), "type": "text", "text": {"body": text_body}}


def sent_invoice_message(client, people, course, monkeypatch):
    flow, row = invoice_row(client, people, course)
    provider(monkeypatch)
    whatsapp.deliver()
    return flow, db.session.get(WhatsappOutbox, row.outbox_id, populate_existing=True)


# ---------------------------------------------------------------- phase 2: the rest of the events

def test_an_advance_put_on_an_invoice_reports_what_is_left(client, people, course):
    flow = issued_invoice(client, people, course)
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    advance = call(client, "post", "/payments", sravani, 201, json={
        "lead_id": flow["lead"]["lead_id"], "amount": "500", "payment_mode_id": mode_id("CASH")})["payment"]
    verify_payment(client, accounts, advance["payment_id"])
    assert of("advance_allocated") == []
    call(client, "post", f"/payments/{advance['payment_id']}/allocate", accounts, json={"invoice_id": flow["invoice"]["invoice_id"]})
    (row,) = of("advance_allocated")
    assert row.params["allocated_amount"] == "500.00" and row.params["unallocated_credit"] == "0.00"
    assert row.params["receipt_no"].startswith("GNT-R-")
    assert flow["invoice"]["invoice_number"] in row.params["allocated_to"]
    assert "from your existing advance receipt" in row.body_text and row.event_key == f"advance-allocated:{advance['payment_id']}"


def test_an_approved_correction_is_reported(client, people, course):
    flow = paid_invoice(client, people, course, amount="10000")
    payment_id = flow["payment"]["payment_id"]
    accounts, founder = people["accounts"]["h"], people["founder"]["h"]
    request = call(client, "post", f"/payments/{payment_id}/correction-requests", accounts, 201, json={"reason": "Duplicate UTR"})
    assert of("payment_correction_applied") == []
    call(client, "post", f"/correction-requests/{request['correction_request_id']}/approve", founder, json={})
    (row,) = of("payment_correction_applied")
    assert row.params["correction_no"] == request["request_code"] and row.params["adjustment_amount"] == "10000.00"
    assert row.params["receipt_no"] == db.session.get(Payment, payment_id).receipt_number
    assert "not a refund payout" in row.body_text


def test_an_accepted_delivery_plan_is_reported(client, people, course):
    issued_invoice(client, people, course)  # the deal's delivery plan is accepted on the way
    (row,) = of("delivery_plan_accepted")
    assert row.params["delivery_plan_no"].startswith("DP-") and row.params["learning_mode"]
    assert row.params["start_window"] and row.source_type == "delivery_plan"
    assert "recorded your delivery plan" in row.body_text


def test_a_batch_allocation_names_the_batch_and_its_timing(client, people, course):
    manager = people["bm"]["h"]
    batch = make_batch(client, people, course, trainer_user_id=people["trainer"]["id"])
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    allocation = call(client, "post", f"/admissions/{aid}/allocations", manager, 201, json={"batch_id": batch["batch_id"]})
    (row,) = of("batch_allocated")
    assert row.params["batch_name"] == "DS Weekend" and row.params["admission_no"] == flow["admission"]["admission_code"]
    assert row.params["class_details"].startswith("Sat, Sun 10:00 AM to 12:00 PM, batch starts ")
    assert row.event_key == f"batch-allocated:{allocation['allocation_id']}"


def test_lms_account_is_reported_once_and_only_when_new(client, people, course):
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]
    now = datetime.now(timezone.utc)
    lms_pull.apply_person({"crm_person_id": person_id, "lms_user_id": "u-1", "lms_provisioned_at": now.isoformat()})
    (row,) = of("lms_account_activated")
    assert row.params["admission_no"] == flow["admission"]["admission_code"] and row.to_phone == NUMBER
    lms_pull.apply_person({"crm_person_id": person_id, "lms_user_id": "u-1", "lms_provisioned_at": now.isoformat()})
    assert len(of("lms_account_activated")) == 1


def test_an_account_the_pull_is_catching_up_on_is_not_news(client, people, course):
    flow = admitted(client, people, course)
    old = datetime.now(timezone.utc) - timedelta(days=30)
    lms_pull.apply_person({"crm_person_id": flow["admission"]["person"]["person_id"], "lms_user_id": "u-1",
                           "lms_provisioned_at": old.isoformat()})
    assert of("lms_account_activated") == []


def test_a_failed_lms_setup_tells_the_learner_access_is_delayed(client, people, course):
    flow = admitted(client, people, course)
    admission_id = flow["admission"]["admission_id"]
    row = db.session.execute(select(LmsOutbox).where(LmsOutbox.record_key == f"admission:{admission_id}",
                                                     LmsOutbox.event_type == "AdmissionQualified")).scalars().first()
    lms_delivery._fail(row, "HTTP 400 · bad course")
    (message,) = of("lms_course_access_delayed")
    assert message.params["admission_no"] == flow["admission"]["admission_code"]
    lms_delivery._fail(row, "HTTP 400 · again")
    assert len(of("lms_course_access_delayed")) == 1  # once per admission


def test_placement_application_recorded_and_updated(client, people, course):
    placement = people["placement"]["h"]
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]
    company = call(client, "post", "/companies", placement, 201, json={"company_name": "Sample Employer A", "city": "Guntur"})
    job = call(client, "post", "/job-openings", placement, 201, json={
        "company_id": company["company_id"], "job_title": "Junior Data Analyst", "work_mode": "Hybrid"})
    profile = call(client, "put", f"/persons/{person_id}/placement-profile", placement, json={"readiness": "Ready", "cv_file_path": "cv/v1.pdf"})
    call(client, "post", f"/placement-profiles/{profile['profile_id']}/consent", placement, json={"consent_status": "Explicit Consent"})
    call(client, "patch", f"/job-openings/{job['job_opening_id']}", placement, json={"status": "Open"})
    application = call(client, "post", "/job-applications", placement, 201,
                       json={"profile_id": profile["profile_id"], "job_opening_id": job["job_opening_id"]})
    assert application["application_code"] == f"PL-{application['application_id']:05d}"
    (recorded,) = of("placement_application_recorded")
    assert recorded.params["application_no"] == application["application_code"]
    assert recorded.params["application_for"] == "Sample Employer A - Junior Data Analyst"

    aid = application["application_id"]
    call(client, "post", f"/job-applications/{aid}/stage", placement, json={"stage": "Shortlisted"})
    call(client, "post", f"/job-applications/{aid}/events", placement, 201,
         json={"event_type": "Interview Scheduled", "interview_at": future(72)})
    updates = {row.params["application_status"]: row for row in of("placement_application_update")}
    assert len(updates) == 2 and "Shortlisted" in updates
    (interview,) = [status for status in updates if status.startswith("Interview scheduled for ")]
    assert "Recorded status: Shortlisted." in updates["Shortlisted"].body_text and interview[-8:].strip()
    assert all(row.params["application_no"] == application["application_code"] for row in updates.values())


def test_a_new_enquiry_is_acknowledged_once_a_day(client, people, course):
    sravani = people["sravani"]["h"]
    create_lead(client, sravani, course_id=course)
    (row,) = of("enquiry_received_u_v3")
    assert row.params["enquiry_ref"].startswith("ENQ-") and row.params["enquiry_subject"]
    assert row.source_type == "enquiry" and row.to_phone == NUMBER and row.status == "Queued"
    assert "has received your enquiry about" in row.body_text
    again = client.post(f"{API}/leads", headers=sravani, json={
        **lead_body(), "person_id": db.session.get(Person, row.person_id).person_id, "person": None, "course_id": None})
    assert again.status_code in (201, 409)
    assert len(of("enquiry_received_u_v3")) == 1  # the same person within a day


def test_an_outreach_prospect_is_not_acknowledged(client, people, course):
    create_lead(client, people["sravani"]["h"], course_id=course, intake_status="Outreach Prospect")
    assert of("enquiry_received_u_v3") == []


# ---------------------------------------------------------------- phase 3: the provider's callback

def test_the_callback_needs_the_shared_token(client, people, course):
    callback(client, meta(), headers={}, expected=401)
    callback(client, meta(), headers={"X-Webhook-Token": "wrong"}, expected=401)
    assert client.post(f"{API}/webhooks/whatsapp?token=test-webhook-token", json=meta()).status_code == 200


def test_the_subscribe_handshake_answers_the_challenge(client):
    ok = client.get(f"{API}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-webhook-token&hub.challenge=12345")
    assert ok.status_code == 200 and ok.get_data(as_text=True) == "12345"
    assert client.get(f"{API}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1").status_code == 404


def test_delivered_then_read_move_the_message_forward_and_never_back(client, people, course, monkeypatch):
    flow, row = sent_invoice_message(client, people, course, monkeypatch)
    wamid = row.provider_message_id
    callback(client, meta(statuses=[status(wamid, "sent")]))
    callback(client, meta(statuses=[status(wamid, "read", at=1_790_000_100)]))      # out of order: read first
    callback(client, meta(statuses=[status(wamid, "delivered", at=1_790_000_050)]))  # a late "delivered" changes nothing
    callback(client, meta(statuses=[status(wamid, "failed", errors=[{"code": 131026, "title": "Undeliverable"}])]))
    row = db.session.get(WhatsappOutbox, row.outbox_id, populate_existing=True)
    assert row.status == "Read" and row.read_at.timestamp() == 1_790_000_100 and row.delivered_at is not None
    assert row.last_error is None


def test_a_failed_callback_records_the_providers_reason(client, people, course, monkeypatch):
    flow, row = sent_invoice_message(client, people, course, monkeypatch)
    callback(client, meta(statuses=[status(row.provider_message_id, "failed",
                                           errors=[{"code": 131026, "title": "Message undeliverable"}])]))
    row = db.session.get(WhatsappOutbox, row.outbox_id, populate_existing=True)
    assert row.status == "Failed" and "Message undeliverable (131026)" in row.last_error
    callback(client, meta(statuses=[status(row.provider_message_id, "delivered")]))  # it did arrive after all
    assert db.session.get(WhatsappOutbox, row.outbox_id, populate_existing=True).status == "Delivered"


def test_an_unknown_message_and_an_unreadable_body_are_logged_and_ignored(client):
    result = callback(client, meta(statuses=[status("wamid.NOBODY", "delivered")]))
    assert result["statuses"] == 1 and "unknown message" in result["result"]
    assert callback(client, {"something": "else"})["result"] == "nothing recognised"
    assert callback(client, [meta(statuses=[status("wamid.X", "read")])])["statuses"] == 1  # a list of bodies
    flat = callback(client, {"statuses": [status("wamid.Y", "read")]})  # flattened by the provider
    assert flat["statuses"] == 1
    assert db.session.execute(select(func.count()).select_from(WhatsappOutbox)).scalar() == 0
    assert db.session.execute(select(func.count()).select_from(WhatsappWebhookLog)).scalar() == 4


# ---------------------------------------------------------------- phase 3: the endpoints

def test_the_message_list_is_scoped_to_the_branch_and_filterable(client, people, course, monkeypatch):
    sent_invoice_message(client, people, course, monkeypatch)
    sravani, mounika, bm = people["sravani"]["h"], people["mounika"]["h"], people["bm"]["h"]
    listed = call(client, "get", "/whatsapp/messages?status=Sent", sravani)
    assert {m["template_name"] for m in listed} == {"nipuna_invoice_issued_u_v1", "nipuna_delivery_plan_accepted_u_v1",
                                                      "nipuna_enquiry_received_u_v3"}
    assert len(call(client, "get", "/whatsapp/messages?template=invoice", sravani)) == 1
    assert {(m["person_name"], m["branch_name"]) for m in listed} == {("Ananya Rao", "Guntur")}
    assert call(client, "get", "/whatsapp/messages?status=Failed", sravani) == []
    assert call(client, "get", "/whatsapp/messages?q=Ananya", bm)
    assert call(client, "get", "/whatsapp/messages", mounika) == []  # the other branch sees nothing
    assert client.get(f"{API}/whatsapp/messages?status=Bogus", headers=sravani).status_code == 400
    assert client.get(f"{API}/whatsapp/messages", headers=people["trainer"]["h"]).status_code == 403
    counts = call(client, "get", "/whatsapp/summary", bm)
    assert counts["counts"]["Sent"] == len(listed) and counts["sending"] is True


def test_retry_is_for_managers_and_accounts_and_checks_a_lost_answer(client, people, course, monkeypatch):
    flow, row = invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(lambda body: whatsapp.Answer(None, None, error="x", maybe_accepted=True)))
    whatsapp.deliver()
    url = f"/whatsapp/messages/{row.outbox_id}/retry"
    assert client.post(f"{API}{url}", json={}, headers=people["sravani"]["h"]).status_code == 403
    unconfirmed = client.post(f"{API}{url}", json={}, headers=people["accounts"]["h"])
    assert unconfirmed.status_code == 422 and "may have reached the learner" in error_of(unconfirmed)["message"]
    assert client.post(f"{API}{url}", json={}, headers=people["accounts_vij"]["h"]).status_code == 404
    done = call(client, "post", url, people["accounts"]["h"], json={"confirm_not_delivered": True})
    assert done["status"] == "Queued"
    assert client.post(f"{API}{url}", json={}, headers=people["accounts"]["h"]).status_code == 422  # already queued
    fake = provider(monkeypatch)
    assert whatsapp.deliver() == {"sent": 1} and len(fake.sent) == 1


def test_the_person_conversation_joins_what_was_sent_and_what_came_back(client, people, course, monkeypatch):
    flow, row = sent_invoice_message(client, people, course, monkeypatch)
    callback(client, meta(messages=[inbound("Thanks, will pay soon")]))
    sravani = people["sravani"]["h"]
    conversation = call(client, "get", f"/persons/{row.person_id}/whatsapp", sravani)
    assert conversation["whatsapp_number"] == NUMBER and conversation["consent"]["status"] == "Not Recorded"
    inbound_messages = [m for m in conversation["messages"] if m["direction"] == "Inbound"]
    assert [m["body_text"] for m in inbound_messages] == ["Thanks, will pay soon"]
    outbound = [m for m in conversation["messages"] if m["direction"] == "Outbound"]
    assert any(m["template_name"] == "nipuna_invoice_issued_u_v1" and m["status"] == "Sent" for m in outbound)
    times = [m["at"] for m in conversation["messages"]]
    assert times == sorted(times, reverse=True)
    assert client.get(f"{API}/persons/{row.person_id}/whatsapp", headers=people["mounika"]["h"]).status_code == 404


def test_consent_is_recorded_by_staff_and_audited(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    person_id = db.session.get(Lead, lead["lead_id"]).person_id
    sravani = people["sravani"]["h"]
    consent = call(client, "put", f"/persons/{person_id}/whatsapp-consent", sravani,
                   json={"status": "Explicit Consent", "source": "Counsellor call"})
    assert consent["status"] == "Explicit Consent" and consent["source"] == "Counsellor call" and consent["at"]
    assert client.put(f"{API}/persons/{person_id}/whatsapp-consent", json={"status": "Maybe"}, headers=sravani).status_code == 400
    assert client.put(f"{API}/persons/{person_id}/whatsapp-consent", json={"status": "Withdrawn"},
                      headers=people["mounika"]["h"]).status_code == 404
    cleared = call(client, "put", f"/persons/{person_id}/whatsapp-consent", sravani, json={"status": "Not Recorded"})
    assert cleared["status"] == "Not Recorded" and cleared["at"] is None


# ---------------------------------------------------------------- phase 4: replies

def test_a_reply_lands_in_the_inbox_and_on_the_lead(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    result = callback(client, meta(messages=[inbound("What is the fee?")]))
    assert result["messages"] == 1 and "recorded" in result["result"]
    comm = db.session.execute(select(Communication).where(Communication.external_message_id == "wamid.IN1")).scalar_one()
    assert comm.direction == "Inbound" and comm.channel.code == "WHATSAPP" and comm.from_address == f"+{NUMBER}"
    assert comm.delivery_status == "Received" and comm.needs_response and comm.response_due_at
    assert comm.match_status == "Match Review" and comm.person_id == db.session.get(Lead, lead["lead_id"]).person_id
    assert comm.branch_id == 1 and comm.is_manual is False
    activities = call(client, "get", f"/leads/{lead['lead_id']}/activities", sravani)
    assert any(a["summary"] == "What is the fee?" and a["direction"] == "Inbound" for a in activities)
    assert "already recorded" in callback(client, meta(messages=[inbound("What is the fee?")]))["result"]


def test_a_keyword_reply_creates_a_follow_up_task(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    callback(client, meta(messages=[inbound("CALLBACK please", wamid="wamid.CB1")]))
    task = db.session.execute(select(Task).where(Task.dedupe_key == "whatsapp-reply:wamid.CB1")).scalar_one()
    assert "CALLBACK" in task.title and "call them back" in task.title and task.communication_id
    assert task.owner_user_id == db.session.get(Lead, lead["lead_id"]).assigned_to


def test_stop_withdraws_marketing_consent(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    person_id = db.session.get(Lead, lead["lead_id"]).person_id
    call(client, "put", f"/persons/{person_id}/whatsapp-consent", sravani, json={"status": "Explicit Consent"})
    result = callback(client, meta(messages=[inbound("Stop.", wamid="wamid.STOP")]))
    assert "consent withdrawn" in result["result"]
    person = db.session.get(Person, person_id)
    db.session.refresh(person)
    assert person.whatsapp_consent == "Withdrawn" and person.whatsapp_consent_source == "Reply STOP"
    assert person.whatsapp_consent_by is None
    assert db.session.execute(select(Task).where(Task.dedupe_key == "whatsapp-reply:wamid.STOP")).first() is None


def test_a_reply_from_a_stranger_is_recorded_unmatched(client, people):
    result = callback(client, meta(messages=[{**inbound("Hi", wamid="wamid.NEW"), "from": "919000000001"}]))
    assert "no matching person" in result["result"]
    comm = db.session.execute(select(Communication).where(Communication.external_message_id == "wamid.NEW")).scalar_one()
    assert comm.match_status == "Unmatched" and comm.person_id is None and comm.needs_response


# ---------------------------------------------------------------- phase 4: marketing

def marketing(client, headers, lead_id, template="course_brochure", expected=201, **extra):
    return call(client, "post", f"/leads/{lead_id}/whatsapp/marketing", headers, expected, json={"template": template, **extra})


def consenting_lead(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    person_id = db.session.get(Lead, lead["lead_id"]).person_id
    call(client, "put", f"/persons/{person_id}/whatsapp-consent", sravani, json={"status": "Explicit Consent"})
    return lead, person_id


def test_the_marketing_catalogue_lists_the_four_templates(client, people):
    catalogue = call(client, "get", "/whatsapp/marketing-templates", people["sravani"]["h"])
    assert [t["key"] for t in catalogue] == ["course_recommendation", "course_brochure", "new_batch", "enquiry_followup"]
    assert catalogue[0]["template_name"] == "nipuna_course_recommendation_mkt_v1" and "interest" in catalogue[0]["needs"]
    assert call(client, "get", "/whatsapp/marketing-templates", people["accounts"]["h"])  # Accounts read the list too
    assert client.get(f"{API}/whatsapp/marketing-templates", headers=people["trainer"]["h"]).status_code == 403


def test_marketing_needs_consent(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    refused = client.post(f"{API}/leads/{lead['lead_id']}/whatsapp/marketing", json={"template": "course_brochure"}, headers=sravani)
    assert refused.status_code == 422 and "has not agreed to WhatsApp marketing" in error_of(refused)["message"]
    assert [r for r in rows() if r.category == "Marketing"] == []


def test_a_consenting_lead_gets_the_template_through_the_outbox(client, people, course, monkeypatch):
    lead, person_id = consenting_lead(client, people, course)
    sent = marketing(client, people["sravani"]["h"], lead["lead_id"], "course_recommendation", interest="web development")
    assert sent["status"] == "Queued" and sent["category"] == "Marketing" and sent["to_phone"] == NUMBER
    assert sent["body_text"].startswith("Hello Ananya Rao, are you planning your next learning step? The ")
    assert "interest in web development" in sent["body_text"] and sent["source_type"] == "lead"
    activities = call(client, "get", f"/leads/{lead['lead_id']}/activities", people["sravani"]["h"])
    assert any(a["activity_type"] == "WhatsApp" and a["direction"] == "Outbound" for a in activities)
    fake = provider(monkeypatch)
    totals = whatsapp.deliver()  # the enquiry acknowledgement and delivery plan messages go with it
    assert totals["sent"] == len(fake.sent)
    marketing_sent = [b for b in fake.sent if b["template"]["name"] == "nipuna_course_recommendation_mkt_v1"]
    assert len(marketing_sent) == 1 and marketing_sent[0]["to"] == NUMBER
    assert [p["text"] for p in marketing_sent[0]["template"]["components"][0]["parameters"]][0] == "Ananya Rao"


def test_a_template_goes_to_a_lead_once_a_day_and_needs_its_values(client, people, course):
    lead, person_id = consenting_lead(client, people, course)
    sravani = people["sravani"]["h"]
    marketing(client, sravani, lead["lead_id"], "new_batch")
    again = client.post(f"{API}/leads/{lead['lead_id']}/whatsapp/marketing", json={"template": "new_batch"}, headers=sravani)
    assert again.status_code == 422 and "already sent" in error_of(again)["message"]
    marketing(client, sravani, lead["lead_id"], "enquiry_followup")  # another template is fine
    no_course = create_lead(client, sravani, person={"full_name": "Ravi K", "phone": "90000 11111"})
    other = db.session.get(Lead, no_course["lead_id"]).person_id
    call(client, "put", f"/persons/{other}/whatsapp-consent", sravani, json={"status": "Explicit Consent"})
    missing = client.post(f"{API}/leads/{no_course['lead_id']}/whatsapp/marketing", json={"template": "course_brochure"}, headers=sravani)
    assert missing.status_code == 400 and "course_id" in str(error_of(missing))
    assert client.post(f"{API}/leads/{lead['lead_id']}/whatsapp/marketing", json={"template": "bogus"}, headers=sravani).status_code == 400
    assert client.post(f"{API}/leads/{lead['lead_id']}/whatsapp/marketing", json={"template": "new_batch"},
                       headers=people["mounika"]["h"]).status_code == 404


def test_stop_contact_and_a_withdrawn_consent_block_marketing(client, people, course, run_sql):
    lead, person_id = consenting_lead(client, people, course)
    sravani = people["sravani"]["h"]
    run_sql("UPDATE persons SET stop_contact_at = now(), stop_contact_by = :u, stop_contact_reason = 'Asked to stop' "
            "WHERE person_id = :p", u=people["bm"]["id"], p=person_id)
    stopped = client.post(f"{API}/leads/{lead['lead_id']}/whatsapp/marketing", json={"template": "course_brochure"}, headers=sravani)
    assert stopped.status_code == 422 and "Stop contact" in error_of(stopped)["message"]
    run_sql("UPDATE persons SET stop_contact_at = NULL, stop_contact_by = NULL, stop_contact_reason = NULL WHERE person_id = :p", p=person_id)
    call(client, "put", f"/persons/{person_id}/whatsapp-consent", sravani, json={"status": "Withdrawn"})
    withdrawn = client.post(f"{API}/leads/{lead['lead_id']}/whatsapp/marketing", json={"template": "course_brochure"}, headers=sravani)
    assert withdrawn.status_code == 422 and "withdrawn" in error_of(withdrawn)["message"]


def test_a_stale_callback_log_is_pruned(client, people, run_sql):
    callback(client, meta())
    run_sql("UPDATE whatsapp_webhook_log SET received_at = now() - interval '40 days'")
    from services import jobs

    assert jobs.cleanup()["whatsapp_callbacks_pruned"] == 1


# ---------------------------------------------------------------- db 044: the notifications switch and "send now"

def test_the_switch_mutes_automatic_messages_and_turning_it_on_records_consent(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    person_id = db.session.get(Lead, lead["lead_id"]).person_id
    off = call(client, "put", f"/persons/{person_id}/whatsapp-notifications", sravani, json={"enabled": False})
    assert off["notifications"] is False and off["consent"]["status"] == "Not Recorded"
    conversation = call(client, "get", f"/persons/{person_id}/whatsapp", people["accounts"]["h"])
    assert conversation["notifications"] is False
    person = db.session.get(Person, person_id)
    values = {"customer_name": person.full_name, "branch_name": "Guntur", "advance_amount": "500", "receipt_no": "R-1",
              "unallocated_credit": "500"}
    template = templates.ADVANCE_PAYMENT_VERIFIED
    values = {key: values.get(key, "x") for key in template.params}
    muted = whatsapp.queue(template, person=person, branch_id=1, source_type="payment", source_id=1,
                           event_key="test:muted", values=values)
    assert muted.status == "Skipped" and muted.skip_reason == whatsapp.NOTIFICATIONS_OFF
    staff = whatsapp.queue(template, person=person, branch_id=1, source_type="payment", source_id=1,
                           event_key="test:staff", values=values, to_phone=NUMBER, recipient_user_id=people["bm"]["id"])
    assert staff.status == "Queued"  # a staff alert about a muted learner still goes to staff
    on = call(client, "put", f"/persons/{person_id}/whatsapp-notifications", sravani, json={"enabled": True})
    assert on["notifications"] is True and on["consent"]["status"] == "Explicit Consent"
    assert on["consent"]["source"] == "Profile switch" and on["consent"]["by"] == people["sravani"]["id"]
    assert client.put(f"{API}/persons/{person_id}/whatsapp-notifications", json={"enabled": "yes"}, headers=sravani).status_code == 400
    assert client.put(f"{API}/persons/{person_id}/whatsapp-notifications", json={"enabled": False},
                      headers=people["mounika"]["h"]).status_code == 404


def test_a_muted_person_is_not_messaged_and_send_now_refuses(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    person_id = db.session.get(Lead, lead["lead_id"]).person_id
    call(client, "put", f"/persons/{person_id}/whatsapp-notifications", sravani, json={"enabled": True})
    call(client, "put", f"/persons/{person_id}/whatsapp-notifications", sravani, json={"enabled": False})
    refused = client.post(f"{API}/persons/{person_id}/whatsapp/send", json={"template": "course_brochure"}, headers=sravani)
    assert refused.status_code == 422 and "switched off" in error_of(refused)["message"]
    assert [r for r in rows() if r.category == "Marketing"] == []


def test_send_now_from_the_person_uses_their_latest_lead(client, people, course, monkeypatch):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    person_id = db.session.get(Lead, lead["lead_id"]).person_id
    call(client, "put", f"/persons/{person_id}/whatsapp-notifications", sravani, json={"enabled": True})
    sent = call(client, "post", f"/persons/{person_id}/whatsapp/send", sravani, 201, json={"template": "course_brochure"})
    assert sent["status"] == "Queued" and sent["category"] == "Marketing" and sent["source_id"] == lead["lead_id"]
    again = client.post(f"{API}/persons/{person_id}/whatsapp/send", json={"template": "course_brochure"}, headers=sravani)
    assert again.status_code == 422 and "already sent" in error_of(again)["message"]
    fake = provider(monkeypatch)
    whatsapp.deliver()
    assert any(b["template"]["name"] == "nipuna_course_brochure_mkt_v1" for b in fake.sent)
    assert client.post(f"{API}/persons/{person_id}/whatsapp/send", json={"template": "course_brochure"},
                       headers=people["mounika"]["h"]).status_code == 404


def test_a_notification_shows_the_whatsapp_alert_that_went_with_it(client, people, course):
    """The bell notification and the staff WhatsApp of one event: Skipped (no phone) reads "Not sent" with the reason;
    a notification with no alert has no WhatsApp channel."""
    flow = issued_invoice(client, people, course)
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    payment = call(client, "post", "/payments", sravani, 201, json={
        "lead_id": flow["lead"]["lead_id"], "amount": "500", "payment_mode_id": mode_id("CASH")})["payment"]
    verify_payment(client, accounts, payment["payment_id"])
    mine = call(client, "get", "/notifications", sravani)
    verified = [n for n in mine if "verified" in n["title"]]
    assert verified and verified[0]["external_channel"] == "WhatsApp"
    assert verified[0]["external_status"] in ("Not sent", "Queued", "Sent")
    if verified[0]["external_status"] == "Not sent":
        assert verified[0]["external_reason"] == "No WhatsApp number on file"
    plain = [n for n in mine if n["external_channel"] is None]
    assert all(n["external_status"] is None for n in plain)
