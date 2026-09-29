"""Steps 7 and 7b: fee discussions, versions, special closing, accepted plan, invoices."""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import Admission, Notification, Offer, Task
from tests.helpers import API, call, create_deal, create_lead, issued_invoice, priced_lead


def test_discussion_and_versions(client, people, course):
    sravani = people["sravani"]["h"]
    lead, discussion, v1 = priced_lead(client, people, course)

    assert discussion["discussion_code"] == "FD-00001" and discussion["milestone"] == "In Discussion"
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["stage"] == "Fee Discussion / Payment Awaited"
    assert v1["version_no"] == 1 and v1["standard_fee"] == "30000.00" and v1["final_payable"] == "30000.00"
    assert v1["minimum_floor"] == "21000.00" and v1["needs_special_closing"] is False
    assert v1["valid_until"] == (date.today() + timedelta(days=7)).isoformat()

    again = client.post(f"{API}/leads/{lead['lead_id']}/fee-discussions", json={}, headers=sravani)
    assert again.status_code == 409 and "FD-00001" in again.get_json()["error"]["message"]

    v2 = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201,
              json={"extra_concession": "1500"})
    assert v2["version_no"] == 2 and v2["final_payable"] == "28500.00" and v2["needs_special_closing"]
    detail = call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}", sravani)
    assert [v["status"] for v in detail["versions"]] == ["Superseded", "Discussion Saved"]
    assert detail["current_version"]["version_id"] == v2["version_id"]

    assert client.post(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/versions", headers=sravani,
                       json={"extra_concession": "40000"}).status_code == 400
    assert client.get(f"{API}/fee-discussions/{discussion['fee_discussion_id']}", headers=people["mounika"]["h"]).status_code == 404
    assert client.post(f"{API}/leads/{lead['lead_id']}/fee-discussions", json={}, headers=people["accounts"]["h"]).status_code == 403


def test_offer_discount_applies_only_when_active_for_scope(client, people, course, run_sql):
    admin = people["admin"]["id"]
    run_sql("""INSERT INTO offers (offer_code, offer_name, status, benefit_type, discount_percent, discount_amount,
                                   applies_to_all_courses, valid_from, valid_to, approved_by)
               VALUES ('DIWALI', 'Diwali 10%', 'Active', 'Discount Percent', 10, NULL, true,
                       current_date - 1, current_date + 30, :a),
                      ('OLD', 'Old', 'Draft', 'Discount Amount', NULL, 1000, true, NULL, NULL, NULL)""", a=admin)
    diwali = db.session.execute(select(Offer).where(Offer.offer_code == "DIWALI")).scalar_one()
    draft = db.session.execute(select(Offer).where(Offer.offer_code == "OLD")).scalar_one()

    lead, discussion, v1 = priced_lead(client, people, course, offer_id=diwali.offer_id)
    assert v1["offer_discount"] == "3000.00" and v1["final_payable"] == "27000.00"
    assert v1["offer"]["offer_code"] == "DIWALI"
    detail = call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}", people["sravani"]["h"])
    assert [o["offer_code"] for o in detail["applicable_offers"]] == ["DIWALI"]
    assert client.post(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/versions", headers=people["sravani"]["h"],
                       json={"offer_id": draft.offer_id}).status_code == 400


def test_standard_version_approve_share(client, people, course):
    sravani = people["sravani"]["h"]
    lead, discussion, v1 = priced_lead(client, people, course)
    did = discussion["fee_discussion_id"]

    assert client.post(f"{API}/fee-discussions/{did}/share", headers=sravani).status_code == 422
    approved = call(client, "post", f"/fee-discussion-versions/{v1['version_id']}/approve", sravani)
    assert approved["status"] == "Approved"
    shared = call(client, "post", f"/fee-discussions/{did}/share", sravani)
    assert shared["milestone"] == "Fee Shared" and shared["fee_shared_at"]
    assert "accepted_plan" not in shared  # the delivery plan is per course deal now (db 020)


