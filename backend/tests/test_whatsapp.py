"""WhatsApp outbox (db 033): messages written with the change, the values each template gets, delivery to Pinbot,
the gates (switched off, test numbers, too old) and the rules that keep a failed message from breaking the change."""
import re
from datetime import date

import pytest
from sqlalchemy import select

from config.database import db
from models import Invoice, WhatsappOutbox
from services import whatsapp, whatsapp_events
from tests.helpers import admitted, call, issued_invoice, mode_id, record_payment, verify_payment

PHONE = "919876543210"  # the test person's "98765 43210"


@pytest.fixture(autouse=True)
def only_the_events_under_test(monkeypatch):
    """These tests are about payments, invoices and refunds; the enquiry and delivery-plan messages that the same
    set-up flows also queue are covered in test_whatsapp_phases.py."""
    for name in ("enquiry_received", "delivery_plan_accepted"):
        monkeypatch.setattr(whatsapp_events, name, lambda *args, **kwargs: None)


def rows():
    return db.session.execute(select(WhatsappOutbox).order_by(WhatsappOutbox.outbox_id)).scalars().all()


def of(template: str):
    """Messages of a template: "invoice_issued" (…_u_v1), or the full "enquiry_received_u_v3"."""
    name = template if re.search(r"_v\d+$", template) else f"{template}_u_v1"
    return [row for row in rows() if row.template_name == f"nipuna_{name}"]


class FakeProvider:
    """Replaces whatsapp._post; records every request body."""

    def __init__(self, answer=None):
        self.sent = []
        self.answer = answer or self.accepted

    def accepted(self, body):
        return whatsapp.Answer(200, {"messaging_product": "whatsapp", "contacts": [{"wa_id": body["to"]}],
                                     "messages": [{"id": f"wamid.TEST{len(self.sent)}", "message_status": "accepted"}]})

    def __call__(self, body):
        self.sent.append(body)
        return self.answer(body)


def answer(status, body=None, **kwargs):
    return lambda _: whatsapp.Answer(status, body, **kwargs)


def provider(monkeypatch, fake=None):
    fake = fake or FakeProvider()
    monkeypatch.setattr(whatsapp, "_post", fake)
    return fake


def make_due(run_sql, hours_ago=0):
    run_sql("UPDATE whatsapp_outbox SET next_attempt_at = now() - make_interval(hours => :h) - interval '1 second', "
            "locked_until = NULL", h=hours_ago)


def invoice_row(client, people, course, **kwargs):
    flow = issued_invoice(client, people, course, **kwargs)
    (row,) = of("invoice_issued")
    return flow, row


# ---------------------------------------------------------------- what is queued, and when

def test_invoice_issued_queues_the_message_with_the_plan_label(client, people, course):
    flow, row = invoice_row(client, people, course, plan="TWO_INSTALMENTS")
    invoice = flow["invoice"]
    assert row.status == "Queued" and row.to_phone == PHONE and row.category == "Utility"
    assert row.event_key == f"invoice-issued:{invoice['invoice_id']}"
    assert row.params["payment_plan"] == "50/50" and row.params["invoice_no"] == invoice["invoice_number"]
    assert row.params["invoice_channel"] == "your Nipuna counsellor"
    assert row.body_text == (
        f"Hello Ananya Rao, Nipuna Technologies, {row.params['branch_name']}, has issued invoice "
        f"{invoice['invoice_number']} for your accepted course plan. Invoice total: INR {invoice['billed_amount']}. "
        "Payment plan: 50/50. Please review the invoice through your Nipuna counsellor. This invoice is not a "
        "payment receipt.")
    assert row.source_type == "invoice" and row.source_id == invoice["invoice_id"] and row.queued_by


def test_the_same_event_never_makes_a_second_message(client, people, course):
    flow, row = invoice_row(client, people, course)
    invoice = db.session.get(Invoice, flow["invoice"]["invoice_id"])
    assert whatsapp_events.invoice_issued(invoice, "Full") is None
    assert len(of("invoice_issued")) == 1


