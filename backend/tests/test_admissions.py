"""Step 9: admissions, complimentary courses, transfers, fee changes, batches, allocation, curriculum, completion."""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import Course, CourseBranch, Installment, Invoice
from tests.helpers import API, admitted, call, error_of, issued_invoice, record_payment


def test_admission_needs_both_prerequisites(client, people, course):
    sravani = people["sravani"]["h"]
    flow = issued_invoice(client, people, course)
    invoice_id = flow["invoice"]["invoice_id"]

    no_payment = client.post(f"{API}/admissions", json={"invoice_id": invoice_id}, headers=sravani)
    assert no_payment.status_code == 422 and "must be Verified by Accounts" in no_payment.get_json()["error"]["message"]
    payment = record_payment(client, sravani, invoice_id, "10000")["payment"]
    assert client.post(f"{API}/admissions", json={"invoice_id": invoice_id}, headers=sravani).status_code == 422
    call(client, "post", f"/payments/{payment['payment_id']}/verify", people["accounts"]["h"])
    assert call(client, "get", f"/invoices/{invoice_id}/admission-readiness", sravani)["ready"] is True

    admission = call(client, "post", "/admissions", sravani, 201, json={"invoice_id": invoice_id})
    year = date.today().year
    assert admission["admission_code"] == f"NIT-GNT-{year}-000001"
    assert admission["final_fee"] == "30000.00" and admission["enrolment_status"] == "Awaiting Batch Allocation"
    assert admission["first_qualifying_payment_id"] == payment["payment_id"]
    assert admission["balance"]["verified_paid"] == "10000.00" and admission["balance"]["payment_completion"] == "Part Paid"
    assert call(client, "get", f"/leads/{flow['lead']['lead_id']}", sravani)["stage"] == "Admitted"
    discussion = call(client, "get", f"/fee-discussions/{flow['discussion']['fee_discussion_id']}", sravani)
    assert discussion["milestone"] == "Converted"
    assert call(client, "get", f"/payments/{payment['payment_id']}", sravani)["admission_id"] == admission["admission_id"]

    again = client.post(f"{API}/admissions", json={"invoice_id": invoice_id}, headers=sravani)
    assert again.status_code == 409
    assert client.post(f"{API}/admissions", json={"invoice_id": invoice_id}, headers=people["accounts"]["h"]).status_code == 403


def test_plan_not_accepted_blocks_admission(client, people, course):
    from tests.helpers import plan_code_id, priced_lead

    sravani = people["sravani"]["h"]
    lead, discussion, ver = priced_lead(client, people, course, payment_plan_id=plan_code_id("FULL"))
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/approve", sravani)
    invoice = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/invoice", sravani, 201, json={})
    payment = record_payment(client, sravani, invoice["invoice_id"], "30000")["payment"]
    call(client, "post", f"/payments/{payment['payment_id']}/verify", people["accounts"]["h"])
    readiness = call(client, "get", f"/invoices/{invoice['invoice_id']}/admission-readiness", sravani)
    assert readiness["missing"] == ["accepted_plan"]
    blocked = client.post(f"{API}/admissions", json={"invoice_id": invoice["invoice_id"]}, headers=sravani)
    assert blocked.status_code == 422 and "accepted confirmed delivery plan" in blocked.get_json()["error"]["message"]


def test_list_detail_update_and_scope(client, people, course):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    rows = call(client, "get", "/admissions?enrolment_status=Awaiting Batch Allocation", people["bm"]["h"])
    assert [r["admission_id"] for r in rows] == [aid]
    assert client.get(f"{API}/admissions/{aid}", headers=people["mounika"]["h"]).status_code == 404
    updated = call(client, "patch", f"/admissions/{aid}", people["bm"]["h"],
                   json={"handover_status": "Completed", "lms_status": "Invited", "academic_owner_id": people["coordinator"]["id"]})
    assert updated["handover_status"] == "Completed" and updated["lms_status"] == "Invited"
    assert updated["academic_owner_id"] == people["coordinator"]["id"]
    assert client.patch(f"{API}/admissions/{aid}", json={"academic_owner_id": people["mounika"]["id"]},
                        headers=people["bm"]["h"]).status_code == 400


