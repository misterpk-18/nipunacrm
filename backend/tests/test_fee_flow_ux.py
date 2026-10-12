"""Fee discussion UX: best-offer selection, inline concession check, save-and-request, validity countdown,
expiry reminder task and one-click re-issue."""
from datetime import date, timedelta

from sqlalchemy import select

from config.database import db
from models import Offer, Task
from services import fees as fees_service
from services import jobs
from tests.helpers import API, call, create_deal, priced_lead
from tests.test_fees_invoices import _invoice_for, _second_course


def _offer(run_sql, people, code, kind="Discount Amount", amount=None, percent=None, valid_from=-1, valid_to=30,
           branch_ids=None, **extra):
    run_sql("""INSERT INTO offers (offer_code, offer_name, status, benefit_type, discount_amount, discount_percent,
                                   applies_to_all_courses, applies_to_all_branches, valid_from, valid_to, approved_by)
               VALUES (:code, :name, 'Active', :kind, :amount, :percent, true, :all_branches,
                       current_date + :vf, current_date + :vt, :a)""",
            code=code, name=f"{code} offer", kind=kind, amount=amount, percent=percent, vf=valid_from, vt=valid_to,
            all_branches=branch_ids is None, a=people["admin"]["id"])
    offer_id = db.session.execute(select(Offer.offer_id).where(Offer.offer_code == code)).scalar_one()
    for branch_id in branch_ids or []:
        run_sql("INSERT INTO offer_branches (offer_id, branch_id) VALUES (:o, :b)", o=offer_id, b=branch_id)
    return offer_id


def _detail(client, headers, discussion):
    return call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}", headers)


def _deal(client, people, course, headers=None):
    headers = headers or people["sravani"]["h"]
    lead = create_deal(client, headers, course_id=course)
    discussion = call(client, "post", f"/leads/{lead['lead_id']}/fee-discussions", headers, 201, json={})
    return lead, discussion


# ---------------------------------------------------------------- best offer

def test_best_offer_is_largest_saving_and_unavailable_ones_say_why(client, people, course, run_sql):
    flat = _offer(run_sql, people, "FLAT2K", amount=2000)
    ten = _offer(run_sql, people, "TEN", "Discount Percent", percent=10)            # 3,000 on 30,000: best
    half = _offer(run_sql, people, "HALF", "Discount Percent", percent=50)           # 15,000: below the 70% floor
    _offer(run_sql, people, "VIJ", amount=5000, branch_ids=[2])
    _offer(run_sql, people, "ENDED", amount=5000, valid_from=-10, valid_to=-1)
    _offer(run_sql, people, "SOON", amount=5000, valid_from=5, valid_to=30)
    sravani = people["sravani"]["h"]
    _, discussion = _deal(client, people, course)

    options = _detail(client, sravani, discussion)["offer_options"]
    assert options["best_offer_id"] == ten
    eligible = {o["offer_code"]: o for o in options["eligible"]}
    assert set(eligible) == {"FLAT2K", "TEN", "HALF"}
    assert eligible["TEN"]["saving"] == "3000.00" and eligible["TEN"]["final_price"] == "27000.00" and eligible["TEN"]["is_best"]
    assert eligible["FLAT2K"]["is_best"] is False
    assert eligible["HALF"]["below_floor"] is True and eligible["HALF"]["is_best"] is False
    reasons = {u["offer_code"]: u["reason"] for u in options["unavailable"]}
    assert reasons["VIJ"] == "Not offered at this branch"
    assert reasons["ENDED"].startswith("Ended on") and reasons["SOON"].startswith("Starts on")

    # the counsellor can take another eligible offer, or none
    other = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201,
                 json={"offer_id": flat})
    assert other["final_payable"] == "28000.00"
    refused = client.post(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/versions", headers=sravani,
                          json={"offer_id": options["unavailable"][0]["offer_id"]})
    assert refused.status_code == 400
    assert call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani, 201,
                json={"offer_id": ten})["final_payable"] == "27000.00"
    assert eligible["HALF"]["offer_id"] == half  # eligible, flagged below the floor, never auto-picked


