"""Forgot password with a WhatsApp code (db 046): POST /auth/forgot-password and POST /auth/reset-password."""
from datetime import timedelta

from sqlalchemy import select

from config.database import db
from models import AuditLog, PasswordResetCode, WhatsappOutbox
from services import password_reset, whatsapp
from services.whatsapp_templates import HIDDEN
from tests.conftest import PASSWORD
from tests.helpers import API
from tests.test_whatsapp import provider

PHONE = "+919876500321"
NEW_PASSWORD = "Fresh-Pass-2026"


def forgot(client, phone=PHONE):
    response = client.post(f"{API}/auth/forgot-password", json={"phone": phone})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["data"]


def reset(client, code, phone=PHONE, new_password=NEW_PASSWORD):
    return client.post(f"{API}/auth/reset-password", json={"phone": phone, "code": code, "new_password": new_password})


def messages():
    return db.session.execute(
        select(WhatsappOutbox).where(WhatsappOutbox.source_type == "password_reset").order_by(WhatsappOutbox.outbox_id)
    ).scalars().all()


def sent_code(fake) -> str:
    """The code as the provider received it (the CRM keeps only "[hidden]" once it is sent)."""
    return fake.sent[-1]["template"]["components"][0]["parameters"][0]["text"]


def later(monkeypatch, minutes):
    """Move the reset service's clock forward (created_at itself can't change: db 046 guard)."""
    moved = password_reset._now() + timedelta(minutes=minutes)
    monkeypatch.setattr(password_reset, "_now", lambda: moved)


def login(client, email, password):
    return client.post(f"{API}/auth/login", json={"email": email, "password": password})


def test_code_on_whatsapp_resets_the_password_and_signs_out(client, make_user, monkeypatch):
    fake = provider(monkeypatch)
    user = make_user(roles=[("SALES", 1)], phone="98765 00321")  # older rows may hold another format
    old_session = login(client, user.email, PASSWORD).get_json()["data"]["token"]

    answer = forgot(client, "9876500321")
    assert answer["resend_after_seconds"] == 60 and "If an active account" in answer["message"]
    (message,) = messages()
    assert (message.status, message.to_phone, message.person_id, message.recipient_user_id) == (
        "Queued", "919876500321", None, user.user_id)
    assert message.params == {"code": HIDDEN} and HIDDEN in message.body_text and message.category == "Authentication"
    stored = db.session.execute(select(PasswordResetCode)).scalar_one()
    assert len(stored.code_hash) == 64  # an HMAC, never the code

    whatsapp.deliver()
    code = sent_code(fake)
    assert len(code) == 6 and code.isdigit()
    assert fake.sent[-1]["template"]["name"] == "nipuna_crm_password_reset_code_auth_v1"
    assert db.session.get(WhatsappOutbox, message.outbox_id, populate_existing=True).secret_params is None

    assert reset(client, code).status_code == 204
    assert login(client, user.email, PASSWORD).status_code == 401
    assert login(client, user.email, NEW_PASSWORD).status_code == 200
    assert client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {old_session}"}).status_code == 401
    assert reset(client, code).status_code == 400  # spent
    actions = db.session.execute(select(AuditLog.action).where(AuditLog.entity_id == str(user.user_id))).scalars().all()
    assert {"PASSWORD_RESET_CODE_SENT", "PASSWORD_RESET_WITH_CODE"} <= set(actions)


def test_unknown_number_gets_the_same_answer_and_nothing_is_sent(client, make_user, monkeypatch):
    provider(monkeypatch)
    make_user(phone=PHONE, is_active=False)  # an inactive account never gets a code
    assert forgot(client) == forgot(client, "+919000000999")
    assert messages() == []
    assert reset(client, "123456").status_code == 400


def test_two_accounts_on_one_number_get_no_code(client, make_user, monkeypatch):
    provider(monkeypatch)
    make_user(phone=PHONE)
    make_user(phone="9876500321")
    forgot(client)
    assert messages() == []