def test_cancel_and_transfer(client, people, course):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    assert client.post(f"{API}/admissions/{aid}/transfers", json={"to_branch_id": 2, "reason": "Moved city"},
                       headers=people["sravani"]["h"]).status_code == 403
    transfer = call(client, "post", f"/admissions/{aid}/transfers", people["bm"]["h"], 201,
                    json={"to_branch_id": 2, "reason": "Moved city"})
    assert (transfer["from_branch_id"], transfer["to_branch_id"]) == (1, 2)
    detail = call(client, "get", f"/admissions/{aid}", people["bm_vij"]["h"])  # now visible at the new branch
    assert detail["service_branch"]["branch_id"] == 2 and detail["original_branch"]["branch_id"] == 1

    assert client.post(f"{API}/admissions/{aid}/cancel", json={"reason": "x"}, headers=people["bm"]["h"]).status_code == 403
    assert client.post(f"{API}/admissions/{aid}/cancel", json={}, headers=people["bm_vij"]["h"]).status_code == 400
    cancelled = call(client, "post", f"/admissions/{aid}/cancel", people["bm_vij"]["h"], json={"reason": "Dropped out"})
    assert cancelled["enrolment_status"] == "Cancelled" and cancelled["cancellation"]["reason"] == "Dropped out"
    assert cancelled["balance"]["outstanding"] == "0.00"


def test_fee_change_approve_then_apply(client, people, course):
    flow = admitted(client, people, course, plan="TWO_INSTALMENTS", amount="15000")
    aid = flow["admission"]["admission_id"]
    sravani, founder, accounts = people["sravani"]["h"], people["founder"]["h"], people["accounts"]["h"]

    change = call(client, "post", f"/admissions/{aid}/fee-changes", sravani, 201,
                  json={"new_fee": "28000", "reason": "Scholarship granted"})
    assert change["old_fee"] == "30000.00" and change["status"] == "Pending"
    assert client.post(f"{API}/admissions/{aid}/fee-changes", json={"new_fee": "27000", "reason": "x"},
                       headers=sravani).status_code == 409  # one open change at a time
    assert client.post(f"{API}/admission-fee-changes/{change['fee_change_id']}/apply", headers=accounts).status_code == 422
    assert client.post(f"{API}/admission-fee-changes/{change['fee_change_id']}/approve", headers=people["bm"]["h"]).status_code == 403
    approved = call(client, "post", f"/admission-fee-changes/{change['fee_change_id']}/approve", founder, json={})
    assert approved["status"] == "Approved" and approved["approved_at"]

    applied = call(client, "post", f"/admission-fee-changes/{change['fee_change_id']}/apply", accounts)
    assert applied["status"] == "Applied" and applied["accounts_corrected_by"] == people["accounts"]["id"]
    assert call(client, "get", f"/admissions/{aid}", sravani)["final_fee"] == "28000.00"
    invoice = db.session.get(Invoice, flow["invoice"]["invoice_id"])
    db.session.refresh(invoice)
    assert invoice.billed_amount == Decimal("28000.00") and invoice.original_billed_amount == Decimal("30000.00")
    amounts = [i.amount_due for i in db.session.execute(
        select(Installment).where(Installment.invoice_id == invoice.invoice_id).order_by(Installment.installment_no)).scalars()]
    assert amounts == [Decimal("14000.00"), Decimal("14000.00")]


def test_fee_change_below_verified_and_rejection(client, people, course):
    flow = admitted(client, people, course, amount="20000")
    aid = flow["admission"]["admission_id"]
    change = call(client, "post", f"/admissions/{aid}/fee-changes", people["sravani"]["h"], 201,
                  json={"new_fee": "15000", "reason": "Course downgrade"})
    call(client, "post", f"/admission-fee-changes/{change['fee_change_id']}/approve", people["founder"]["h"], json={})
    below = client.post(f"{API}/admission-fee-changes/{change['fee_change_id']}/apply", headers=people["accounts"]["h"])
    assert below.status_code == 422 and "below verified payments" in below.get_json()["error"]["message"]

    other = admitted(client, people, course, amount="30000")
    change2 = call(client, "post", f"/admissions/{other['admission']['admission_id']}/fee-changes", people["admin"]["h"], 201,
                   json={"new_fee": "31000", "reason": "Added module"})
    assert client.post(f"{API}/admission-fee-changes/{change2['fee_change_id']}/approve", json={},
                       headers=people["admin"]["h"]).status_code == 403  # own request
    assert client.post(f"{API}/admission-fee-changes/{change2['fee_change_id']}/reject", json={},
                       headers=people["founder"]["h"]).status_code == 400
    rejected = call(client, "post", f"/admission-fee-changes/{change2['fee_change_id']}/reject", people["founder"]["h"],
                    json={"reason": "Not agreed"})
    assert rejected["status"] == "Rejected"


# ---------------------------------------------------------------- academics

def published_curriculum(client, people, course, label="v2026.1"):
    return call(client, "post", "/curriculum-versions", people["coordinator"]["h"], 201,
                json={"course_id": course, "version_label": label, "publish": True})


