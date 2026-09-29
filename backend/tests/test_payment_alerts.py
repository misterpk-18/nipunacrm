"""Instalment alerts (db 018): long gap after a verified payment, instalments due within 2 days, dashboard tile."""
from datetime import date, timedelta

from sqlalchemy import select

from config.database import db
from models import Notification
from services import jobs
from tests.helpers import API, call, issued_invoice, record_payment, verify_payment


def _in(days):
    return (date.today() + timedelta(days=days)).isoformat()


def _schedule(*rows):
    return [{"due_date": _in(days), "amount": amount} for days, amount in rows]


def _recipients(rule_code):
    rows = db.session.execute(select(Notification).where(Notification.event_key.like(f"{rule_code}:%"))).scalars()
    return {n.recipient_user_id for n in rows}


def _pay_and_verify(client, people, invoice_id, amount):
    payment = record_payment(client, people["sravani"]["h"], invoice_id, amount)["payment"]
    verify_payment(client, people["accounts"]["h"], payment["payment_id"])
    return payment


def test_long_gap_alerts_money_staff_and_lists_the_person(client, people, course):
    # ₹1,000 token today, the rest in 45 days: a 45-day gap after the token (alert above 30 days)
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS",
                          installments=_schedule((0, "1000"), (45, "29000")))
    invoice_id = flow["invoice"]["invoice_id"]
    _pay_and_verify(client, people, invoice_id, "1000")

    expected = {people[name]["id"] for name in ("sravani", "bm", "accounts", "admin", "founder")}
    assert _recipients("gap") >= expected  # owner, Branch Manager, Accounts, Founder / CEO, Super Admin
    assert people["mounika"]["id"] not in _recipients("gap")  # other branch's counsellor

    gaps = call(client, "get", "/collections/payment-gaps", people["bm"]["h"])
    assert [(g["invoice_number"], g["gap_days"], g["next_due_date"]) for g in gaps] == [
        (flow["invoice"]["invoice_number"], 45, _in(45))]
    assert gaps[0]["person"]["full_name"] == "Ananya Rao" and gaps[0]["outstanding"] == "29000.00"
    assert call(client, "get", "/collections/payment-gaps", people["mounika"]["h"]) == []  # other branch
    assert client.get(f"{API}/collections/payment-gaps", headers=people["trainer"]["h"]).status_code == 403

    tiles = call(client, "get", "/dashboard", people["bm"]["h"])["tiles"]
    assert tiles["long_gap_plans"] == {"count": 1, "outstanding": "29000.00"}


def test_no_alert_when_the_next_instalment_is_close(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS",
                          installments=_schedule((0, "15000"), (20, "15000")))
    _pay_and_verify(client, people, flow["invoice"]["invoice_id"], "15000")
    assert _recipients("gap") == set()
    assert call(client, "get", "/collections/payment-gaps", people["bm"]["h"]) == []
    assert call(client, "get", "/dashboard", people["bm"]["h"])["tiles"]["long_gap_plans"]["count"] == 0


def test_due_soon_job_alerts_owner_accounts_and_manager(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS",
                          installments=_schedule((0, "15000"), (2, "15000")))
    _pay_and_verify(client, people, flow["invoice"]["invoice_id"], "15000")  # instalment 1 paid

    assert jobs.payment_alerts.due_soon() == 1  # only instalment 2 (due in 2 days) is unpaid and due soon
    notes = db.session.execute(select(Notification).where(Notification.event_key.like("due-soon:%"))).scalars().all()
    assert {n.recipient_user_id for n in notes} == {people[n]["id"] for n in ("sravani", "accounts", "bm")}
    assert notes[0].title.startswith("Instalment 2 due on ") and "Ananya Rao · ₹15000.00" in notes[0].title
    jobs.payment_alerts.due_soon()  # running again sends nothing new
    assert db.session.execute(select(Notification).where(Notification.event_key.like("due-soon:%"))).scalars().all() \
        == notes
    assert "dues-due-soon" in jobs.JOBS