def test_delivery_plan_draft_accept_reopen(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_deal(client, sravani, course_id=course)
    url = f"/leads/{lead['lead_id']}/delivery-plan"
    assert call(client, "get", url, sravani)["plan"] is None

    unconverted = create_lead(client, sravani, person={"full_name": "Not Yet", "phone": "9000000501"}, course_id=course)
    assert client.put(f"{API}/leads/{unconverted['lead_id']}/delivery-plan", headers=sravani,
                      json={"delivery_mode": "Online"}).status_code == 422
    assert client.put(f"{API}{url}", json={"seat_type": "Future Plan"}, headers=sravani).status_code == 400  # mode
    assert client.put(f"{API}{url}", json={"delivery_mode": "Online", "seat_type": "Future Plan"},
                      headers=sravani).status_code == 400                                               # start date
    draft = call(client, "put", url, sravani, json={"delivery_mode": "Online", "capacity_review": "Waiting"})["plan"]
    assert draft["plan_code"] == "DP-00001" and draft["status"] == "Draft" and draft["service_branch"]["branch_id"] == 1
    assert client.post(f"{API}{url}/accept", json={"student_accepted": False}, headers=sravani).status_code == 400

    accepted = call(client, "post", f"{url}/accept", sravani,
                    json={"student_accepted": True, "capacity_review": "Checked"})["plan"]
    assert accepted["status"] == "Accepted" and accepted["accepted_by"]["full_name"] == "Sravani"
    assert accepted["capacity_review"] == "Checked" and accepted["student_accepted"] is True
    assert client.put(f"{API}{url}", json={"delivery_mode": "Classroom"}, headers=sravani).status_code == 422
    assert client.put(f"{API}{url}", json={"delivery_mode": "Classroom"}, headers=people["accounts"]["h"]).status_code == 403
    reopened = call(client, "post", f"{url}/reopen", sravani, json={"reason": "Student prefers weekends"})["plan"]
    assert reopened["status"] == "Draft" and reopened["student_accepted"] is False

    coordinator = people.get("coordinator")
    if coordinator:
        assert call(client, "get", url, coordinator["h"])["plan"]["plan_code"] == "DP-00001"


def test_extra_concession_needs_special_closing(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, extra_concession="1000")

    blocked = client.post(f"{API}/fee-discussion-versions/{ver['version_id']}/approve", headers=sravani)
    assert blocked.status_code == 422 and "special closing" in blocked.get_json()["error"]["message"]

    scr = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests", sravani, 201,
               json={"request_reason": "Sibling already enrolled"})
    assert scr["scr_code"] == "SCR-00001" and scr["status"] == "Pending" and scr["decision_due_at"]
    assert db.session.execute(select(Notification).where(Notification.entity_type == "special_closing_request")).scalars().all()
    task = db.session.execute(select(Task).where(Task.dedupe_key == f"scr:{scr['scr_id']}")).scalar_one()
    assert task.task_type.code == "APPROVAL"

    queue = call(client, "get", "/special-closing-requests?queue=can_approve", bm)
    assert [s["scr_id"] for s in queue] == [scr["scr_id"]]
    assert call(client, "get", "/special-closing-requests?queue=higher_approval", bm) == []
    assert client.get(f"{API}/special-closing-requests", headers=sravani).status_code == 403

    approved = call(client, "post", f"/special-closing-requests/{scr['scr_id']}/approve", bm, json={})
    assert approved["status"] == "Approved" and approved["decided_by"]["full_name"] == "BM Guntur"
    version = call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}", sravani)["current_version"]
    assert version["status"] == "Approved"
    db.session.refresh(task)
    assert task.status == "Completed"
    assert all(n.action_completed_at for n in db.session.execute(select(Notification)).scalars())


def test_approver_limit_counteroffer_and_reject(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    # BM limit: lower of 5% (₹1,500) or ₹1,000 → ₹1,000
    lead, discussion, ver = priced_lead(client, people, course, extra_concession="2000")
    scr = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests", sravani, 201,
               json={"request_reason": "Competitor price"})
    assert call(client, "get", "/special-closing-requests?queue=higher_approval", bm)[0]["scr_id"] == scr["scr_id"]
    too_much = client.post(f"{API}/special-closing-requests/{scr['scr_id']}/approve", json={}, headers=bm)
    assert too_much.status_code == 422 and "exceeds approver limit" in too_much.get_json()["error"]["message"]

    countered = call(client, "post", f"/special-closing-requests/{scr['scr_id']}/counteroffer", bm,
                     json={"counter_extra": "1000"})
    assert countered["status"] == "Counteroffered" and countered["counter_extra"] == "1000.00"
    v2 = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201,
              json={"extra_concession": "1000"})
    scr2 = call(client, "post", f"/fee-discussion-versions/{v2['version_id']}/special-closing-requests", sravani, 201,
                json={"request_reason": "Accepting counteroffer"})
    assert client.post(f"{API}/special-closing-requests/{scr2['scr_id']}/reject", json={}, headers=bm).status_code == 400
    rejected = call(client, "post", f"/special-closing-requests/{scr2['scr_id']}/reject", bm, json={"reason": "Not justified"})
    assert rejected["status"] == "Rejected"
    assert client.post(f"{API}/special-closing-requests/{scr2['scr_id']}/approve", json={}, headers=bm).status_code == 422