def make_batch(client, people, course, branch_id=1, capacity=2, **extra):
    headers = people["coordinator"]["h"] if branch_id == 1 else people["bm_vij"]["h"]
    return call(client, "post", "/batches", headers, 201, json={
        "batch_name": "DS Weekend", "course_id": course, "branch_id": branch_id, "start_date": date.today().isoformat(),
        "capacity": capacity, "start_time": "10:00", "end_time": "12:00", "schedule_days": "Sat, Sun", **extra})


def test_curriculum_batch_and_allocation_flow(client, people, course):
    coordinator = people["coordinator"]["h"]
    curriculum = published_curriculum(client, people, course)
    batch = make_batch(client, people, course, trainer_user_id=people["trainer"]["id"])
    assert batch["batch_code"] == "GNT-B-0001" and batch["curriculum_version"]["version_label"] == "v2026.1"
    assert batch["seats_left"] == 2 and batch["is_full"] is False

    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    queue = call(client, "get", "/batch-allocation-queue", coordinator)
    assert [row["admission"]["admission_id"] for row in queue] == [aid] and queue[0]["allocate_by"]

    check = call(client, "get", f"/batches/{batch['batch_id']}/allocation-check?admission_id={aid}", coordinator)
    assert check["ok"] is False and check["reason"].startswith("Curriculum Mapping Pending")
    assert check["recovery_owner"].startswith("Academic Coordinator (NIT-GNT)")
    blocked = client.post(f"{API}/admissions/{aid}/allocations", json={"batch_id": batch["batch_id"]}, headers=coordinator)
    assert blocked.status_code == 422 and "Curriculum Mapping Pending" in blocked.get_json()["error"]["message"]

    mapped = call(client, "post", f"/admissions/{aid}/curricula", coordinator,
                  json={"curriculum_version_id": curriculum["curriculum_version_id"]})
    assert mapped["curriculum_status"] == "Mapped"
    assert call(client, "get", f"/batches/{batch['batch_id']}/allocation-check?admission_id={aid}", coordinator)["ok"]
    allocation = call(client, "post", f"/admissions/{aid}/allocations", coordinator, 201, json={"batch_id": batch["batch_id"]})
    assert call(client, "get", f"/admissions/{aid}", coordinator)["enrolment_status"] == "Scheduled"
    workspace = call(client, "get", f"/batches/{batch['batch_id']}", coordinator)
    assert workspace["allocated"] == 1 and len(workspace["allocations"]) == 1

    assert client.post(f"{API}/batch-allocations/{allocation['allocation_id']}/joining-date",
                       json={"joining_date": (date.today() + timedelta(days=1)).isoformat()}, headers=coordinator).status_code == 400
    joined = call(client, "post", f"/batch-allocations/{allocation['allocation_id']}/joining-date", people["trainer"]["h"],
                  json={"joining_date": date.today().isoformat()})
    assert joined["joining_date"] == date.today().isoformat()
    assert call(client, "get", f"/admissions/{aid}", coordinator)["enrolment_status"] == "In Progress"

    completed = call(client, "post", f"/admissions/{aid}/complete", coordinator)
    assert completed["enrolment_status"] == "Completed" and completed["support_until"] and completed["academic_completed_at"]
    assert call(client, "get", f"/admissions/{aid}", coordinator)["allocations"][0]["status"] == "Completed"


def test_allocation_blocks_wrong_branch_and_full_batch(client, people, course):
    coordinator = people["coordinator"]["h"]
    curriculum = published_curriculum(client, people, course)
    db.session.add(CourseBranch(course_id=course, branch_code="NIT-VIJ"))
    db.session.commit()
    vij_batch = make_batch(client, people, course, branch_id=2)
    tiny = make_batch(client, people, course, capacity=1)

    first = admitted(client, people, course)
    for flow in [first]:
        call(client, "post", f"/admissions/{flow['admission']['admission_id']}/curricula", coordinator,
             json={"curriculum_version_id": curriculum["curriculum_version_id"]})
    aid = first["admission"]["admission_id"]
    wrong = call(client, "get", f"/batches/{vij_batch['batch_id']}/allocation-check?admission_id={aid}", people["admin"]["h"])
    assert wrong["ok"] is False and wrong["reason"].startswith("Wrong branch") and wrong["recovery_owner"] == "Branch Manager (NIT-GNT)"
    call(client, "post", f"/admissions/{aid}/allocations", coordinator, 201, json={"batch_id": tiny["batch_id"]})
    dup = client.post(f"{API}/admissions/{aid}/allocations", json={"batch_id": tiny["batch_id"]}, headers=coordinator)
    assert dup.status_code == 422

    second = admitted(client, people, course)
    sid = second["admission"]["admission_id"]
    call(client, "post", f"/admissions/{sid}/curricula", coordinator, json={"curriculum_version_id": curriculum["curriculum_version_id"]})
    full = call(client, "get", f"/batches/{tiny['batch_id']}/allocation-check?admission_id={sid}", coordinator)
    assert full["ok"] is False and full["reason"].startswith("Full capacity")
    assert client.post(f"{API}/admissions/{sid}/allocations", json={"batch_id": tiny["batch_id"]}, headers=coordinator).status_code == 422


