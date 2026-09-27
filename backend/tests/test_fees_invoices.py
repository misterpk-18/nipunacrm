"""Steps 7 and 7b: fee discussions, versions, special closing, accepted plan, invoices."""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import Notification, Offer, Task
from tests.helpers import API, call, issued_invoice, plan_code_id, priced_lead


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


def test_standard_version_approve_share_accept(client, people, course):
    sravani = people["sravani"]["h"]
    lead, discussion, v1 = priced_lead(client, people, course)
    did = discussion["fee_discussion_id"]

    assert client.post(f"{API}/fee-discussions/{did}/share", headers=sravani).status_code == 422
    approved = call(client, "post", f"/fee-discussion-versions/{v1['version_id']}/approve", sravani)
    assert approved["status"] == "Approved"
    shared = call(client, "post", f"/fee-discussions/{did}/share", sravani)
    assert shared["milestone"] == "Fee Shared" and shared["fee_shared_at"]

    future_no_date = client.post(f"{API}/fee-discussions/{did}/accept-plan", headers=sravani,
                                 json={"version_id": v1["version_id"], "delivery_mode": "Online", "seat_type": "Future Plan"})
    assert future_no_date.status_code == 400
    accepted = call(client, "post", f"/fee-discussions/{did}/accept-plan", sravani,
                    json={"version_id": v1["version_id"], "delivery_mode": "Online", "seat_type": "Confirmed Seat"})
    assert accepted["accepted_plan"]["accepted_version_id"] == v1["version_id"]
    assert client.post(f"{API}/fee-discussions/{did}/versions", json={}, headers=sravani).status_code == 422


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

def test_issue_invoice_builds_schedule(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS", agreed_due_days=[0, 12])
    invoice = flow["invoice"]
    assert invoice["invoice_number"].startswith("INV-GNT-") and invoice["billed_amount"] == "30000.00"
    assert invoice["payment_completion"] == "Unpaid" and invoice["outstanding"] == "30000.00"

    detail = call(client, "get", f"/invoices/{invoice['invoice_id']}", people["sravani"]["h"])
    assert [(r["installment_no"], r["amount_due"], r["due_position"]) for r in detail["schedule"]] == [
        (1, "15000.00", "Due Today"), (2, "15000.00", "Upcoming")]
    assert detail["terms"].startswith("Standard ₹30000.00")
    discussion = call(client, "get", f"/fee-discussions/{flow['discussion']['fee_discussion_id']}", people["sravani"]["h"])
    assert discussion["milestone"] == "Invoice Issued"

    readiness = call(client, "get", f"/invoices/{invoice['invoice_id']}/admission-readiness", people["sravani"]["h"])
    assert readiness["ready"] is False and readiness["missing"] == ["verified_payment"]
    printed = call(client, "get", f"/invoices/{invoice['invoice_id']}/print", people["sravani"]["h"])
    assert printed["invoice_number"] == invoice["invoice_number"] and len(printed["schedule"]) == 2


def test_invoice_rules(client, people, course):
    sravani = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, payment_plan_id=plan_code_id("TWO_INSTALMENTS"))
    not_approved = client.post(f"{API}/fee-discussion-versions/{ver['version_id']}/invoice", json={}, headers=sravani)
    assert not_approved.status_code == 422
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", sravani)
    outside = client.post(f"{API}/fee-discussion-versions/{ver['version_id']}/invoice", headers=sravani,
                          json={"agreed_due_days": [0, 30]})
    assert outside.status_code == 422 and "windows" in outside.get_json()["error"]["message"]
    wrong_count = client.post(f"{API}/fee-discussion-versions/{ver['version_id']}/invoice", headers=sravani,
                              json={"agreed_due_days": [0]})
    assert wrong_count.status_code == 422

    first = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/invoice", sravani, 201, json={})
    second = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/invoice", sravani, 201, json={})
    assert call(client, "get", f"/invoices/{first['invoice_id']}", sravani)["status"] == "Superseded"
    assert call(client, "get", f"/invoices/{first['invoice_id']}", sravani)["superseded_by_invoice_id"] == second["invoice_id"]

    moved = call(client, "put", f"/invoices/{second['invoice_id']}/installments/2/due-date", sravani,
                 json={"due_date": (date.today() + timedelta(days=14)).isoformat()})
    assert moved["due_date"] == (date.today() + timedelta(days=14)).isoformat()
    assert client.put(f"{API}/invoices/{second['invoice_id']}/installments/2/due-date", headers=sravani,
                      json={"due_date": (date.today() + timedelta(days=40)).isoformat()}).status_code == 422

    assert client.post(f"{API}/invoices/{second['invoice_id']}/cancel", json={"reason": "x"}, headers=sravani).status_code == 403
    assert client.post(f"{API}/invoices/{second['invoice_id']}/cancel", json={}, headers=people["accounts"]["h"]).status_code == 400
    cancelled = call(client, "post", f"/invoices/{second['invoice_id']}/cancel", people["accounts"]["h"],
                     json={"reason": "Student changed course"})
    assert cancelled["status"] == "Cancelled" and cancelled["invoice_state"] == "Cancelled"


def test_invoice_register_totals_and_scope(client, people, course):
    issued_invoice(client, people, course)
    body = client.get(f"{API}/invoices", headers=people["accounts"]["h"]).get_json()
    assert body["meta"]["total"] == 1
    assert Decimal(body["meta"]["totals"]["billed"]) == Decimal("30000")
    assert Decimal(body["meta"]["totals"]["outstanding"]) == Decimal("30000")
    assert client.get(f"{API}/invoices", headers=people["mounika"]["h"]).get_json()["meta"]["total"] == 0
    assert client.get(f"{API}/invoices?completion=Paid", headers=people["accounts"]["h"]).get_json()["data"] == []
    assert client.get(f"{API}/invoices", headers=people["trainer"]["h"]).status_code == 403

