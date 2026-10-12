"""WhatsApp messages the LMS sends through the CRM (round 6, db 045): POST /lms/whatsapp, the checks, hidden values,
URL buttons, the gates, repeats, and WhatsappStatusUpdated events back to the LMS."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from config.database import db
from models import LmsOutbox, WhatsappOutbox
from services import whatsapp, whatsapp_inbound
from services.whatsapp_templates import HIDDEN
from tests.helpers import API, call
from tests.test_whatsapp import provider

KEY = {"X-Service-Key": "test-service-key"}
LMS_USER = "LMS-8f3a-test"
PHONE = "919876500777"
CANCELLED = "nipuna_lms_class_cancelled_u_v1"
CANCELLED_VALUES = ["Anvitha K.", "Guntur", "Hyperparameter Tuning", "Data Science", "Mon 12 Oct, 10:00 AM IST",
                    "the trainer is unwell", "a replacement class will be scheduled and shared with you"]


@pytest.fixture
def student(app, run_sql):
    return run_sql("INSERT INTO persons (full_name, phone, registered_branch_id, lms_user_id) "
                   "VALUES ('Anvitha K', '+919876500777', 1, :lms) RETURNING person_id", lms=LMS_USER).scalar_one()


def body(**overrides):
    data = {"template": CANCELLED, "language": "en", "lms_user_id": LMS_USER, "params": CANCELLED_VALUES,
            "dedupe_key": "class-cancelled:412:77", "occurred_at": datetime.now(timezone.utc).isoformat()}
    data.update(overrides)
    return {key: value for key, value in data.items() if value is not None}


def send(client, expected=200, headers=KEY, **overrides):
    return call(client, "post", "/lms/whatsapp", headers, expected, json=body(**overrides))


def row(outbox_id):
    return db.session.get(WhatsappOutbox, outbox_id, populate_existing=True)


def test_service_key_is_required(client):
    assert client.post(f"{API}/lms/whatsapp", json=body()).status_code == 401
    assert client.post(f"{API}/lms/whatsapp", json=body(), headers={"X-Service-Key": "wrong"}).status_code == 401


def test_queued_for_the_student_then_sent(client, student, monkeypatch):
    fake = provider(monkeypatch)
    answer = send(client)
    assert answer["status"] == "Queued"
    message = row(answer["outbox_id"])
    assert (message.person_id, message.branch_id, message.to_phone, message.source_type) == (student, 1, PHONE, "lms")
    assert message.body_text.startswith("Hello Anvitha K., Nipuna Technologies, Guntur, has cancelled your class")
    assert message.to_dict()["sent_by"] == "LMS"

    assert whatsapp.deliver()["sent"] == 1
    sent = fake.sent[0]
    assert sent["to"] == PHONE and sent["template"]["name"] == CANCELLED
    assert [p["text"] for p in sent["template"]["components"][0]["parameters"]] == CANCELLED_VALUES
    assert len(sent["template"]["components"]) == 1  # static button: nothing to fill

    again = send(client)  # the LMS retries: same answer, nothing sent twice
    assert again == {"status": "Sent", "provider_message_id": "wamid.TEST1", "delivery": "Sent",
                     "outbox_id": answer["outbox_id"]}
    assert db.session.execute(select(WhatsappOutbox).where(WhatsappOutbox.source_type == "lms")).scalars().all() \
        == [message]


def test_activation_token_is_hidden_and_forgotten_once_sent(client, student, monkeypatch):
    fake = provider(monkeypatch)
    answer = send(client, template="nipuna_lms_student_activation_link_u_v1",
                  params=["Anvitha K.", "Guntur", "NIT-STU-2026-004182", "13 Oct 2026, 6:00 PM IST"],
                  button_params=["kQ3v9xZp2LmN8rT4"], dedupe_key="activation-link:91")
    message = row(answer["outbox_id"])
    assert "kQ3v9xZp2LmN8rT4" not in message.body_text
    assert message.params["activation_token"] == HIDDEN
    assert message.secret_params == {"activation_token": "kQ3v9xZp2LmN8rT4"}

    whatsapp.deliver()
    button = fake.sent[0]["template"]["components"][1]
    assert button == {"type": "button", "sub_type": "url", "index": "0",
                      "parameters": [{"type": "text", "text": "kQ3v9xZp2LmN8rT4"}]}
    assert row(answer["outbox_id"]).secret_params is None  # cleared by the database once Sent


def test_reset_code_fills_its_copy_button(client, student, monkeypatch):
    fake = provider(monkeypatch)
    answer = send(client, template="nipuna_lms_password_reset_code_auth_v1", params=["482913"], lms_user_id=None,
                  to=PHONE, dedupe_key="pwd-reset:5:1")
    message = row(answer["outbox_id"])
    assert message.category == "Authentication" and message.person_id is None
    assert "482913" not in message.body_text and "482913" not in str(message.params)
    whatsapp.deliver()
    components = fake.sent[0]["template"]["components"]
    assert components[0]["parameters"] == [{"type": "text", "text": "482913"}]
    assert components[1]["parameters"] == [{"type": "text", "text": "482913"}]


def test_certificate_button_defaults_to_the_certificate_number(client, student, monkeypatch):
    fake = provider(monkeypatch)
    send(client, template="nipuna_lms_certificate_issued_u_v1", dedupe_key="certificate-issued:4:1",
         params=["Anvitha K.", "Guntur", "Course Completion Certificate", "Data Science", "NIT-CERT-2026-000123"])
    whatsapp.deliver()
    assert fake.sent[0]["template"]["components"][1]["parameters"] == [{"type": "text", "text": "NIT-CERT-2026-000123"}]


def test_staff_message_without_a_crm_person(client, people, monkeypatch):
    provider(monkeypatch)
    answer = send(client, template="nipuna_lms_staff_account_invite_u_v1", lms_user_id=None, to="+919876500888",
                  params=["Ravi Kumar", "Branch Manager", "Guntur", "13 Oct 2026, 6:00 PM IST"],
                  button_params=["pL7wQ2nX9vR4tK8m"], dedupe_key="staff-invite:3")
    message = row(answer["outbox_id"])
    assert (message.person_id, message.branch_id, message.to_phone) == (None, None, "919876500888")
    listed = call(client, "get", "/whatsapp/messages?sent_by=LMS", people["admin"]["h"])
    assert [(m["recipient_kind"], m["person_name"]) for m in listed] == [("Not in the CRM", None)]
    assert call(client, "get", "/whatsapp/messages?sent_by=LMS", people["bm"]["h"]) == []  # no branch: admins only

    whatsapp.deliver()
    db.session.execute(text("UPDATE whatsapp_outbox SET status = 'Failed', last_error = 'x' WHERE outbox_id = :id"),
                       {"id": answer["outbox_id"]})
    db.session.commit()
    response = client.post(f"{API}/whatsapp/messages/{answer['outbox_id']}/retry", headers=people["admin"]["h"], json={})
    assert response.status_code == 422 and "LMS sends it again" in response.get_json()["error"]["message"]
    assert client.post(f"{API}/lms/whatsapp", headers=KEY, json=body(
        template="nipuna_lms_staff_account_invite_u_v1", dedupe_key="staff-invite:3")).status_code == 422


@pytest.mark.parametrize("setup, reason", [
    ({"WHATSAPP_ENABLED": False}, "switched off in the CRM"),
    ({"WHATSAPP_TEST_NUMBERS": "+919392329248"}, "not on the test list"),
])
def test_gates_answer_skipped(app, client, student, monkeypatch, setup, reason):
    fake = provider(monkeypatch)
    app.config.update(setup)
    answer = send(client)
    assert answer["status"] == "Skipped" and reason in answer["reason"]
    whatsapp.deliver()
    assert fake.sent == [] and row(answer["outbox_id"]).status == "Skipped"


def test_too_old_and_muted_are_skipped(client, student, run_sql):
    old = (datetime.now(timezone.utc) - timedelta(hours=49)).isoformat()
    assert "more than 48 hours" in send(client, occurred_at=old, dedupe_key="old:1")["reason"]
    run_sql("UPDATE persons SET whatsapp_notifications = FALSE WHERE person_id = :id", id=student)
    assert send(client, dedupe_key="muted:1")["reason"] == whatsapp.NOTIFICATIONS_OFF


def test_unknown_student_without_a_number_is_skipped(client):
    assert send(client, lms_user_id="LMS-nobody")["reason"] == "No WhatsApp number on file"


def test_bad_requests(client, student):
    def error(expected, **overrides):
        response = client.post(f"{API}/lms/whatsapp", headers=KEY, json=body(**overrides))
        assert response.status_code == expected, response.get_json()
        return response.get_json()["error"]

    assert "not an LMS WhatsApp template" in error(422, template="nipuna_batch_allocated_u_v1")["message"]
    assert "approved in 'en' only" in error(422, language="te")["message"]
    assert "takes 7 value(s), not 2" in error(400, params=["a", "b"])["details"]["params"][0]
    assert "line break" in error(400, params=CANCELLED_VALUES[:-1] + ["two\nlines"])["details"]["params"][0]
    assert "takes 1 button value(s), not 0" in error(
        400, template="nipuna_lms_student_activation_link_u_v1", params=["A", "Guntur", "NIT-STU-1", "13 Oct"]
    )["details"]["button_params"][0]
    assert "lms_user_id" in error(400, lms_user_id=None)["details"]["to"][0]
    assert "country code" in error(400, to="98765 43210")["details"]["to"][0]
    assert error(400, dedupe_key=None)["details"]["dedupe_key"] == ["Required"]


def test_status_changes_go_back_to_the_lms(app, client, student, monkeypatch):
    provider(monkeypatch)
    app.config["LMS_WHATSAPP_STATUS_EVENTS"] = True
    answer = send(client)
    whatsapp.deliver()
    whatsapp_inbound.apply_status({"id": "wamid.TEST1", "status": "delivered", "timestamp": "1760000000"})
    db.session.flush()
    events = db.session.execute(select(LmsOutbox).where(LmsOutbox.event_type == "WhatsappStatusUpdated")
                                .order_by(LmsOutbox.outbox_id)).scalars().all()
    assert [(e.record_key, e.source_version, e.payload["status"]) for e in events] == [
        (f"whatsapp:{answer['outbox_id']}", 1, "Sent"), (f"whatsapp:{answer['outbox_id']}", 2, "Delivered")]
    assert events[0].payload["dedupe_key"] == "class-cancelled:412:77"
    assert events[0].payload["provider_message_id"] == "wamid.TEST1"


def test_no_status_events_while_switched_off(client, student, monkeypatch):
    provider(monkeypatch)
    send(client)
    whatsapp.deliver()
    assert db.session.execute(select(LmsOutbox).where(LmsOutbox.event_type == "WhatsappStatusUpdated")).first() is None