def test_a_part_payment_sends_nothing_and_the_payment_that_clears_the_invoice_does(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS")
    invoice = flow["invoice"]
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    total = float(invoice["billed_amount"])
    first = record_payment(client, sravani, invoice["invoice_id"], total / 2)["payment"]
    verify_payment(client, accounts, first["payment_id"])
    assert of("invoice_balance_cleared") == [] and of("advance_payment_verified") == []

    second = record_payment(client, sravani, invoice["invoice_id"], total / 2)["payment"]
    verify_payment(client, accounts, second["payment_id"])
    (cleared,) = of("invoice_balance_cleared")
    assert cleared.params["invoice_no"] == invoice["invoice_number"] and cleared.to_phone == PHONE
    assert cleared.event_key == f"invoice-balance-cleared:{invoice['invoice_id']}:{second['payment_id']}"
    assert "remaining balance of INR 0.00" in cleared.body_text


def test_a_verified_advance_reports_the_credit_it_adds(client, people, course):
    flow = issued_invoice(client, people, course)
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    advance = call(client, "post", "/payments", sravani, 201, json={
        "lead_id": flow["lead"]["lead_id"], "amount": "500", "payment_mode_id": mode_id("CASH")})["payment"]
    assert of("advance_payment_verified") == []  # a claim is not a receipt
    verify_payment(client, accounts, advance["payment_id"])
    (row,) = of("advance_payment_verified")
    assert row.params["payment_amount"] == "500.00" and row.params["unallocated_credit"] == "500.00"
    assert row.params["receipt_no"].startswith("GNT-R-") and row.event_key == f"payment-verified:{advance['payment_id']}"
    assert "verified your advance payment of INR 500.00" in row.body_text


def refund_case(client, flow, people):
    return call(client, "post", "/refund-cases", people["bm"]["h"], 201, json={
        "admission_id": flow["admission"]["admission_id"], "request_reason": "Relocating abroad",
        "payment_ids": [flow["payment"]["payment_id"]]})


def test_refund_approved_then_paid_each_send_their_message(client, people, course):
    flow = admitted(client, people, course, amount="30000")
    admin, accounts = people["admin"]["h"], people["accounts"]["h"]
    case = refund_case(client, flow, people)
    cid, code = case["refund_case_id"], case["case_code"]
    assert of("refund_approved") == []

    call(client, "post", f"/refund-cases/{cid}/decide", admin, json={"decision": "Refund Approved", "amount": "12000"})
    (approved,) = of("refund_approved")
    assert approved.params == {"customer_name": "Ananya Rao", "branch_name": approved.params["branch_name"],
                               "refund_case_no": code, "refund_amount": "12000.00"}
    assert approved.event_key == f"refund-approved:{cid}" and approved.to_phone == PHONE
    assert "approved refund request" in approved.body_text and of("refund_payout_completed") == []

    call(client, "post", f"/refund-cases/{cid}/payout", accounts, json={"status": "Processing", "payout_reference": "NEFT-778"})
    assert of("refund_payout_completed") == []  # processing is not paid
    call(client, "post", f"/refund-cases/{cid}/reconcile", accounts)
    call(client, "post", f"/refund-cases/{cid}/payout", accounts, json={"status": "Completed"})
    (paid,) = of("refund_payout_completed")
    assert paid.params["payout_reference"] == "NEFT-778" and paid.params["refund_amount"] == "12000.00"
    assert paid.params["payout_date"] == date.today().strftime("%d %b %Y")
    assert paid.params["refund_case_no"] == code and paid.status == "Queued"


def test_refund_declined_and_waiver_decisions(client, people, course):
    flow = admitted(client, people, course, amount="30000")
    admin = people["admin"]["h"]
    case = refund_case(client, flow, people)
    cid = case["refund_case_id"]
    call(client, "post", f"/refund-cases/{cid}/decide", admin, json={"decision": "Rejected", "reason": "Outside policy"})
    (declined,) = of("refund_declined")
    assert declined.params["refund_case_no"] == case["case_code"] and "refund_amount" not in declined.params
    assert declined.body_text.startswith("Hello Ananya Rao, Nipuna Technologies, ")
    assert "The request was not approved" in declined.body_text
    assert of("refund_approved") == []

    before = len(rows())
    waiver = refund_case(client, flow, people)
    call(client, "post", f"/refund-cases/{waiver['refund_case_id']}/decide", admin,
         json={"decision": "Waiver Approved", "amount": "1000"})
    assert len(rows()) == before  # a waiver changes the balance, not the learner's money: nothing to send


# ---------------------------------------------------------------- never in the way of the change

def test_a_person_without_a_whatsapp_number_gets_a_skipped_row(client, people, course):
    from models import Person
    from services import whatsapp_templates

    flow, row = invoice_row(client, people, course)
    person = db.session.get(Person, row.person_id)
    person.whatsapp_number = "n/a"
    db.session.flush()
    skipped = whatsapp.queue(
        whatsapp_templates.INVOICE_ISSUED, person=person, branch_id=1, source_type="invoice",
        source_id=flow["invoice"]["invoice_id"], event_key="invoice-issued:extra",
        values={"customer_name": "A", "branch_name": "B", "invoice_no": "C", "invoice_total": "1.00",
                "payment_plan": "Full", "invoice_channel": "x"})
    assert skipped.status == "Skipped" and skipped.skip_reason == "No WhatsApp number on file"
    assert skipped.to_phone is None


def test_a_missing_value_is_skipped_with_the_reason(client, people, course):
    from models import Person
    from services import whatsapp_templates

    flow, row = invoice_row(client, people, course)
    person = db.session.get(Person, row.person_id)
    skipped = whatsapp.queue(
        whatsapp_templates.REFUND_PAYOUT_COMPLETED, person=person, branch_id=1, source_type="refund_case", source_id=1,
        event_key="refund-paid:1", values={"customer_name": "A", "branch_name": "B", "refund_amount": "1.00",
                                          "refund_case_no": "C", "payout_date": "01 Oct 2026", "payout_reference": None})
    assert skipped.status == "Skipped" and skipped.skip_reason == "Missing value(s): payout_reference"


def test_a_failure_while_queueing_never_breaks_the_invoice(client, people, course, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(whatsapp, "queue", broken)
    flow = issued_invoice(client, people, course)  # asserts the invoice came back 201
    assert flow["invoice"]["invoice_number"] and rows() == []


def test_a_message_is_fixed_once_written(client, people, course, run_sql):
    flow, row = invoice_row(client, people, course)
    for statement in ("UPDATE whatsapp_outbox SET body_text = 'other'", "UPDATE whatsapp_outbox SET to_phone = '919999999999'",
                      "DELETE FROM whatsapp_outbox"):
        try:
            run_sql(statement)
            raise AssertionError(f"{statement} should be refused")
        except Exception as exc:  # noqa: BLE001 - the trigger's check_violation
            db.session.rollback()
            assert "can't" in str(exc)


# ---------------------------------------------------------------- delivery

def test_delivery_posts_the_template_with_the_values_in_order(client, people, course, monkeypatch):
    flow, row = invoice_row(client, people, course, plan="TWO_INSTALMENTS")
    fake = provider(monkeypatch)
    assert whatsapp.deliver() == {"sent": 1}
    sent = db.session.get(WhatsappOutbox, row.outbox_id, populate_existing=True)
    assert sent.status == "Sent" and sent.provider_message_id == "wamid.TEST1" and sent.sent_at and sent.attempts == 1
    (body,) = fake.sent
    assert body["to"] == PHONE and body["type"] == "template" and body["messaging_product"] == "whatsapp"
    assert body["template"]["name"] == "nipuna_invoice_issued_u_v1" and body["template"]["language"] == {"code": "en"}
    values = [p["text"] for p in body["template"]["components"][0]["parameters"]]
    assert values == ["Ananya Rao", row.params["branch_name"], flow["invoice"]["invoice_number"],
                      flow["invoice"]["billed_amount"], "50/50", "your Nipuna counsellor"]
    assert whatsapp.deliver() == {}  # nothing left; a sent message is never sent twice


def test_a_refused_message_fails_with_the_providers_reason(client, people, course, monkeypatch):
    invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(answer(400, {"message": "Template not approved"})))
    assert whatsapp.deliver() == {"failed": 1}
    (row,) = rows()
    assert row.status == "Failed" and row.last_http_status == 400 and "Template not approved" in row.last_error


def test_a_server_error_retries_with_backoff_and_fails_after_the_last_attempt(client, people, course, monkeypatch, run_sql):
    invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(answer(503, {"message": "Busy"})))
    assert whatsapp.deliver() == {"retry": 1}
    row = db.session.get(WhatsappOutbox, rows()[0].outbox_id, populate_existing=True)
    assert row.status == "Queued" and row.attempts == 1 and row.locked_until is None
    assert whatsapp.deliver() == {}  # not due yet
    run_sql("UPDATE whatsapp_outbox SET attempts = :n", n=whatsapp.MAX_ATTEMPTS - 1)
    make_due(run_sql)
    assert whatsapp.deliver() == {"failed": 1}
    assert db.session.get(WhatsappOutbox, row.outbox_id, populate_existing=True).status == "Failed"


