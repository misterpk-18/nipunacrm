"""Payment UX (db 038): proof required for non-cash tenders, the token-first split and per-line `more_to_admit`, and the
owner counsellor hearing the outcome (bell, plus a WhatsApp staff alert that stays off until its setting is on)."""
import io
from decimal import Decimal

from sqlalchemy import select, text

from config.database import db
from models import Notification, User, WhatsappOutbox
from repositories import users as users_repo
from tests.helpers import (
    API, accept_delivery_plan, call, convert_lead, create_invoice, create_lead, deal_course, mode_id, plan_schedule,
    ready_deal, record_payment, verify_payment,
)

STAFF_TEMPLATE = "nipuna_staff_payment_status_v1"


def two_course_invoice(client, people, course):
    """Data Science ₹30,000 (line 1) and Foundation ₹20,000 (line 2) on one invoice. Returns (invoice, {course: line})."""
    sravani = people["sravani"]["h"]
    lead, _, _ = ready_deal(client, people, course)
    other = create_lead(client, sravani, person=None, person_id=lead["person"]["person_id"], course_id=deal_course(1))
    convert_lead(client, sravani, other["lead_id"])
    discussion = call(client, "post", f"/leads/{other['lead_id']}/fee-discussions", sravani, 201, json={})
    version = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201, json={})
    call(client, "post", f"/fee-discussion-versions/{version['version_id']}/approve", sravani)
    accept_delivery_plan(client, sravani, other["lead_id"])
    invoice = create_invoice(client, sravani, [lead["lead_id"], other["lead_id"]],
                             installments=plan_schedule("TWO_INSTALMENTS", 50000))
    detail = call(client, "get", f"/invoices/{invoice['invoice_id']}", sravani)
    return detail, {line["lead"]["lead_id"]: line for line in detail["lines"]}, (lead, other)


def staff_rows():
    db.session.expire_all()
    return db.session.execute(select(WhatsappOutbox).where(WhatsappOutbox.template_name == STAFF_TEMPLATE)
                              .order_by(WhatsappOutbox.outbox_id)).scalars().all()


# ---------------------------------------------------------------- proof

def test_proof_is_required_for_every_mode_but_cash(client, people, course):
    detail, _, _ = two_course_invoice(client, people, course)
    sravani = people["sravani"]["h"]
    body = {"invoice_id": detail["invoice_id"], "amount": "1000", "reference": "UTR1"}

    for code in ("UPI_BANK", "PAYMENT_LINK"):
        refused = client.post(f"{API}/payments", headers=sravani, json={**body, "payment_mode_id": mode_id(code)})
        assert refused.status_code == 400, code
        assert "proof" in refused.get_json()["error"]["details"]
    cheque = client.post(f"{API}/payments", headers=sravani, json={
        **body, "payment_mode_id": mode_id("CHEQUE"), "exception_approved_by": people["bm"]["id"]})
    assert cheque.status_code == 400 and "proof" in cheque.get_json()["error"]["details"]
    assert db.session.execute(text("SELECT count(*) FROM payments")).scalar() == 0

    # Cash needs none
    cash = call(client, "post", "/payments", sravani, 201, json={**body, "payment_mode_id": mode_id("CASH")})
    assert cash["payment"]["proof_file_path"] is None

    # With the file attached the same transfer is recorded, and Accounts can open the proof
    attached = client.post(f"{API}/payments", headers=sravani, content_type="multipart/form-data", data={
        **{k: str(v) for k, v in body.items()}, "payment_mode_id": str(mode_id("UPI_BANK")),
        "proof": (io.BytesIO(b"\x89PNG proof"), "utr.png")})
    assert attached.status_code == 201, attached.get_json()
    payment_id = attached.get_json()["data"]["payment"]["payment_id"]
    proof = client.get(f"{API}/payments/{payment_id}/proof", headers=people["accounts"]["h"])
    assert proof.status_code == 200 and proof.data == b"\x89PNG proof"
    assert client.get(f"{API}/payments/{cash['payment']['payment_id']}/proof", headers=people["accounts"]["h"]).status_code == 404
    assert client.get(f"{API}/payments/{payment_id}/proof", headers=people["mounika"]["h"]).status_code == 404  # other branch


# ---------------------------------------------------------------- token-first split and more_to_admit

def test_default_split_is_token_first_and_lines_report_more_to_admit(client, people, course):
    detail, lines, (first, second) = two_course_invoice(client, people, course)
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    ds, fnd = lines[first["lead_id"]], lines[second["lead_id"]]
    assert (ds["more_to_admit"], fnd["more_to_admit"]) == ("1000.00", "1000.00")

    # ₹1,500 with no allocations: oldest-first would put it all on Data Science; token-first gives each course its token
    recorded = record_payment(client, sravani, detail["invoice_id"], "1500")["payment"]
    assert {a["course"]["course_title"]: a["amount"] for a in recorded["allocations"]} == {
        ds["course"]["course_title"]: "1000.00", fnd["course"]["course_title"]: "500.00"}

    # Pending money is not verified money: more_to_admit only moves on verification
    now = {l["lead"]["lead_id"]: l for l in call(client, "get", f"/invoices/{detail['invoice_id']}", sravani)["lines"]}
    assert now[first["lead_id"]]["more_to_admit"] == "1000.00" and now[second["lead_id"]]["more_to_admit"] == "1000.00"
    verified = verify_payment(client, accounts, recorded["payment_id"])
    assert [a["course"]["course_title"] for a in verified["admissions_created"]] == [ds["course"]["course_title"]]
    now = {l["lead"]["lead_id"]: l for l in call(client, "get", f"/invoices/{detail['invoice_id']}", sravani)["lines"]}
    assert now[first["lead_id"]]["more_to_admit"] == "0.00"      # admitted
    assert now[second["lead_id"]]["more_to_admit"] == "500.00"   # ₹500 more verified to admit

    # The next default split gives the course that still needs its token that first, the rest goes oldest first
    again = record_payment(client, sravani, detail["invoice_id"], "700")["payment"]
    assert {a["course"]["course_title"]: Decimal(a["amount"]) for a in again["allocations"]} == {
        fnd["course"]["course_title"]: Decimal("500.00"), ds["course"]["course_title"]: Decimal("200.00")}