def test_self_approval_and_fresh_auth(client, people, course, run_sql):
    bm = people["bm"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, headers=bm, extra_concession="500")
    scr = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests", bm, 201,
               json={"request_reason": "x"})
    assert client.post(f"{API}/special-closing-requests/{scr['scr_id']}/approve", json={}, headers=bm).status_code == 403

    run_sql("UPDATE user_sessions SET reauthenticated_at = now() - interval '1 hour'")
    stale = client.post(f"{API}/special-closing-requests/{scr['scr_id']}/approve", json={}, headers=people["admin"]["h"])
    assert stale.status_code == 401 and stale.get_json()["error"]["code"] == "FRESH_AUTH_REQUIRED"


def test_below_floor_needs_admin_and_independent_approval(client, people, course):
    sravani = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, extra_concession="10000")  # 20,000 < floor 21,000
    assert ver["below_floor"] is True
    scr = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests", sravani, 201,
               json={"request_reason": "Scholarship case"})

    assert client.post(f"{API}/special-closing-requests/{scr['scr_id']}/approve", json={},
                       headers=people["bm"]["h"]).status_code == 422
    alone = client.post(f"{API}/special-closing-requests/{scr['scr_id']}/approve", json={}, headers=people["admin"]["h"])
    assert alone.status_code == 422 and "independent approval" in alone.get_json()["error"]["message"]
    ok = call(client, "post", f"/special-closing-requests/{scr['scr_id']}/approve", people["admin"]["h"],
              json={"independent_approved_by": people["bm"]["id"]})
    assert ok["independent_approved_by"] == people["bm"]["id"] and ok["independent_approved_at"]


# ---------------------------------------------------------------- invoices

def _schedule(*rows):
    return [{"due_date": (date.today() + timedelta(days=days)).isoformat(), "amount": amount} for days, amount in rows]