def test_a_bad_key_stops_the_run_and_keeps_the_message(client, people, course, monkeypatch):
    invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(answer(401, {"message": "Authentication Failed"})))
    assert whatsapp.deliver() == {"config_error": 1}
    (row,) = rows()
    assert row.status == "Queued" and row.locked_until is None and "Authentication Failed" in row.last_error


def test_an_unreachable_provider_retries_and_stops_the_run(client, people, course, monkeypatch):
    invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(answer(None, None, error="Provider unreachable: refused")))
    assert whatsapp.deliver() == {"retry": 1}
    (row,) = rows()
    assert row.status == "Queued" and row.attempts == 1


def test_a_timeout_is_never_resent_on_its_own(client, people, course, monkeypatch, run_sql):
    invoice_row(client, people, course)
    fake = provider(monkeypatch, FakeProvider(answer(None, None, error="Provider did not answer in time",
                                                     maybe_accepted=True)))
    assert whatsapp.deliver() == {"failed": 1}
    (row,) = rows()
    assert row.status == "Failed" and "may have been delivered" in row.last_error
    make_due(run_sql)
    assert whatsapp.deliver() == {} and len(fake.sent) == 1


def test_a_200_without_a_message_id_is_treated_as_unclear(client, people, course, monkeypatch):
    invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(answer(200, {"status": "ok"})))
    assert whatsapp.deliver() == {"failed": 1}
    assert "may have been delivered" in rows()[0].last_error


