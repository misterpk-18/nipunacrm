"""Shared test helpers (API calls that set up records). Fixtures live in conftest.py."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from config.database import db
from models import ContactChannel, EntryMethod, LeadSource

API = "/api/v1"
IST = timezone(timedelta(hours=5, minutes=30))


def lookup_id(model, code):
    return db.session.execute(select(model).where(model.code == code)).scalar_one().id


def future(hours=24):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def past(hours=24):
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


def lead_body(**overrides):
    body = {
        "branch_id": 1,
        "person": {"full_name": "Ananya Rao", "phone": "98765 43210", "email": "Ananya@Example.test"},
        "lead_source_id": lookup_id(LeadSource, "GOOGLE_ADS"),
        "contact_channel_id": lookup_id(ContactChannel, "WEB_FORM"),
        "entry_method_id": lookup_id(EntryMethod, "GOOGLE_ADS_FORM"),
    }
    return {**body, **overrides}


def create_lead(client, headers, **overrides):
    response = client.post(f"{API}/leads", json=lead_body(**overrides), headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["data"]


def call(client, method, url, headers, expected=200, **kwargs):
    """Make a request and assert its status; returns the response's data."""
    response = getattr(client, method)(f"{API}{url}", headers=headers, **kwargs)
    assert response.status_code == expected, (url, response.get_json())
    body = response.get_json()
    return body.get("data") if body else None


def error_of(response):
    return response.get_json()["error"]


# ---------------------------------------------------------------- sales-to-cash chain

def priced_lead(client, people, course, headers=None, **version):
    """Lead (Sravani, Guntur) + fee discussion + first version. Returns (lead, discussion, version)."""
    headers = headers or people["sravani"]["h"]
    lead = create_lead(client, headers, course_id=course)
    discussion = call(client, "post", f"/leads/{lead['lead_id']}/fee-discussions", headers, 201, json={})
    ver = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", headers, 201,
               json=version)
    return lead, discussion, ver


def plan_code_id(code):
    from models import PaymentPlan

    return db.session.execute(select(PaymentPlan).where(PaymentPlan.plan_code == code)).scalar_one().payment_plan_id


def issued_invoice(client, people, course, plan="FULL", agreed_due_days=None, seat_type="Confirmed Seat", **version):
    """Priced, approved (standard price), plan accepted, invoice issued. Returns dict of the pieces."""
    headers = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, payment_plan_id=plan_code_id(plan), **version)
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", headers)
    plan_body = {"version_id": ver["version_id"], "delivery_mode": "Classroom", "seat_type": seat_type}
    if seat_type == "Future Plan":
        plan_body["planned_start_date"] = (datetime.now(IST) + timedelta(days=30)).date().isoformat()
    call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/accept-plan", headers, json=plan_body)
    body = {"agreed_due_days": agreed_due_days} if agreed_due_days else {}
    invoice = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/invoice", headers, 201, json=body)
    return {"lead": lead, "discussion": discussion, "version": ver, "invoice": invoice}


def mode_id(code):
    from models import PaymentMode

    return lookup_id(PaymentMode, code)


def record_payment(client, headers, invoice_id, amount, expected=201, **extra):
    body = {"invoice_id": invoice_id, "amount": str(amount), "payment_mode_id": mode_id("UPI_BANK"),
            "reference": "UTR123456", **extra}
    return call(client, "post", "/payments", headers, expected, json=body)


def paid_invoice(client, people, course, amount=None, **kwargs):
    """Issued invoice with one verified payment (full amount unless given)."""
    flow = issued_invoice(client, people, course, **kwargs)
    invoice = flow["invoice"]
    payment = record_payment(client, people["sravani"]["h"], invoice["invoice_id"], amount or invoice["billed_amount"])
    payment = payment["payment"]
    call(client, "post", f"/payments/{payment['payment_id']}/verify", people["accounts"]["h"])
    return {**flow, "payment": payment}


def admitted(client, people, course, **kwargs):
    flow = paid_invoice(client, people, course, **kwargs)
    admission = call(client, "post", "/admissions", people["sravani"]["h"], 201,
                     json={"invoice_id": flow["invoice"]["invoice_id"]})
    return {**flow, "admission": admission}


def backdate_installment(run_sql, invoice_id, installment_no, days_ago):
    """Make an instalment overdue (the guard trigger keeps real edits inside the plan window)."""
    run_sql("ALTER TABLE installments DISABLE TRIGGER trg_installments_guard")
    run_sql("UPDATE installments SET due_date = current_date - :d WHERE invoice_id = :i AND installment_no = :n",
            d=days_ago, i=invoice_id, n=installment_no)
    run_sql("ALTER TABLE installments ENABLE TRIGGER trg_installments_guard")
