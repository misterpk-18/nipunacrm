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


QUALIFICATION_CHECKS = (
    "Genuine intent confirmed", "Reachable contact confirmed", "Intended course(s) understood",
    "Branch and delivery mode discussed", "Exact next action agreed", "Possible identity match reviewed",
)


def qualify_lead(client, headers, lead_id):
    for check in QUALIFICATION_CHECKS:
        call(client, "put", f"/leads/{lead_id}/qualification/checks", headers, json={"check": check, "reviewed": True})
    return call(client, "post", f"/leads/{lead_id}/qualify", headers)


def deal_course(branch_id):
    """A course offered at the branch (created on first use), for leads that have none yet."""
    from models import Branch, Course, CourseBranch

    code = f"NIT-CRS-9{branch_id:02d}"
    course = db.session.execute(select(Course).where(Course.course_code == code)).scalar_one_or_none()
    if course is None:
        branch = db.session.get(Branch, branch_id)
        course = Course(course_code=code, course_title=f"Foundation {branch.city}", category="General",
                        standard_fee=20000, branch_links=[CourseBranch(branch_code=branch.branch_code)])
        db.session.add(course)
        db.session.commit()
    return course.course_id


def convert_lead(client, headers, lead_id, course_ids=None, **extra):
    """Qualify (all six checks) and convert to a deal. Course defaults to the lead's own course."""
    lead = call(client, "get", f"/leads/{lead_id}", headers)
    qualify_lead(client, headers, lead_id)
    course_ids = course_ids or [lead["course"]["course_id"] if lead["course"] else deal_course(lead["branch"]["branch_id"])]
    return call(client, "post", f"/leads/{lead_id}/convert", headers, json={"course_ids": course_ids, **extra})


def create_deal(client, headers, **overrides):
    """A lead already converted to a deal (at Counselling on the person's card)."""
    lead = create_lead(client, headers, **overrides)
    convert_lead(client, headers, lead["lead_id"])
    return call(client, "get", f"/leads/{lead['lead_id']}", headers)


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
    lead = create_deal(client, headers, course_id=course)
    discussion = call(client, "post", f"/leads/{lead['lead_id']}/fee-discussions", headers, 201, json={})
    ver = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", headers, 201,
               json=version)
    return lead, discussion, ver


def plan_code_id(code):
    from models import PaymentPlan

    return db.session.execute(select(PaymentPlan).where(PaymentPlan.plan_code == code)).scalar_one().payment_plan_id


def plan_schedule(plan, total):
    """Test schedules: Full today; 50/50 today + day 12; 50/25/25 today, day 10, day 15 (rounding into the last)."""
    from decimal import Decimal

    total = Decimal(str(total))
    today = datetime.now(IST).date()
    splits = {"FULL": [(0, 100)], "TWO_INSTALMENTS": [(0, 50), (12, 50)],
              "THREE_INSTALMENTS": [(0, 50), (10, 25), (15, 25)]}[plan]
    rows = [{"due_date": (today + timedelta(days=d)).isoformat(),
             "amount": (total * pct / 100).quantize(Decimal("0.01"))} for d, pct in splits]
    rows[-1]["amount"] = total - sum(r["amount"] for r in rows[:-1])
    return [{**r, "amount": str(r["amount"])} for r in rows]


def accept_delivery_plan(client, headers, lead_id, seat_type="Confirmed Seat", **extra):
    body = {"delivery_mode": "Classroom", "seat_type": seat_type, "capacity_review": "Checked",
            "student_accepted": True, **extra}
    if seat_type == "Future Plan":
        body.setdefault("planned_start_date", (datetime.now(IST) + timedelta(days=30)).date().isoformat())
    return call(client, "post", f"/leads/{lead_id}/delivery-plan/accept", headers, json=body)


def ready_deal(client, people, course, seat_type="Confirmed Seat", headers=None, **version):
    """Deal with an approved (standard-price) version and an accepted delivery plan: ready to invoice."""
    headers = headers or people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, headers=headers, **version)
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", headers)
    accept_delivery_plan(client, headers, lead["lead_id"], seat_type=seat_type)
    return lead, discussion, ver


def create_invoice(client, headers, lead_ids, plan="FULL", total=None, expected=201, **extra):
    body = {"lead_ids": lead_ids, **extra}
    if total is not None and "installments" not in extra:
        body["installments"] = plan_schedule(plan, total)
    return call(client, "post", "/invoices", headers, expected, json=body)


def issued_invoice(client, people, course, plan="FULL", seat_type="Confirmed Seat", installments=None, **version):
    """Priced, approved (standard price), delivery plan accepted, invoice issued (the plan's split of the total, or
    the given instalments). Returns dict of the pieces."""
    headers = people["sravani"]["h"]
    lead, discussion, ver = ready_deal(client, people, course, seat_type=seat_type, **version)
    extra = {"installments": installments} if installments else {}
    invoice = create_invoice(client, headers, [lead["lead_id"]], plan=plan, total=ver["final_payable"], **extra)
    return {"lead": lead, "discussion": discussion, "version": ver, "invoice": invoice}


def mode_id(code):
    from models import PaymentMode

    return lookup_id(PaymentMode, code)


def record_payment(client, headers, invoice_id, amount, expected=201, **extra):
    body = {"invoice_id": invoice_id, "amount": str(amount), "payment_mode_id": mode_id("UPI_BANK"),
            "reference": "UTR123456", **extra}
    return call(client, "post", "/payments", headers, expected, json=body)


def verify_payment(client, headers, payment_id, expected=200, **checks):
    body = {"evidence_reviewed": True, "cash_checked": True, **checks}
    return call(client, "post", f"/payments/{payment_id}/verify", headers, expected, json=body)


def paid_invoice(client, people, course, amount=None, **kwargs):
    """Issued invoice with one verified payment (full amount unless given). Verification admits the course once
    ₹1,000 is verified on it."""
    flow = issued_invoice(client, people, course, **kwargs)
    invoice = flow["invoice"]
    payment = record_payment(client, people["sravani"]["h"], invoice["invoice_id"], amount or invoice["billed_amount"])
    payment = payment["payment"]
    verified = verify_payment(client, people["accounts"]["h"], payment["payment_id"])
    return {**flow, "payment": payment, "verified": verified}


def admitted(client, people, course, **kwargs):
    """Paid invoice whose verification created the admission (returned as the full admission)."""
    flow = paid_invoice(client, people, course, **kwargs)
    created = flow["verified"]["admissions_created"]
    assert created, flow["verified"]
    admission = call(client, "get", f"/admissions/{created[0]['admission_id']}", people["sravani"]["h"])
    return {**flow, "admission": admission}


def backdate_installment(run_sql, invoice_id, installment_no, days_ago):
    """Make an instalment overdue (the guard trigger keeps real edits inside the plan window)."""
    run_sql("ALTER TABLE installments DISABLE TRIGGER trg_installments_guard")
    run_sql("UPDATE installments SET due_date = current_date - :d WHERE invoice_id = :i AND installment_no = :n",
            d=days_ago, i=invoice_id, n=installment_no)
    run_sql("ALTER TABLE installments ENABLE TRIGGER trg_installments_guard")