def test_wrong_codes_count_and_kill_the_code(client, make_user, monkeypatch):
    fake = provider(monkeypatch)
    make_user(phone=PHONE)
    forgot(client)
    whatsapp.deliver()
    code = sent_code(fake)
    wrong = "000000" if code != "000000" else "111111"
    for attempt in range(1, 5):
        response = reset(client, wrong)
        assert response.status_code == 400 and response.get_json()["error"]["details"] == {
            "code": ["That code is wrong or has expired. Ask for a new one."]}
    assert db.session.execute(select(PasswordResetCode.attempts)).scalar_one() == 4
    assert reset(client, wrong).status_code == 400  # fifth wrong try retires it
    assert reset(client, code).status_code == 400


def test_short_password_does_not_spend_a_try(client, make_user, monkeypatch):
    fake = provider(monkeypatch)
    make_user(phone=PHONE)
    forgot(client)
    whatsapp.deliver()
    response = reset(client, sent_code(fake), new_password="short")
    assert response.status_code == 400 and "new_password" in response.get_json()["error"]["details"]
    assert db.session.execute(select(PasswordResetCode.attempts)).scalar_one() == 0
    assert reset(client, sent_code(fake)).status_code == 204


def test_expired_code_is_refused(client, make_user, monkeypatch):
    fake = provider(monkeypatch)
    make_user(phone=PHONE)
    forgot(client)
    whatsapp.deliver()
    later(monkeypatch, 11)
    assert reset(client, sent_code(fake)).status_code == 400


def test_resend_waits_a_minute_and_a_new_code_retires_the_old(client, make_user, monkeypatch):
    fake = provider(monkeypatch)
    make_user(phone=PHONE)
    forgot(client)
    forgot(client)  # too soon: still one code
    assert len(messages()) == 1
    whatsapp.deliver()
    first = sent_code(fake)

    later(monkeypatch, 2)
    forgot(client)
    whatsapp.deliver()
    second = sent_code(fake)
    assert len(messages()) == 2
    if first != second:
        assert reset(client, first).status_code == 400
    assert reset(client, second).status_code == 204


def test_hourly_limit(client, make_user, monkeypatch):
    provider(monkeypatch)
    make_user(phone=PHONE)
    for step in range(7):
        later(monkeypatch, 2 * step)
        forgot(client)
    assert len(messages()) == 5


def test_switched_off_whatsapp_records_a_skipped_message(app, client, make_user, monkeypatch):
    provider(monkeypatch)
    monkeypatch.setitem(app.config, "WHATSAPP_TEST_NUMBERS", "+919000000001")
    make_user(phone=PHONE)
    forgot(client)
    (message,) = messages()
    assert message.status == "Skipped" and "test number" in message.skip_reason
    assert message.secret_params is None  # forgotten straight away


def test_reset_code_message_is_never_resent(client, make_user, people, monkeypatch, app):
    provider(monkeypatch)
    monkeypatch.setitem(app.config, "WHATSAPP_ENABLED", False)
    make_user(phone=PHONE)
    forgot(client)
    (message,) = messages()
    response = client.post(f"{API}/whatsapp/messages/{message.outbox_id}/retry", headers=people["admin"]["h"], json={})
    assert response.status_code == 422 and "never sent twice" in response.get_json()["error"]["message"]


def test_validation(client):
    assert client.post(f"{API}/auth/forgot-password", json={"phone": "12"}).status_code == 400
    response = client.post(f"{API}/auth/reset-password", json={"phone": PHONE, "code": "12ab", "new_password": "x" * 12})
    assert response.status_code == 400 and response.get_json()["error"]["details"]["code"] == ["Enter the 6-digit code"]


def test_new_users_need_a_unique_mobile(client, make_user, login):
    headers = login(make_user().email)
    body = {"full_name": "Mounika", "email": "mounika@nipuna.test", "scopes": [{"role_code": "SALES", "branch_id": 2}]}
    assert client.post(f"{API}/users", json=body, headers=headers).status_code == 400
    created = client.post(f"{API}/users", json={**body, "phone": "98765 00321"}, headers=headers)
    assert created.status_code == 201 and created.get_json()["data"]["user"]["phone"] == PHONE
    clash = client.post(f"{API}/users", json={**body, "email": "other@nipuna.test", "phone": PHONE}, headers=headers)
    assert clash.status_code == 409 and "phone" in clash.get_json()["error"]["details"]
