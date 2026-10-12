"""Next-step journey (GET /leads/<id>/journey): one next action per stage, blocked / waiting states, who may act,
branch scoping and the post-admission trail."""
from datetime import date

from tests.helpers import (
    API, accept_delivery_plan, call, convert_lead, create_invoice, create_lead, error_of, future, issued_invoice,
    mode_id, past, priced_lead, qualify_lead, record_payment, verify_payment,
)
from tests.test_pipeline_demos import outcome_body, set_past


def journey(client, headers, lead_id, expected=200):
    return call(client, "get", f"/leads/{lead_id}/journey", headers, expected)


def statuses(data):
    return {s["key"]: s["status"] for s in data["steps"]}


def contact(client, headers, lead_id):
    call(client, "post", f"/leads/{lead_id}/activities", headers, 201,
         json={"activity_type": "Call", "direction": "Outbound", "outcome": "Connected"})


def test_stages_from_capture_to_invoice(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    lid = lead["lead_id"]

    data = journey(client, sravani, lid)
    assert [s["key"] for s in data["steps"]] == ["capture", "qualify", "convert", "demo", "fee", "plan", "invoice",
                                                 "payment", "verify", "admission", "batch"]
    assert data["lead_id"] == lid and data["course_id"] == course and data["course_title"] == "Data Science"
    assert data["money"] is None and data["after_admission"] is None
    assert statuses(data)["capture"] == "done" and statuses(data)["qualify"] == "current"
    assert data["next"]["action"] == "save_outcome" and data["next"]["can_act"] and not data["next"]["blocked"]

    contact(client, sravani, lid)
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "qualify" and " of 6 checks" in data["next"]["detail"]

    qualify_lead(client, sravani, lid)
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "convert" and statuses(data)["qualify"] == "done"
    assert statuses(data)["convert"] == "current" and data["steps"][1]["at"]

    call(client, "post", f"/leads/{lid}/convert", sravani, json={"course_ids": [course]})
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "book_demo" and data["next"]["alternatives"][0]["action"] == "fee_discussion"
    assert data["pipeline_entry_id"] is not None

    # A booked demo asks for its outcome; once attended the fee comes next
    demo = call(client, "post", f"/leads/{lid}/demos", sravani, 201, json={"scheduled_at": future(48)})
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "record_demo_outcome" and data["next"]["ref"]["demo_id"] == demo["demo_id"]
    assert statuses(data)["demo"] == "current"


def test_demo_attended_then_fee_plan_invoice(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    lid = lead["lead_id"]
    contact(client, sravani, lid)
    convert_lead(client, sravani, lid)
    demo = call(client, "post", f"/leads/{lid}/demos", sravani, 201, json={"scheduled_at": future(48)})
    set_past(run_sql, demo["demo_id"])
    call(client, "post", f"/demos/{demo['demo_id']}/outcome", people["trainer"]["h"], json=outcome_body())
    data = journey(client, sravani, lid)
    assert statuses(data)["demo"] == "done" and data["next"]["action"] == "fee_discussion"
    assert data["next"]["label"] == "Start the fee discussion"

    discussion = call(client, "post", f"/leads/{lid}/fee-discussions", sravani, 201, json={})
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "fee_discussion" and data["next"]["label"] == "Build the fee"
    version = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201, json={})
    data = journey(client, sravani, lid)
    assert data["next"]["label"] == "Approve the fee" and data["next"]["ref"]["version_id"] == version["version_id"]

    call(client, "post", f"/fee-discussion-versions/{version['version_id']}/approve", sravani)
    data = journey(client, sravani, lid)
    assert statuses(data)["fee"] == "done" and data["next"]["action"] == "accept_plan"
    assert "Sales" in data["next"]["role"]

    accept_delivery_plan(client, sravani, lid)
    data = journey(client, sravani, lid)
    assert statuses(data)["plan"] == "done" and data["next"]["action"] == "create_invoice"
    assert not data["next"]["blocked"] and "₹30,000" in data["next"]["detail"]

    invoice = create_invoice(client, sravani, [lid], total=version["final_payable"])
    data = journey(client, sravani, lid)
    assert statuses(data)["invoice"] == "done" and data["next"]["action"] == "record_payment"
    money = data["money"]
    assert money["invoice_id"] == invoice["invoice_id"] and money["invoice_code"] == invoice["invoice_number"]
    assert (float(money["total"]), float(money["verified"]), float(money["balance"])) == (30000, 0, 30000)
    assert float(money["token_needed"]) == 1000 and float(money["more_to_admit"]) == 1000
    assert "₹1,000 more verified" in data["next"]["detail"]


def test_demo_can_be_skipped(client, people, course):
    sravani = people["sravani"]["h"]
    lead, discussion, version = priced_lead(client, people, course)
    data = journey(client, sravani, lead["lead_id"])
    assert statuses(data)["demo"] == "skipped" and data["next"]["label"] == "Approve the fee"


def test_special_closing_waits_for_the_manager(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    lead, discussion, version = priced_lead(client, people, course, extra_concession="1000")
    lid = lead["lead_id"]
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "request_approval" and data["next"]["can_act"]

    scr = call(client, "post", f"/fee-discussion-versions/{version['version_id']}/special-closing-requests", sravani,
               201, json={"request_reason": "Sibling already enrolled"})
    waiting = journey(client, sravani, lid)["next"]
    assert waiting["action"] == "request_approval" and waiting["role"] == "Branch Manager"
    assert waiting["can_act"] is False and not waiting["blocked"] and "Waiting" in waiting["reason"]
    assert waiting["ref"]["scr_id"] == scr["scr_id"]
    # the manager can decide it
    deciding = journey(client, bm, lid)["next"]
    assert deciding["can_act"] is True and deciding["reason"] is None

    call(client, "post", f"/special-closing-requests/{scr['scr_id']}/approve", bm, json={})
    assert journey(client, sravani, lid)["next"]["action"] == "accept_plan"


def test_pending_payment_waits_for_accounts_then_verification_admits(client, people, course):
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    flow = issued_invoice(client, people, course)
    lid, invoice = flow["lead"]["lead_id"], flow["invoice"]
    assert journey(client, sravani, lid)["next"]["action"] == "record_payment"

    paid = record_payment(client, sravani, invoice["invoice_id"], 600)["payment"]
    data = journey(client, sravani, lid)
    assert statuses(data)["payment"] == "done" and statuses(data)["verify"] == "current"
    nxt = data["next"]
    assert nxt["action"] == "verify_payment" and nxt["role"] == "Accounts" and nxt["can_act"] is False
    assert nxt["ref"]["payment_id"] == paid["payment_id"] and "Waiting for Accounts" in nxt["reason"]
    assert float(data["money"]["verified"]) == 0 and float(data["money"]["pending"]) == 600
    # Accounts and admins can act on it
    assert journey(client, accounts, lid)["next"]["can_act"] is True
    assert journey(client, people["admin"]["h"], lid)["next"]["can_act"] is True
    assert journey(client, people["bm"]["h"], lid)["next"]["can_act"] is False

    # ₹600 verified is short of the ₹1,000 token: the next step is more money, with the hint
    verify_payment(client, accounts, paid["payment_id"])
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "record_payment" and float(data["money"]["more_to_admit"]) == 400
    assert statuses(data)["payment"] == "current" and statuses(data)["verify"] == "todo"
    assert "₹400 more verified" in data["next"]["detail"] and data["after_admission"] is None

    more = record_payment(client, sravani, invoice["invoice_id"], 400)["payment"]
    verified = verify_payment(client, accounts, more["payment_id"])
    assert verified["admissions_created"]
    data = journey(client, sravani, lid)
    assert statuses(data)["admission"] == "done" and statuses(data)["verify"] == "done"
    assert float(data["money"]["more_to_admit"]) == 0 and data["after_admission"]["admission_code"]


def test_blocked_invoice_names_the_fix(client, people, course, run_sql):
    """An invoice that can't be created says why and which step fixes it."""
    sravani = people["sravani"]["h"]
    flow = issued_invoice(client, people, course)
    lid = flow["lead"]["lead_id"]
    # the issued invoice is cancelled: the course can be invoiced again; reopening the plan makes it the next step
    call(client, "post", f"/invoices/{flow['invoice']['invoice_id']}/cancel", people["accounts"]["h"],
         json={"reason": "Wrong dates"})
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "create_invoice" and not data["next"]["blocked"]
    call(client, "post", f"/leads/{lid}/delivery-plan/reopen", sravani, json={"reason": "Start date moved"})
    data = journey(client, sravani, lid)
    assert data["next"]["action"] == "accept_plan" and statuses(data)["plan"] == "current"


def test_admission_trail(client, people, course, run_sql):
    sravani, manager = people["sravani"]["h"], people["bm"]["h"]
    flow = issued_invoice(client, people, course)
    lid, invoice = flow["lead"]["lead_id"], flow["invoice"]
    payment = record_payment(client, sravani, invoice["invoice_id"], 1000)["payment"]
    admission_id = verify_payment(client, people["accounts"]["h"], payment["payment_id"])["admissions_created"][0]["admission_id"]

    data = journey(client, sravani, lid)
    trail = {t["key"]: t for t in data["after_admission"]["trail"]}
    assert list(trail) == ["admitted", "lms_login", "batch_allocated"]
    assert trail["admitted"]["status"] == "done" and trail["lms_login"]["status"] == "current"
    assert trail["batch_allocated"]["status"] == "todo"
    assert data["after_admission"]["admission_id"] == admission_id
    assert data["next"]["action"] == "wait_batch" and data["next"]["can_act"] is False

    # The LMS login, then a batch (mirrored state): the trail completes with the batch code and timing
    run_sql("UPDATE admissions SET lms_status = 'Active' WHERE admission_id = :a", a=admission_id)
    data = journey(client, sravani, lid)
    assert {t["key"]: t["status"] for t in data["after_admission"]["trail"]}["lms_login"] == "done"
    assert data["next"]["action"] == "wait_batch" and "batch" in data["next"]["label"].lower()

    batch = call(client, "post", "/batches", manager, 201, json={
        "batch_name": "DS Weekend", "course_id": course, "branch_id": 1, "start_date": date.today().isoformat(),
        "capacity": 5, "start_time": "10:00", "end_time": "12:00", "schedule_days": "Sat, Sun"})
    call(client, "post", f"/admissions/{admission_id}/allocations", manager, 201, json={"batch_id": batch["batch_id"]})
    data = journey(client, sravani, lid)
    trail = {t["key"]: t for t in data["after_admission"]["trail"]}
    assert trail["batch_allocated"]["status"] == "done" and statuses(data)["batch"] == "done"
    assert "GNT-B-0001" in trail["batch_allocated"]["detail"] and "Sat, Sun 10:00–12:00" in trail["batch_allocated"]["detail"]
    assert data["next"]["action"] == "none" and data["next"]["can_act"] is False


def test_lost_lead_has_no_next_step(client, people):
    from models import LostReason
    from tests.helpers import lookup_id

    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani)
    call(client, "post", f"/leads/{lead['lead_id']}/lost", sravani,
         json={"lost_reason_id": lookup_id(LostReason, "FEE_TOO_HIGH")})
    data = journey(client, sravani, lead["lead_id"])
    assert data["next"] is None and all(s["status"] in ("done", "todo") for s in data["steps"])


def test_access_and_branch_scope(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    lid = lead["lead_id"]
    # another branch: the lead doesn't exist for them
    assert client.get(f"{API}/leads/{lid}/journey", headers=people["mounika"]["h"]).status_code == 404
    assert client.get(f"{API}/leads/{lid}/journey", headers=people["accounts_vij"]["h"]).status_code == 404
    assert client.get(f"{API}/leads/99999/journey", headers=sravani).status_code == 404
    # roles that act on the deal can read it; others cannot
    for name in ("bm", "accounts", "admin", "founder", "nikhil"):
        assert client.get(f"{API}/leads/{lid}/journey", headers=people[name]["h"]).status_code == 200, name
    assert client.get(f"{API}/leads/{lid}/journey", headers=people["trainer"]["h"]).status_code == 403
    assert client.get(f"{API}/leads/{lid}/journey").status_code == 401
    # a counsellor who doesn't own the lead may read it but not act on it
    other = create_lead(client, people["nikhil"]["h"], course_id=course, person={"full_name": "Other", "phone": "9000000777"})
    assert journey(client, sravani, other["lead_id"])["next"]["can_act"] is False
    assert journey(client, people["bm"]["h"], other["lead_id"])["next"]["can_act"] is True
    assert error_of(client.get(f"{API}/leads/{lid}/journey", headers=people["mounika"]["h"]))["message"]