def test_issue_invoice_builds_schedule(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS")
    invoice = flow["invoice"]
    assert invoice["invoice_number"].startswith("INV-GNT-") and invoice["billed_amount"] == "30000.00"
    assert invoice["payment_completion"] == "Unpaid" and invoice["outstanding"] == "30000.00"
    assert invoice["issuer"]["address"].startswith("Door No. 6-4-35") and invoice["issuer"]["accent"] == "#6251DA"
    assert [c["line_code"] for c in invoice["courses"]] == [invoice["invoice_number"] + "-L1"]

    detail = call(client, "get", f"/invoices/{invoice['invoice_id']}", people["sravani"]["h"])
    assert [(r["installment_no"], r["amount_due"], r["due_position"]) for r in detail["schedule"]] == [
        (1, "15000.00", "Due Today"), (2, "15000.00", "Upcoming")]
    assert detail["split"] == "50/50" and detail["payment_plan"]["plan_code"] == "TWO_INSTALMENTS"
    assert detail["lines"][0]["billed_amount"] == "30000.00" and detail["lines"][0]["open_to_allocate"] == "30000.00"
    discussion = call(client, "get", f"/fee-discussions/{flow['discussion']['fee_discussion_id']}", people["sravani"]["h"])
    assert discussion["milestone"] == "Invoice Issued"

    readiness = call(client, "get", f"/invoices/{invoice['invoice_id']}/admission-readiness", people["sravani"]["h"])
    assert readiness["ready"] is False and readiness["lines"][0]["missing"] == ["verified_payment"]
    printed = call(client, "get", f"/invoices/{invoice['invoice_id']}/print", people["sravani"]["h"])
    assert printed["invoice_number"] == invoice["invoice_number"] and len(printed["installments"]) == 2
    assert printed["issuer"]["branch_code"] == "NIT-GNT" and printed["lines"][0]["course"]["course_id"] == course
    assert printed["plan"]["split"] == "50/50" and printed["receipts"] == []


def test_invoice_rules(client, people, course, run_sql):
    from tests.helpers import accept_delivery_plan, create_invoice

    sravani = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course)
    body = {"lead_ids": [lead["lead_id"]]}
    not_approved = client.post(f"{API}/invoices", json=body, headers=sravani)
    assert not_approved.status_code == 422 and "No approved fee version" in not_approved.get_json()["error"]["message"]
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", sravani)
    no_plan = client.post(f"{API}/invoices", json=body, headers=sravani)
    assert no_plan.status_code == 422 and "Delivery plan not accepted" in no_plan.get_json()["error"]["message"]
    accept_delivery_plan(client, sravani, lead["lead_id"])

    first = create_invoice(client, sravani, [lead["lead_id"]], installments=_schedule((0, "10000"), (15, "20000")))
    duplicate = client.post(f"{API}/invoices", json=body, headers=sravani)
    assert duplicate.status_code == 422 and first["invoice_number"] in duplicate.get_json()["error"]["message"]
    assert client.put(f"{API}/leads/{lead['lead_id']}/delivery-plan", json={"delivery_mode": "Online"},
                      headers=sravani).status_code == 422  # invoiced: the plan is fixed

    # Due dates move (in order); the issued invoice keeps its issuer snapshot when the branch changes
    moved = call(client, "put", f"/invoices/{first['invoice_id']}/installments/2/due-date", sravani,
                 json={"due_date": (date.today() + timedelta(days=90)).isoformat()})
    assert moved["due_date"] == (date.today() + timedelta(days=90)).isoformat()
    assert client.put(f"{API}/invoices/{first['invoice_id']}/installments/2/due-date", headers=sravani,
                      json={"due_date": date.today().isoformat()}).status_code == 400
    run_sql("UPDATE branches SET address = 'Moved office' WHERE branch_id = 1")
    assert call(client, "get", f"/invoices/{first['invoice_id']}/print", sravani)["issuer"]["address"].startswith("Door No.")

    assert client.post(f"{API}/invoices/{first['invoice_id']}/cancel", json={"reason": "x"}, headers=sravani).status_code == 403
    assert client.post(f"{API}/invoices/{first['invoice_id']}/cancel", json={}, headers=people["accounts"]["h"]).status_code == 400
    cancelled = call(client, "post", f"/invoices/{first['invoice_id']}/cancel", people["accounts"]["h"],
                     json={"reason": "Student changed course"})
    assert cancelled["status"] == "Cancelled" and cancelled["invoice_state"] == "Cancelled"
    # the course can be invoiced again, with the branch's current address
    again = create_invoice(client, sravani, [lead["lead_id"]], total="30000")
    assert again["issuer"]["address"] == "Moved office"
    assert client.post(f"{API}/invoices", json=body, headers=people["trainer"]["h"]).status_code == 403


def test_invoice_schedule_dates_and_amounts(client, people, course):
    from tests.helpers import ready_deal

    sravani = people["sravani"]["h"]
    lead, _, ver = ready_deal(client, people, course)

    def refused(installments):
        response = client.post(f"{API}/invoices", json={"lead_ids": [lead["lead_id"]], "installments": installments},
                               headers=sravani)
        assert response.status_code == 400, response.get_json()
        return response.get_json()["error"]["details"]

    assert "installments" in refused(_schedule((0, "10000"), (45, "10000"), (100, "9000")))      # ₹29,000 ≠ ₹30,000
    assert "installments.1.due_date" in refused(_schedule((20, "10000"), (10, "20000")))          # out of order
    assert "installments.0.due_date" in refused(_schedule((-1, "30000")))                          # in the past
    assert "installments" in refused(_schedule((0, "7500"), (5, "7500"), (9, "7500"), (12, "7500")))  # max 3

    # Any split and any dates: ₹1,000 token today, ₹9,000 in 45 days, ₹20,000 in 100 days
    invoice = call(client, "post", "/invoices", sravani, 201, json={
        "lead_ids": [lead["lead_id"]], "installments": _schedule((0, "1000"), (45, "9000"), (100, "20000"))})
    assert invoice["payment_plan"]["plan_code"] == "THREE_INSTALMENTS"  # from the number of instalments
    detail = call(client, "get", f"/invoices/{invoice['invoice_id']}", sravani)
    assert [r["amount_due"] for r in detail["schedule"]] == ["1000.00", "9000.00", "20000.00"]
    assert detail["split"] == "3/30/67"