def test_batch_rules(client, people, course):
    combo = Course(course_code="NIT-CMB-001", course_title="Combo", category="Combo", standard_fee=50000, is_combo=True,
                   branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(combo)
    db.session.commit()
    coordinator = people["coordinator"]["h"]
    combo_batch = client.post(f"{API}/batches", headers=coordinator, json={
        "batch_name": "Combo", "course_id": combo.course_id, "branch_id": 1, "start_date": date.today().isoformat(),
        "capacity": 10})
    assert combo_batch.status_code == 422 and "standalone" in combo_batch.get_json()["error"]["message"]
    assert client.post(f"{API}/batches", headers=people["mounika"]["h"], json={}).status_code == 403
    assert client.post(f"{API}/batches", headers=people["bm_vij"]["h"], json={
        "batch_name": "x", "course_id": course, "branch_id": 1, "start_date": date.today().isoformat(),
        "capacity": 5}).status_code == 403
    batch = make_batch(client, people, course, capacity=5)
    assert client.post(f"{API}/batches", headers=coordinator, json={
        "batch_name": "x", "course_id": course, "branch_id": 1, "start_date": date.today().isoformat(),
        "capacity": 5, "min_students": 6}).status_code == 422
    patched = call(client, "patch", f"/batches/{batch['batch_id']}", coordinator, json={"status": "Open", "location": "Lab 2"})
    assert patched["status"] == "Open" and patched["location"] == "Lab 2"


def test_curriculum_publish_retires_previous(client, people, course):
    published_curriculum(client, people, course, "v2026.1")
    v2 = call(client, "post", "/curriculum-versions", people["coordinator"]["h"], 201,
              json={"course_id": course, "version_label": "v2026.2"})
    assert v2["status"] == "Draft"
    call(client, "post", f"/curriculum-versions/{v2['curriculum_version_id']}/publish", people["coordinator"]["h"])
    versions = {v["version_label"]: v["status"] for v in call(client, "get", f"/curriculum-versions?course_id={course}",
                                                              people["coordinator"]["h"])}
    assert versions == {"v2026.1": "Retired", "v2026.2": "Published"}


def test_complimentary_course(client, people, course, run_sql):
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

    flow = admitted(client, people, course)
    comp = call(client, "post", f"/admissions/{flow['admission']['admission_id']}/complimentary", people["sravani"]["h"], 201,
                json={"offer_id": offer_id, "course_id": excel.course_id})
    assert comp["final_fee"] == "0.00" and comp["complimentary_of_admission_id"] == flow["admission"]["admission_id"]
    assert comp["access_until"] == (date.today() + timedelta(days=90)).isoformat()
    def grant(offer, course_id):
        return client.post(f"{API}/admissions/{flow['admission']['admission_id']}/complimentary",
                           headers=people["sravani"]["h"], json={"offer_id": offer, "course_id": course_id})

    # one complimentary course per offer per paid admission, even when the offer lists several
    tally = Course(course_code="NIT-CRS-091", course_title="Tally Prime", category="Office", standard_fee=4000,
                   branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(tally)
    db.session.commit()
    run_sql("INSERT INTO offer_complimentary_courses (offer_id, course_id, min_final_fee) VALUES (:o, :c, 0)",
            o=offer_id, c=tally.course_id)
    for course_id in (excel.course_id, tally.course_id):
        second = grant(offer_id, course_id)
        assert second.status_code == 422 and "one complimentary course per admission" in error_of(second)["message"]

    # never a course the learner already has (here: the paid course itself, from another offer)
    run_sql("""INSERT INTO offers (offer_code, offer_name, status, benefit_type, applies_to_all_courses, valid_from,
                                   valid_to, approved_by)
               VALUES ('BONUS', 'Bonus course', 'Active', 'Complimentary Course', true, current_date - 1, current_date + 30, :a)""",
            a=people["admin"]["id"])
    bonus_id = run_sql("SELECT offer_id FROM offers WHERE offer_code = 'BONUS'").scalar()
    for course_id in (course, tally.course_id):
        run_sql("INSERT INTO offer_complimentary_courses (offer_id, course_id, min_final_fee) VALUES (:o, :c, 0)",
                o=bonus_id, c=course_id)
    same_course = grant(bonus_id, course)
    assert same_course.status_code == 422 and "already has this course" in error_of(same_course)["message"]
    other = grant(bonus_id, tally.course_id)
    assert other.status_code == 201, error_of(other)  # a different offer can still give a course they don't have