def test_best_offer_skips_an_offer_the_person_already_used(app, client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    once = _offer(run_sql, people, "ONCE", amount=2000)
    small = _offer(run_sql, people, "SMALL", "Discount Percent", percent=5)
    java = _second_course(app)
    first = create_deal(client, sravani, course_id=course)
    person_id = first["person"]["person_id"]
    _, _, created = _invoice_for(client, people, first["lead_id"], once)

    second = create_deal(client, sravani, person=None, person_id=person_id, course_id=java)   # 25,000: SMALL = 1,250
    discussion = call(client, "post", f"/leads/{second['lead_id']}/fee-discussions", sravani, 201, json={})
    options = _detail(client, sravani, discussion)["offer_options"]
    assert options["best_offer_id"] == small
    used = next(u for u in options["unavailable"] if u["offer_code"] == "ONCE")
    assert created[0]["admission_code"] in used["reason"] and "only once per person" in used["reason"]


def test_complimentary_offer_is_never_auto_picked_and_needs_a_course_the_learner_lacks(app, client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    java = _second_course(app)
    comp = _offer(run_sql, people, "FREEJAVA", "Complimentary Course")
    run_sql("INSERT INTO offer_complimentary_courses (offer_id, course_id, min_final_fee) VALUES (:o, :c, 0)", o=comp, c=java)
    flat = _offer(run_sql, people, "FLAT1K", amount=1000)
    first = create_deal(client, sravani, course_id=java)
    person_id = first["person"]["person_id"]

    fresh = create_deal(client, sravani, course_id=course, person={"full_name": "Fresh Learner", "phone": "93333 33333"})
    fresh_discussion = call(client, "post", f"/leads/{fresh['lead_id']}/fee-discussions", sravani, 201, json={})
    options = _detail(client, sravani, fresh_discussion)["offer_options"]
    assert options["best_offer_id"] == flat
    free = next(o for o in options["eligible"] if o["offer_code"] == "FREEJAVA")
    assert free["saving"] == "0.00" and free["complimentary_courses"][0]["course_id"] == java

    # the first person is admitted in Java; a second deal for them can't take Java as a free course
    _invoice_for(client, people, first["lead_id"], None)
    again = create_deal(client, sravani, person=None, person_id=person_id, course_id=course)
    discussion = call(client, "post", f"/leads/{again['lead_id']}/fee-discussions", sravani, 201, json={})
    unavailable = {u["offer_code"]: u["reason"] for u in _detail(client, sravani, discussion)["offer_options"]["unavailable"]}
    assert "already has every complimentary course" in unavailable["FREEJAVA"]


# ---------------------------------------------------------------- inline concession check

def _preview(client, headers, discussion, expected=200, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return call(client, "get", f"/fee-discussions/{discussion['fee_discussion_id']}/price-preview?{query}", headers, expected)


def test_price_preview_says_who_must_approve_and_my_limit(client, people, course, run_sql):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    _, discussion = _deal(client, people, course)

    none = _preview(client, sravani, discussion, extra=0)
    assert none["needs_approval"] is False and none["message"] == "No approval needed" and none["final_payable"] == "30000.00"

    small = _preview(client, sravani, discussion, extra=500)
    assert small["needs_approval"] and small["approver_role"] == "BRANCH_MANAGER"
    assert small["message"] == "Needs approval from Branch Manager (your limit ₹0)"
    assert small["within_my_limit"] is False and small["final_payable"] == "29500.00"

    # a Branch Manager's limit is the lower of 5% / ₹1,000
    mine = _preview(client, bm, discussion, extra=1000)
    assert mine["my_limit"] == "1000.00" and mine["within_my_limit"] is True
    assert "your limit ₹1,000" in mine["message"]
    bigger = _preview(client, sravani, discussion, extra=1500)
    assert bigger["approver_role"] in ("SUPER_ADMIN", "FOUNDER_CEO") and not bigger["below_floor"]

    # below the 70% floor (21,000): Founder / Super Admin plus a second approver
    low = _preview(client, sravani, discussion, extra=10000)
    assert low["below_floor"] and low["second_approver_required"] and low["approver_role"] in ("SUPER_ADMIN", "FOUNDER_CEO")
    assert "second approver" in low["message"]
    assert _preview(client, people["admin"]["h"], discussion, extra=1500)["my_limit_unlimited"] is True

    assert client.get(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/price-preview?extra=40000",
                      headers=sravani).status_code == 400
    assert client.get(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/price-preview?extra=-1",
                      headers=sravani).status_code == 400
    assert client.get(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/price-preview?extra=1",
                      headers=people["mounika"]["h"]).status_code == 404


def test_price_preview_applies_the_chosen_offer(client, people, course, run_sql):
    ten = _offer(run_sql, people, "TEN", "Discount Percent", percent=10)
    _, discussion = _deal(client, people, course)
    p = _preview(client, people["sravani"]["h"], discussion, offer_id=ten, extra=500)
    assert p["offer_discount"] == "3000.00" and p["final_payable"] == "26500.00"


# ---------------------------------------------------------------- save + request approval in one step

def test_save_and_request_approval_then_status_follows_the_decision(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    _, discussion = _deal(client, people, course)
    did = discussion["fee_discussion_id"]

    ver = call(client, "post", f"/fee-discussions/{did}/versions", sravani, 201,
               json={"extra_concession": "800", "request_reason": "Student is comparing two institutes"})
    scr = ver["special_closing_requests"][0]
    assert scr["status"] == "Pending" and ver["status"] == "Pending Approval" and scr["decision_due_at"]
    live = _detail(client, sravani, discussion)["current_version"]["special_closing_requests"][0]
    assert live["status"] == "Pending" and live["decision_reason"] is None

    call(client, "post", f"/special-closing-requests/{scr['scr_id']}/reject", bm, json={"reason": "Hold the price"})
    live = _detail(client, sravani, discussion)["current_version"]
    assert live["status"] == "Rejected"
    assert live["special_closing_requests"][0]["status"] == "Rejected"
    assert live["special_closing_requests"][0]["decision_reason"] == "Hold the price"
    assert live["special_closing_requests"][0]["decided_by_name"] == "BM Guntur"

    # a reason sent with no concession is ignored: nothing to approve
    plain = call(client, "post", f"/fee-discussions/{did}/versions", sravani, 201, json={"request_reason": "n/a"})
    assert plain["special_closing_requests"] == [] and plain["status"] == "Discussion Saved"


# ---------------------------------------------------------------- validity countdown

def test_validity_countdown_on_list_and_detail(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course)
    today = fees_service.business_today()
    left = (date.fromisoformat(ver["valid_until"]) - today).days
    assert left in (6, 7, 8)

    current = _detail(client, sravani, discussion)["current_version"]["validity"]
    assert current["days_left"] == left and current["state"] == "valid" and current["label"] == f"Valid {left} more days"
    listed = call(client, "get", f"/leads/{lead['lead_id']}/fee-discussions", sravani)[0]
    assert listed["current_version"]["validity"]["days_left"] == left

    run_sql("UPDATE fee_discussion_versions SET valid_until = :d WHERE version_id = :v",
            d=today + timedelta(days=1), v=ver["version_id"])
    assert _detail(client, sravani, discussion)["current_version"]["validity"] == {
        "valid_until": (today + timedelta(days=1)).isoformat(), "days_left": 1, "state": "expiring", "label": "Valid 1 more day"}
    run_sql("UPDATE fee_discussion_versions SET valid_until = :d WHERE version_id = :v", d=today - timedelta(days=2), v=ver["version_id"])
    expired = _detail(client, sravani, discussion)["current_version"]["validity"]
    assert expired["state"] == "expired" and expired["label"] == "Expired 2 days ago"


# ---------------------------------------------------------------- expiry reminder job

def test_expiry_reminder_one_task_per_version_for_the_owner(client, people, course, run_sql):
    sravani = people["sravani"]
    lead, discussion, ver = priced_lead(client, people, course)
    today = fees_service.business_today()

    assert fees_service.expiry_reminders() == 0   # a week away: nothing yet

    run_sql("UPDATE fee_discussion_versions SET valid_until = :d WHERE version_id = :v",
            d=today + timedelta(days=1), v=ver["version_id"])
    assert fees_service.expiry_reminders() == 1
    task = db.session.execute(select(Task).where(Task.dedupe_key == f"fee-expiry:{ver['version_id']}")).scalar_one()
    assert task.owner_user_id == sravani["id"] and task.fee_discussion_id == discussion["fee_discussion_id"]
    assert "expires tomorrow" in task.title and task.status == "Open"
    assert fees_service.expiry_reminders() == 0   # idempotent
    assert jobs.JOBS["fee-expiry"] is fees_service.expiry_reminders

    # a newer version supersedes the old one: its reminder is closed and the new one gets its own
    v2 = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", sravani["h"], 201, json={})
    db.session.refresh(task)
    assert task.status == "Completed"
    run_sql("UPDATE fee_discussion_versions SET valid_until = :d WHERE version_id = :v", d=today + timedelta(days=1), v=v2["version_id"])
    assert fees_service.expiry_reminders() == 1
    assert len(db.session.execute(select(Task).where(Task.dedupe_key.like("fee-expiry:%"))).scalars().all()) == 2


# ---------------------------------------------------------------- re-issue at the same price

def _lapse(run_sql, version_id, days=2):
    run_sql("UPDATE fee_discussion_versions SET valid_until = current_date - :d WHERE version_id = :v", d=days, v=version_id)


def test_reissue_at_same_price_creates_a_new_version(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    ten = _offer(run_sql, people, "TEN", "Discount Percent", percent=10)
    lead, discussion, ver = priced_lead(client, people, course, offer_id=ten)
    did = discussion["fee_discussion_id"]

    assert _detail(client, sravani, discussion)["reissue"]["available"] is False
    assert client.post(f"{API}/fee-discussions/{did}/reissue", headers=sravani).status_code == 422   # still valid

    _lapse(run_sql, ver["version_id"])
    info = _detail(client, sravani, discussion)["reissue"]
    assert info["available"] and info["same_price"] and info["changes"] == [] and info["new_final_payable"] == "27000.00"
    new = call(client, "post", f"/fee-discussions/{did}/reissue", sravani, 201)
    assert new["version_no"] == 2 and new["final_payable"] == "27000.00" and new["offer"]["offer_code"] == "TEN"
    assert new["status"] == "Discussion Saved" and "Re-issued from v1" in new["notes"]
    detail = _detail(client, sravani, discussion)
    assert detail["current_version"]["validity"]["state"] == "valid" and detail["reissue"]["available"] is False
    assert [v["status"] for v in detail["versions"]] == ["Superseded", "Discussion Saved"]


def test_reissue_explains_what_changed(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    ten = _offer(run_sql, people, "TEN", "Discount Percent", percent=10)
    lead, discussion, ver = priced_lead(client, people, course, offer_id=ten)
    did = discussion["fee_discussion_id"]

    # the offer ends: same price is gone
    _lapse(run_sql, ver["version_id"])
    run_sql("UPDATE offers SET valid_from = current_date - 20, valid_to = current_date - 1 WHERE offer_id = :o", o=ten)
    info = _detail(client, sravani, discussion)["reissue"]
    assert info["available"] and not info["same_price"]
    assert any("TEN offer is no longer available: Ended on" in c for c in info["changes"])
    assert any("price would now be ₹30000.00" in c for c in info["changes"])
    refused = client.post(f"{API}/fee-discussions/{did}/reissue", headers=sravani)
    assert refused.status_code == 422 and "no longer available" in refused.get_json()["error"]["message"]

    # a new standard fee also blocks it
    run_sql("UPDATE offers SET valid_to = current_date + 10 WHERE offer_id = :o", o=ten)
    assert _detail(client, sravani, discussion)["reissue"]["same_price"] is True
    run_sql("UPDATE courses SET standard_fee = 32000 WHERE course_id = :c", c=course)
    info = _detail(client, sravani, discussion)["reissue"]
    assert not info["same_price"] and any("standard fee is now ₹32000.00" in c for c in info["changes"])


def test_reissue_keeps_extra_concession_pending_approval(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, extra_concession="800")
    _lapse(run_sql, ver["version_id"])
    new = call(client, "post", f"/fee-discussions/{discussion['fee_discussion_id']}/reissue", sravani, 201)
    assert new["extra_concession"] == "800.00" and new["needs_special_closing"] and new["status"] == "Discussion Saved"
    assert client.post(f"{API}/fee-discussions/{discussion['fee_discussion_id']}/reissue",
                       headers=people["accounts"]["h"]).status_code == 403