def test_multi_course_invoice_combines_only_compatible_deals(app, client, people, course):
    from tests.helpers import accept_delivery_plan, convert_lead, create_invoice, ready_deal

    sravani = people["sravani"]["h"]
    java = _second_course(app)
    lead, _, _ = ready_deal(client, people, course)
    person_id = lead["person"]["person_id"]
    other = create_lead(client, sravani, person=None, person_id=person_id, course_id=java)
    convert_lead(client, sravani, other["lead_id"])

    options = call(client, "get", f"/invoices/options?lead_id={lead['lead_id']}", sravani)
    assert options["issuer"]["branch_code"] == "NIT-GNT" and options["bill_to"]["person_id"] == person_id
    by_lead = {c["lead"]["lead_id"]: c for c in options["courses"]}
    assert by_lead[lead["lead_id"]]["eligible"] is True and by_lead[lead["lead_id"]]["amount"] == "30000.00"
    assert by_lead[other["lead_id"]]["eligible"] is False
    assert set(by_lead[other["lead_id"]]["reasons"]) == {"No approved fee version", "Delivery plan not accepted"}
    blocked = client.post(f"{API}/invoices", json={"lead_ids": [lead["lead_id"], other["lead_id"]]}, headers=sravani)
    assert blocked.status_code == 422 and other["lead_code"] in blocked.get_json()["error"]["details"]["leads"]

    disc = call(client, "post", f"/leads/{other['lead_id']}/fee-discussions", sravani, 201, json={})
    ver = call(client, "post", f"/fee-discussions/{disc['fee_discussion_id']}/versions", sravani, 201, json={})
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", sravani)
    accept_delivery_plan(client, sravani, other["lead_id"])

    stranger, _, _ = ready_deal(client, people, course, person={"full_name": "Someone Else", "phone": "9000000502"})
    mixed = client.post(f"{API}/invoices", json={"lead_ids": [lead["lead_id"], stranger["lead_id"]]}, headers=sravani)
    assert mixed.status_code == 422 and "different person" in mixed.get_json()["error"]["message"]

    invoice = create_invoice(client, sravani, [lead["lead_id"], other["lead_id"]], plan="TWO_INSTALMENTS", total="55000")
    assert invoice["billed_amount"] == "55000.00" and len(invoice["courses"]) == 2
    assert [c["course"]["course_id"] for c in invoice["courses"]] == [course, java]
    options = call(client, "get", f"/invoices/options?lead_id={lead['lead_id']}", sravani)
    assert all(c["invoice"]["invoice_id"] == invoice["invoice_id"] and not c["eligible"] for c in options["courses"])
    assert {i["invoice_id"] for i in call(client, "get", f"/invoices?lead_id={other['lead_id']}", sravani)} == {
        invoice["invoice_id"]}


def test_invoice_register_totals_and_scope(client, people, course):
    issued_invoice(client, people, course)
    body = client.get(f"{API}/invoices", headers=people["accounts"]["h"]).get_json()
    assert body["meta"]["total"] == 1
    assert Decimal(body["meta"]["totals"]["billed"]) == Decimal("30000")
    assert Decimal(body["meta"]["totals"]["outstanding"]) == Decimal("30000")
    assert client.get(f"{API}/invoices", headers=people["mounika"]["h"]).get_json()["meta"]["total"] == 0
    assert client.get(f"{API}/invoices?completion=Paid", headers=people["accounts"]["h"]).get_json()["data"] == []
    assert client.get(f"{API}/invoices", headers=people["trainer"]["h"]).status_code == 403



# ---------------------------------------------------------------- an offer can be used only once per person

def _offer(run_sql, people, code="ONCE", **columns):
    run_sql("""INSERT INTO offers (offer_code, offer_name, status, benefit_type, discount_amount, applies_to_all_courses,
                                   valid_from, valid_to, approved_by)
               VALUES (:code, 'Once only', 'Active', 'Discount Amount', 2000, true, current_date - 1, current_date + 30, :a)""",
            code=code, a=people["admin"]["id"])
    return db.session.execute(select(Offer).where(Offer.offer_code == code)).scalar_one().offer_id


