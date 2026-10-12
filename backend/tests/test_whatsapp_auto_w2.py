"""Automatic WhatsApp reminders for unpaid instalments: 3 days before, on the due date, 3 days after."""
import pytest
from sqlalchemy import text

from config.database import db
from services import collections as collections_service
from services import jobs, reports
from tests.helpers import backdate_installment, issued_invoice, record_payment, verify_payment
from tests.test_whatsapp import of, rows


def reminders():
    return [r for r in rows() if r.source_type == "invoice_due"]


def plan(client, people, course, run_sql, first, second):
    """Two instalments, due `first` / `second` days ago (negative = in the future)."""
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS", amount="15000")
    invoice_id = flow["invoice"]["invoice_id"]
    backdate_installment(run_sql, invoice_id, 1, first)
    backdate_installment(run_sql, invoice_id, 2, second)
    return flow, invoice_id


def first_amount(invoice_id):
    return db.session.execute(text("SELECT amount_due FROM installments WHERE invoice_id = :i AND installment_no = 1"),
                              {"i": invoice_id}).scalar()


@pytest.mark.parametrize("days_ago, template, stage", [(-3, "instalment_due", "before"), (0, "instalment_due", "today"),
                                                       (3, "instalment_overdue", "overdue")])
def test_each_stage_sends_the_right_template(client, people, course, run_sql, days_ago, template, stage):
    flow, invoice_id = plan(client, people, course, run_sql, days_ago, -40)
    jobs.collections_reminders()
    (row,) = of(template)
    assert row.status == "Queued" and row.category == "Utility" and row.source_id == invoice_id
    assert row.event_key.endswith(f"-{stage}")
    assert row.params["invoice_no"] == flow["invoice"]["invoice_number"] and row.params["installment_no"] == "1"
    assert row.params["amount_due"] == f"{first_amount(invoice_id):.2f}" and row.params["invoice_channel"] == "your Nipuna counsellor"
    assert ("ignore this message" in row.body_text) == (template == "instalment_due")
    assert len(reminders()) == 1


def test_other_days_send_nothing(client, people, course, run_sql):
    plan(client, people, course, run_sql, 1, -40)
    assert collections_service.send_learner_reminders(reports.business_now().date()) == 0
    assert reminders() == []


def test_the_message_is_sent_once_per_instalment_and_stage(client, people, course, run_sql):
    plan(client, people, course, run_sql, 3, -40)
    jobs.collections_reminders()
    jobs.collections_reminders()
    (row,) = reminders()
    assert row.event_key.startswith("due-") and row.event_key.endswith("-overdue")
    assert row.params["installment_no"] == "1"


def test_contact_hold_paid_cancelled_and_stop_contact_are_skipped(client, people, course, run_sql):
    today = reports.business_now().date()
    # contact hold: a payment is waiting for verification
    flow, invoice_id = plan(client, people, course, run_sql, 3, -40)
    record_payment(client, people["sravani"]["h"], invoice_id, "1000")
    assert collections_service.send_learner_reminders(today) == 0
    # stop contact
    flow2, invoice2 = plan(client, people, course, run_sql, 3, -40)
    run_sql("UPDATE persons SET stop_contact_at = now(), stop_contact_reason = 'asked to stop'")
    assert collections_service.send_learner_reminders(today) == 0
    run_sql("UPDATE persons SET stop_contact_at = NULL, stop_contact_reason = NULL")
    # cancelled invoice
    run_sql("UPDATE invoices SET status = 'Cancelled', cancel_reason = 'test' WHERE invoice_id = :i", i=invoice2)
    assert collections_service.send_learner_reminders(today) == 0
    assert reminders() == []


def test_a_fully_paid_instalment_is_not_chased(client, people, course, run_sql):
    flow, invoice_id = plan(client, people, course, run_sql, 3, -40)
    claim = record_payment(client, people["sravani"]["h"], invoice_id, first_amount(invoice_id))  # covers instalment 1, oldest first
    verify_payment(client, people["accounts"]["h"], claim["payment"]["payment_id"])
    assert collections_service.send_learner_reminders(reports.business_now().date()) == 0


def test_two_instalments_on_the_same_day_send_only_the_earliest(client, people, course, run_sql):
    flow, invoice_id = plan(client, people, course, run_sql, 3, -3)  # +3 overdue and -3 before, same day
    assert collections_service.send_learner_reminders(reports.business_now().date()) == 1
    (row,) = reminders()
    assert row.params["installment_no"] == "1" and row.event_key.endswith("-overdue")
    # a re-run the same day adds nothing
    assert collections_service.send_learner_reminders(reports.business_now().date()) == 0
    assert len(reminders()) == 1