def test_switched_off_holds_the_messages_and_sends_nothing(client, people, course, monkeypatch, app):
    invoice_row(client, people, course)
    fake = provider(monkeypatch)
    app.config["WHATSAPP_ENABLED"] = False
    result = whatsapp.deliver()
    assert result["held"] == 1 and fake.sent == [] and rows()[0].status == "Queued"
    app.config["WHATSAPP_ENABLED"] = True
    app.config["WHATSAPP_API_KEY"] = None
    assert whatsapp.deliver()["held"] == 1 and fake.sent == []


def test_only_test_numbers_are_messaged_when_a_list_is_set(client, people, course, monkeypatch, app):
    invoice_row(client, people, course)
    fake = provider(monkeypatch)
    app.config["WHATSAPP_TEST_NUMBERS"] = "+91 93923 29248, 9985143865"
    assert whatsapp.deliver() == {"skipped": 1} and fake.sent == []
    (row,) = rows()
    assert row.status == "Skipped" and "test list" in row.skip_reason

    assert whatsapp.requeue([row.outbox_id]) == 1
    app.config["WHATSAPP_TEST_NUMBERS"] = "+91 98765 43210"
    assert whatsapp.deliver() == {"sent": 1} and [b["to"] for b in fake.sent] == [PHONE]


def test_a_message_that_waited_too_long_is_skipped(client, people, course, monkeypatch, run_sql):
    invoice_row(client, people, course)
    fake = provider(monkeypatch)
    make_due(run_sql, hours_ago=30)
    assert whatsapp.deliver() == {"skipped": 1} and fake.sent == []
    (row,) = rows()
    assert row.status == "Skipped" and "24 hours" in row.skip_reason


def test_requeue_sends_a_failed_message_again(client, people, course, monkeypatch):
    invoice_row(client, people, course)
    provider(monkeypatch, FakeProvider(answer(400, {"message": "Bad value"})))
    whatsapp.deliver()
    (row,) = rows()
    fake = provider(monkeypatch)
    assert whatsapp.requeue([row.outbox_id]) == 1
    assert whatsapp.deliver() == {"sent": 1} and len(fake.sent) == 1
    assert whatsapp.requeue([row.outbox_id]) == 0  # a Sent message can't be requeued


def test_summary_counts_by_status(client, people, course, monkeypatch):
    invoice_row(client, people, course)
    assert whatsapp.summary() == {"counts": {"Queued": 1}, "configured": True, "test_numbers_only": False}
    provider(monkeypatch)
    whatsapp.deliver()
    assert whatsapp.summary()["counts"] == {"Sent": 1}