def _second_course(app):
    from models import Course, CourseBranch

    other = Course(course_code="NIT-CRS-047", course_title="Java Full Stack", category="Software Development",
                   standard_fee=25000, branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(other)
    db.session.commit()
    return other.course_id


def _invoice_for(client, people, lead_id, offer_id, pay=True):
    """Fee discussion → version with the offer → approve → accept plan → invoice → verified full payment (which
    creates the admission). Returns (discussion, invoice, admissions created on verification)."""
    from tests.helpers import accept_delivery_plan, create_invoice

    sravani = people["sravani"]["h"]
    discussion = call(client, "post", f"/leads/{lead_id}/fee-discussions", sravani, 201, json={})
    version = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201,
                   json={"offer_id": offer_id})
    call(client, "post", f"/fee-discussion-versions/{version['version_id']}/approve", sravani)
    accept_delivery_plan(client, sravani, lead_id)
    invoice = create_invoice(client, sravani, [lead_id])
    return (discussion, invoice, _pay(client, people, invoice) if pay else [])


def _pay(client, people, invoice):
    from tests.helpers import record_payment, verify_payment

    payment = record_payment(client, people["sravani"]["h"], invoice["invoice_id"], invoice["billed_amount"])["payment"]
    return verify_payment(client, people["accounts"]["h"], payment["payment_id"])["admissions_created"]


def test_offer_used_once_per_person(app, client, people, course, run_sql):
    from tests.helpers import create_deal

    sravani = people["sravani"]["h"]
    offer_id = _offer(run_sql, people)
    java = _second_course(app)

    first = create_deal(client, sravani, course_id=course)
    person_id = first["person"]["person_id"]
    _, invoice, created = _invoice_for(client, people, first["lead_id"], offer_id)
    admission = created[0]

    # Same person, another course: the offer is no longer offered and can't be applied
    second = create_deal(client, sravani, person=None, person_id=person_id, course_id=java)
    discussion = call(client, "post", f"/leads/{second['lead_id']}/fee-discussions", sravani, 201, json={})
    detail = call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}", sravani)
    assert detail["applicable_offers"] == []
    assert detail["used_offers"] == [{"offer_code": "ONCE", "admission_id": admission["admission_id"],
                                      "admission_code": admission["admission_code"], "used_as": "Fee offer"}]
    refused = client.post(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/versions", headers=sravani,
                          json={"offer_id": offer_id})
    assert refused.status_code == 422
    assert "already been used by this person" in refused.get_json()["error"]["message"]

    # A different person can still use it
    stranger = create_deal(client, sravani, course_id=java, person={"full_name": "Other Learner", "phone": "91234 56789"})
    other_discussion = call(client, "post", f"/leads/{stranger['lead_id']}/fee-discussions", sravani, 201, json={})
    assert call(client, "post", f"/fee-discussions/{other_discussion['fee_discussion_id']}/versions", sravani, 201,
                json={"offer_id": offer_id})["offer"]["offer_code"] == "ONCE"

    # Cancelling the admission that used it makes the offer available again
    call(client, "post", f"/admissions/{admission['admission_id']}/cancel", people["bm"]["h"], json={"reason": "Dropped out"})
    detail = call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}", sravani)
    assert [o["offer_code"] for o in detail["applicable_offers"]] == ["ONCE"] and detail["used_offers"] == []