def test_split_never_goes_beyond_what_is_left_on_a_course(client, people, course):
    detail, lines, (first, second) = two_course_invoice(client, people, course)
    sravani = people["sravani"]["h"]
    # The whole invoice: every course gets exactly its own charge
    recorded = record_payment(client, sravani, detail["invoice_id"], "50000")["payment"]
    assert sorted(Decimal(a["amount"]) for a in recorded["allocations"]) == [Decimal("20000"), Decimal("30000")]


# ---------------------------------------------------------------- the owner hears the outcome

def tell_everything_is_ready(people, phone="98765 00001"):
    db.session.get(User, people["sravani"]["id"]).phone = phone
    db.session.commit()


def test_owner_gets_a_bell_when_a_claim_is_verified_or_fails(client, people, course):
    detail, lines, (first, second) = two_course_invoice(client, people, course)
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    good = record_payment(client, sravani, detail["invoice_id"], "2000")["payment"]
    bad = record_payment(client, sravani, detail["invoice_id"], "900")["payment"]

    verify_payment(client, accounts, good["payment_id"])
    call(client, "post", f"/payments/{bad['payment_id']}/fail", accounts, json={"failure_reason": "UTR not in the bank statement"})

    mine = db.session.execute(select(Notification).where(
        Notification.recipient_user_id == people["sravani"]["id"],
        Notification.event_key.like("payment.%"))).scalars().all()
    by_kind = {n.event_key.split(":")[0]: n for n in mine}
    verified, failed = by_kind["payment.verified"], by_kind["payment.failed"]
    assert good["transaction_number"] in verified.title and "Receipt GNT-R-" in verified.body
    assert failed.title.startswith(f"Payment {bad['transaction_number']} FAILED") and "UTR not in the bank statement" in failed.body
    assert verified.entity_type == failed.entity_type == "lead"  # the bell links to the deal
    # The deciding Accounts user is not told about their own decision; nobody else is
    assert db.session.execute(select(Notification).where(
        Notification.event_key.regexp_match(r"^payment\.(verified|failed):"),
        Notification.recipient_user_id.not_in([people["sravani"]["id"], *users_repo.admin_user_ids()]))).first() is None
    # And the bell is readable through the API
    listed = call(client, "get", "/notifications", sravani)
    assert any(n["title"] == failed.title for n in listed)


def test_whatsapp_staff_alert_is_off_until_its_setting_is_on(client, people, course):
    tell_everything_is_ready(people)
    detail, _, _ = two_course_invoice(client, people, course)
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    assert db.session.execute(text("SELECT setting_value FROM app_settings WHERE setting_key = "
                                   "'whatsapp_staff_alerts_enabled'")).scalar() is True  # on by default (db 042)
    db.session.execute(text("UPDATE app_settings SET setting_value = 'false' "
                            "WHERE setting_key = 'whatsapp_staff_alerts_enabled'"))
    db.session.commit()

    off = record_payment(client, sravani, detail["invoice_id"], "1000")["payment"]
    verify_payment(client, accounts, off["payment_id"])
    assert staff_rows() == []  # nothing queued while the setting is off

    db.session.execute(text("UPDATE app_settings SET setting_value = 'true' "
                            "WHERE setting_key = 'whatsapp_staff_alerts_enabled'"))
    db.session.commit()
    ok = record_payment(client, sravani, detail["invoice_id"], "1000")["payment"]
    verify_payment(client, accounts, ok["payment_id"])
    bad = record_payment(client, sravani, detail["invoice_id"], "500")["payment"]
    call(client, "post", f"/payments/{bad['payment_id']}/fail", accounts, json={"failure_reason": "Cheque\nbounced"})

    verified_row, failed_row = staff_rows()
    assert verified_row.recipient_user_id == people["sravani"]["id"]  # a staff message, hidden from the learner's chat
    assert verified_row.status == "Queued" and verified_row.to_phone == "919876500001"
    assert verified_row.params["staff_name"] == "Sravani" and verified_row.params["outcome"] == "verified"
    assert verified_row.params["transaction_no"] == ok["transaction_number"]
    assert verified_row.params["outcome_detail"].startswith("Receipt GNT-R-")
    assert verified_row.event_key == f"staff-payment-verified:{ok['payment_id']}:{people['sravani']['id']}"
    assert failed_row.params["outcome"] == "failed verification"
    assert failed_row.params["outcome_detail"] == "Reason: Cheque bounced."  # one line: a template value can't hold line breaks
    assert "Accounts at Nipuna Technologies has reviewed payment claim" in failed_row.body_text


def test_staff_without_a_phone_is_recorded_as_skipped_not_an_error(client, people, course):
    db.session.execute(text("UPDATE app_settings SET setting_value = 'true' WHERE setting_key = 'whatsapp_staff_alerts_enabled'"))
    db.session.commit()
    detail, _, _ = two_course_invoice(client, people, course)
    claim = record_payment(client, people["sravani"]["h"], detail["invoice_id"], "1000")["payment"]
    verify_payment(client, people["accounts"]["h"], claim["payment_id"])  # still verifies
    (row,) = staff_rows()
    assert row.status == "Skipped" and row.skip_reason == "No WhatsApp number on file"
    assert row.to_phone is None  # never the learner's own number