def test_offer_once_enforced_at_invoice_and_admission(app, client, people, course, run_sql):
    """Two parallel discussions with the same offer: the second is stopped at invoicing, or at admission if its
    invoice was already issued (database rule, covers every version of the offer)."""
    from tests.helpers import create_deal

    sravani = people["sravani"]["h"]
    offer_id = _offer(run_sql, people)
    java = _second_course(app)
    first = create_deal(client, sravani, course_id=course)
    person_id = first["person"]["person_id"]
    second = create_deal(client, sravani, person=None, person_id=person_id, course_id=java)

    _, invoice_1, _ = _invoice_for(client, people, first["lead_id"], offer_id, pay=False)
    _, invoice_2, _ = _invoice_for(client, people, second["lead_id"], offer_id, pay=False)  # both before any admission
    admission = _pay(client, people, invoice_1)[0]
    assert _pay(client, people, invoice_2) == []  # verified, but the admission is refused (task for the manager)
    task = db.session.execute(select(Task).where(Task.dedupe_key.like("admission-blocked:%"))).scalar_one()
    assert "already been used" in task.title

    blocked = client.post(f"{API}/admissions", headers=sravani, json={"invoice_id": invoice_2["invoice_id"]})
    assert blocked.status_code == 422
    assert blocked.get_json()["error"]["message"] == (
        f"Offer ONCE has already been used by this person (admission {admission['admission_code']}); "
        "an offer can be used only once per person")

    # A priced-but-not-invoiced version is stopped when the invoice is issued
    third_course = _third_course(app)
    third = create_deal(client, sravani, person=None, person_id=person_id, course_id=third_course)
    # Price it while the offer is free (first admission briefly cancelled), then the first admission is live again
    status = db.session.execute(select(Admission.enrolment_status).where(
        Admission.admission_id == admission["admission_id"])).scalar_one()
    run_sql("UPDATE admissions SET enrolment_status = 'Cancelled', cancelled_by = :u, cancelled_at = now(), "
            "cancellation_reason = 'test' WHERE admission_id = :a", u=people["bm"]["id"], a=admission["admission_id"])
    discussion = call(client, "post", f"/leads/{third['lead_id']}/fee-discussions", sravani, 201, json={})
    version = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201,
                   json={"offer_id": offer_id})
    call(client, "post", f"/fee-discussion-versions/{version['version_id']}/approve", sravani)
    from tests.helpers import accept_delivery_plan

    accept_delivery_plan(client, sravani, third["lead_id"])
    run_sql("UPDATE admissions SET enrolment_status = :s, cancelled_by = NULL, cancelled_at = NULL, "
            "cancellation_reason = NULL WHERE admission_id = :a", s=status, a=admission["admission_id"])
    refused = client.post(f"{API}/invoices", headers=sravani, json={"lead_ids": [third["lead_id"]]})
    assert refused.status_code == 422 and "already been used" in refused.get_json()["error"]["message"]


def _third_course(app):
    from models import Course, CourseBranch

    third = Course(course_code="NIT-CRS-019", course_title="Power BI", category="Data & Analytics",
                   standard_fee=22000, branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(third)
    db.session.commit()
    return third.course_id


def test_complimentary_offer_counts_once_per_person(app, client, people, course, run_sql):
    """The paid admission that applies a complimentary offer and the free course it grants are one use; the same
    person can't get that offer's complimentary course again on a later admission."""
    from models import Course, CourseBranch
    from tests.helpers import create_deal

    sravani = people["sravani"]["h"]
    excel = Course(course_code="NIT-CRS-090", course_title="Advanced Excel", category="Office", standard_fee=5000,
                   branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(excel)
    db.session.commit()
    run_sql("""INSERT INTO offers (offer_code, offer_name, status, benefit_type, applies_to_all_courses, valid_from,
                                   valid_to, approved_by)
               VALUES ('EXCEL', 'Free Excel', 'Active', 'Complimentary Course', true, current_date - 1, current_date + 30, :a)""",
            a=people["admin"]["id"])
    offer_id = run_sql("SELECT offer_id FROM offers WHERE offer_code = 'EXCEL'").scalar()
    run_sql("INSERT INTO offer_complimentary_courses (offer_id, course_id, min_final_fee, access_period_days) "
            "VALUES (:o, :c, 15000, 90)", o=offer_id, c=excel.course_id)
    java = _second_course(app)

    first = create_deal(client, sravani, course_id=course)
    person_id = first["person"]["person_id"]
    _, invoice, created = _invoice_for(client, people, first["lead_id"], offer_id)  # offer chosen on the fee version
    parent = created[0]
    call(client, "post", f"/admissions/{parent['admission_id']}/complimentary", sravani, 201,
         json={"offer_id": offer_id, "course_id": excel.course_id})

    second = create_deal(client, sravani, person=None, person_id=person_id, course_id=java)
    _, invoice_2, created = _invoice_for(client, people, second["lead_id"], None)
    later = created[0]
    again = client.post(f"{API}/admissions/{later['admission_id']}/complimentary", headers=sravani,
                        json={"offer_id": offer_id, "course_id": excel.course_id})
    assert again.status_code == 422
    assert f"admission {parent['admission_code']}" in again.get_json()["error"]["message"]
