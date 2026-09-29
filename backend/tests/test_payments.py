"""Payments (V4): claims with transaction numbers, receipts only at verification, per-course allocation, split
tenders, advances, corrections."""
import io
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import Admission, Payment, Task
from tests.helpers import (
    API, call, create_invoice, issued_invoice, mode_id, paid_invoice, ready_deal, record_payment, verify_payment,
)


def test_record_verify_and_balances(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS")
    invoice_id = flow["invoice"]["invoice_id"]
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]

    recorded = record_payment(client, sravani, invoice_id, "15000")
    payment = recorded["payment"]
    assert recorded["advance"] is None and len(recorded["payments"]) == 1
    # A recorded payment is a claim: a transaction number, no receipt number yet
    assert payment["transaction_number"] == "TXN-GNT-00001" and payment["receipt_number"] is None
    assert payment["document_kind"] == "Payment claim" and payment["verification_status"] == "Pending Verification"
    assert [a["amount"] for a in payment["allocations"]] == ["15000.00"]
    assert call(client, "get", f"/leads/{flow['lead']['lead_id']}", sravani)["stage"] == "Payment Pending Verification"
    task = db.session.execute(select(Task).where(Task.dedupe_key == f"payment-verify:{payment['payment_id']}")).scalar_one()
    assert task.team_role.role_code == "ACCOUNTS"

    invoice = call(client, "get", f"/invoices/{invoice_id}", sravani)
    assert invoice["pending_verification"] == "15000.00" and invoice["verified_paid"] == "0.00"
    assert invoice["schedule"][0]["contact_hold"] is True and invoice["receipts"] == []

    url = f"{API}/payments/{payment['payment_id']}/verify"
    assert client.post(url, json={"evidence_reviewed": True}, headers=sravani).status_code == 403
    assert client.post(url, json={}, headers=accounts).status_code == 400                 # confirmation required
    assert client.post(url, json={"evidence_reviewed": False}, headers=accounts).status_code == 400
    verified = verify_payment(client, accounts, payment["payment_id"])
    assert verified["verification_status"] == "Verified" and verified["verified_by"]["full_name"] == "Accounts"
    assert verified["receipt_number"] == "GNT-R-2627-00001" and verified["evidence_reviewed"] is True
    assert [a["admission_code"][:12] for a in verified["admissions_created"]] == ["NIT-GNT-2026"]  # token reached
    again = client.post(url, json={"evidence_reviewed": True}, headers=accounts)
    assert again.status_code == 422
    db.session.refresh(task)
    assert task.status == "Completed"

    invoice = call(client, "get", f"/invoices/{invoice_id}", sravani)
    assert invoice["payment_completion"] == "Part Paid" and invoice["outstanding"] == "15000.00"
    assert invoice["schedule"][0]["due_position"] == "Paid"
    assert [r["receipt_number"] for r in invoice["receipts"]] == ["GNT-R-2627-00001"]
    ledger = client.get(f"{API}/payments", headers=accounts).get_json()
    assert Decimal(ledger["meta"]["totals"]["verified_net"]) == Decimal("15000")


def test_sample_acceptance_case(client, people, make_user, login):
    """V4 handoff: invoice ₹22,000; ₹5,000 claim pending = paid ₹0, balance ₹22,000; after verification one receipt,
    paid ₹5,000, balance ₹17,000 — and every finance view agrees."""
    from models import Course, CourseBranch

    power_bi = Course(course_code="NIT-CRS-022", course_title="Power BI", category="Data & Analytics",
                      standard_fee=22000, branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(power_bi)
    db.session.commit()
    flow = issued_invoice(client, people, power_bi.course_id, plan="TWO_INSTALMENTS")
    invoice_id = flow["invoice"]["invoice_id"]
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    assert flow["invoice"]["billed_amount"] == "22000.00"

    claim = record_payment(client, sravani, invoice_id, "5000", payment_mode_id=mode_id("CASH"), reference=None)["payment"]
    invoice = call(client, "get", f"/invoices/{invoice_id}", accounts)
    assert (invoice["verified_paid"], invoice["outstanding"], invoice["pending_verification"]) == (
        "0.00", "22000.00", "5000.00")
    assert invoice["receipts"] == [] and invoice["lines"][0]["outstanding"] == "22000.00"
    dues = call(client, "get", "/collections/dues", accounts)
    assert sum(Decimal(i["balance"]) for p in dues for i in p["installments"] if p["invoice"]["invoice_id"] == invoice_id) \
        == Decimal("22000")

    # Cash needs the independent check as well as the evidence review
    missing = client.post(f"{API}/payments/{claim['payment_id']}/verify", json={"evidence_reviewed": True},
                          headers=accounts)
    assert missing.status_code == 400 and "cash_checked" in missing.get_json()["error"]["details"]
    verified = verify_payment(client, accounts, claim["payment_id"], cash_checked=True)
    assert verified["receipt_number"].startswith("GNT-R-")

    invoice = call(client, "get", f"/invoices/{invoice_id}", accounts)
    assert (invoice["verified_paid"], invoice["outstanding"], invoice["pending_verification"]) == (
        "5000.00", "17000.00", "0.00")
    assert len(invoice["receipts"]) == 1 and invoice["lines"][0]["outstanding"] == "17000.00"
    listed = next(row for row in call(client, "get", "/invoices", accounts) if row["invoice_id"] == invoice_id)
    assert (listed["verified_paid"], listed["outstanding"]) == ("5000.00", "17000.00")
    printed = call(client, "get", f"/invoices/{invoice_id}/print", accounts)
    assert printed["totals"]["verified_paid"] == "5000.00" and printed["totals"]["balance_due"] == "17000.00"
    assert [r["receipt_number"] for r in printed["receipts"]] == [verified["receipt_number"]]
    admission = db.session.execute(select(Admission).where(Admission.invoice_id == invoice_id)).scalar_one()
    assert admission.balance.verified_paid == Decimal("5000.00") and admission.balance.outstanding == Decimal("17000.00")


def test_multi_course_allocation_split_tenders_and_line_caps(client, people, course):
    from tests.helpers import deal_course, plan_schedule

    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]
    lead, _, ver = ready_deal(client, people, course)                        # Data Science ₹30,000
    second = deal_course(1)                                                  # Foundation ₹20,000
    from tests.helpers import accept_delivery_plan, convert_lead, create_lead

    other = create_lead(client, sravani, person=None, person_id=lead["person"]["person_id"], course_id=second)
    convert_lead(client, sravani, other["lead_id"])
    disc = call(client, "post", f"/leads/{other['lead_id']}/fee-discussions", sravani, 201, json={})
    v2 = call(client, "post", f"/fee-discussions/{disc['fee_discussion_id']}/versions", sravani, 201, json={})
    call(client, "post", f"/fee-discussion-versions/{v2['version_id']}/approve", sravani)
    accept_delivery_plan(client, sravani, other["lead_id"])
    invoice = create_invoice(client, sravani, [lead["lead_id"], other["lead_id"]], installments=plan_schedule("TWO_INSTALMENTS", 50000))
    lines = {line["lead"]["lead_id"]: line for line in call(client, "get", f"/invoices/{invoice['invoice_id']}", sravani)["lines"]}
    ds, fnd = lines[lead["lead_id"]], lines[other["lead_id"]]

    # A line can't take more than is left on it
    over = client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice["invoice_id"], "allocations": [{"invoice_line_id": fnd["invoice_line_id"], "amount": "20001"}],
        "tenders": [{"amount": "20001", "payment_mode_id": mode_id("UPI_BANK"), "reference": "UTR1"}]})
    assert over.status_code == 400
    mismatch = client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice["invoice_id"], "allocations": [{"invoice_line_id": fnd["invoice_line_id"], "amount": "500"}],
        "tenders": [{"amount": "700", "payment_mode_id": mode_id("UPI_BANK"), "reference": "UTR1"}]})
    assert mismatch.status_code == 400

    # Split checkout: two tenders → two pending transactions, allocated across both courses
    recorded = call(client, "post", "/payments", sravani, 201, json={
        "invoice_id": invoice["invoice_id"],
        "allocations": [{"invoice_line_id": ds["invoice_line_id"], "amount": "3000"},
                        {"invoice_line_id": fnd["invoice_line_id"], "amount": "600"}],
        "tenders": [{"amount": "2000", "payment_mode_id": mode_id("UPI_BANK"), "reference": "UTR-A"},
                    {"amount": "1600", "payment_mode_id": mode_id("CASH")}]})
    first, second_tx = recorded["payments"]
    assert first["transaction_number"] != second_tx["transaction_number"]
    assert [a["amount"] for a in first["allocations"]] == ["2000.00"]
    assert [(a["line_code"], a["amount"]) for a in second_tx["allocations"]] == [
        (ds["line_code"], "1000.00"), (fnd["line_code"], "600.00")]

    # Verifying the first: Data Science reaches ₹1,000 → admitted; Foundation is not paid yet
    done = verify_payment(client, accounts, first["payment_id"])
    assert [a["course"]["course_id"] for a in done["admissions_created"]] == [course]
    done = verify_payment(client, accounts, second_tx["payment_id"], cash_checked=True)
    assert done["admissions_created"] == []                                  # ₹600 on Foundation: below the token
    detail = call(client, "get", f"/invoices/{invoice['invoice_id']}", sravani)
    by_line = {line["invoice_line_id"]: line for line in detail["lines"]}
    assert by_line[ds["invoice_line_id"]]["verified_paid"] == "3000.00"
    assert by_line[fnd["invoice_line_id"]]["verified_paid"] == "600.00"
    assert detail["verified_paid"] == "3600.00" and detail["outstanding"] == "46400.00"
    assert len(detail["receipts"]) == 2 and len(detail["admissions"]) == 1

    # ₹400 more on Foundation reaches its ₹1,000 token → second admission for the same person
    more = record_payment(client, sravani, invoice["invoice_id"], "400",
                          allocations=[{"invoice_line_id": fnd["invoice_line_id"], "amount": "400"}])["payment"]
    admitted = verify_payment(client, accounts, more["payment_id"])["admissions_created"]
    assert [a["course"]["course_id"] for a in admitted] == [second]
    persons = {a.person_id for a in db.session.execute(select(Admission)).scalars()}
    assert persons == {lead["person"]["person_id"]}


def test_payment_rules(client, people, course, make_user, login):
    flow = issued_invoice(client, people, course)
    invoice_id = flow["invoice"]["invoice_id"]
    sravani = people["sravani"]["h"]

    no_ref = client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice_id, "amount": "1000", "payment_mode_id": mode_id("UPI_BANK")})
    assert no_ref.status_code == 422 and "requires a reference" in no_ref.get_json()["error"]["message"]
    cheque = client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice_id, "amount": "1000", "payment_mode_id": mode_id("CHEQUE"), "reference": "CHQ-1"})
    assert cheque.status_code == 422 and "needs an approver" in cheque.get_json()["error"]["message"]
    assert client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice_id, "amount": "1000", "payment_mode_id": mode_id("CHEQUE"), "reference": "CHQ-1",
        "exception_approved_by": people["nikhil"]["id"]}).status_code == 400
    approved_cheque = record_payment(client, sravani, invoice_id, "1000", payment_mode_id=mode_id("CHEQUE"),
                                     reference="CHQ-1", exception_approved_by=people["bm"]["id"])
    assert approved_cheque["payment"]["exception_approved_by"] == people["bm"]["id"]
    assert client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice_id, "amount": "0", "payment_mode_id": mode_id("CASH")}).status_code == 400
    assert client.post(f"{API}/payments", headers=people["mounika"]["h"], json={
        "invoice_id": invoice_id, "amount": "10", "payment_mode_id": mode_id("CASH")}).status_code == 404
    trainer = client.post(f"{API}/payments", headers=people["trainer"]["h"], json={})
    assert trainer.status_code == 403


def test_excess_goes_in_as_an_advance_and_can_be_allocated(client, people, course):
    flow = issued_invoice(client, people, course)
    invoice_id = flow["invoice"]["invoice_id"]
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]

    refused = client.post(f"{API}/payments", headers=sravani, json={
        "invoice_id": invoice_id, "amount": "31000", "payment_mode_id": mode_id("CASH"), "split_excess": False})
    assert refused.status_code == 422
    split = record_payment(client, sravani, invoice_id, "31000", payment_mode_id=mode_id("CASH"), reference=None)
    assert split["payment"]["amount"] == "30000.00" and split["advance"]["amount"] == "1000.00"
    assert split["advance"]["invoice"] is None and split["advance"]["allocations"] == []

    unallocated = client.get(f"{API}/payments/unallocated", headers=accounts).get_json()["data"]
    assert [row["payment_id"] for row in unallocated] == [split["advance"]["payment_id"]]

    # a separate advance before any invoice (lead only), then allocated to the invoice once there's room
    advance = call(client, "post", "/payments", sravani, 201, json={
        "lead_id": flow["lead"]["lead_id"], "amount": "500", "payment_mode_id": mode_id("CASH")})["payment"]
    assert advance["invoice"] is None and advance["collecting_branch"]["branch_id"] == 1
    full = client.post(f"{API}/payments/{advance['payment_id']}/allocate", json={"invoice_id": invoice_id}, headers=accounts)
    assert full.status_code == 422 and "exceeds the outstanding" in full.get_json()["error"]["message"]
    assert client.post(f"{API}/payments/{advance['payment_id']}/allocate", json={"invoice_id": invoice_id},
                       headers=sravani).status_code == 403

    # once the big claim fails there is room: the advance goes onto the course line
    call(client, "post", f"/payments/{split['payment']['payment_id']}/fail", accounts, json={"failure_reason": "Bounced"})
    allocated = call(client, "post", f"/payments/{advance['payment_id']}/allocate", accounts, json={"invoice_id": invoice_id})
    assert allocated["invoice"]["invoice_id"] == invoice_id and allocated["allocations"][0]["amount"] == "500.00"


def test_fail_needs_reason_and_frees_the_cap(client, people, course):
    flow = issued_invoice(client, people, course)
    invoice_id = flow["invoice"]["invoice_id"]
    payment = record_payment(client, people["sravani"]["h"], invoice_id, "30000")["payment"]

    assert client.post(f"{API}/payments/{payment['payment_id']}/fail", json={}, headers=people["accounts"]["h"]).status_code == 400
    failed = call(client, "post", f"/payments/{payment['payment_id']}/fail", people["accounts"]["h"],
                  json={"failure_reason": "UTR not found in bank statement"})
    assert failed["verification_status"] == "Failed" and failed["receipt_number"] is None
    assert failed["document_kind"] == "Failed claim"
    retry = record_payment(client, people["sravani"]["h"], invoice_id, "30000")
    assert retry["advance"] is None


def test_correction_request_and_approval_appends_reversal(client, people, course):
    flow = paid_invoice(client, people, course, amount="10000")
    payment_id = flow["payment"]["payment_id"]
    accounts, founder, admin = people["accounts"]["h"], people["founder"]["h"], people["admin"]["h"]

    pending = record_payment(client, people["sravani"]["h"], flow["invoice"]["invoice_id"], "1000")["payment"]
    blocked = client.post(f"{API}/payments/{pending['payment_id']}/correction-requests", json={"reason": "x"}, headers=accounts)
    assert blocked.status_code == 422 and "mark it Failed" in blocked.get_json()["error"]["message"]
    assert client.post(f"{API}/payments/{payment_id}/correction-requests", json={}, headers=accounts).status_code == 400

    request = call(client, "post", f"/payments/{payment_id}/correction-requests", accounts, 201,
                   json={"reason": "Duplicate UTR entered"})
    assert request["request_code"] == "CR-GNT-0001" and request["amount"] == "10000.00"
    dup = client.post(f"{API}/payments/{payment_id}/correction-requests", json={"reason": "again"}, headers=accounts)
    assert dup.status_code == 409
    queue = call(client, "get", "/correction-requests?status=Pending Approval", accounts)
    assert [r["correction_request_id"] for r in queue] == [request["correction_request_id"]]

    assert client.post(f"{API}/correction-requests/{request['correction_request_id']}/approve", json={},
                       headers=accounts).status_code == 403
    approved = call(client, "post", f"/correction-requests/{request['correction_request_id']}/approve", founder, json={})
    assert approved["status"] == "Approved" and approved["reversal"]["receipt_number"].startswith("REV-GNT-")
    reversal = db.session.get(Payment, approved["reversal"]["payment_id"])
    assert reversal.amount == Decimal("-10000.00") and reversal.verified_by == people["founder"]["id"]
    assert [a.amount for a in reversal.allocations] == [Decimal("-10000.00")]      # takes it back from the course
    original = call(client, "get", f"/payments/{payment_id}", accounts)
    assert original["reversed_by_payment_id"] == reversal.payment_id and original["verification_status"] == "Verified"
    invoice = call(client, "get", f"/invoices/{flow['invoice']['invoice_id']}", accounts)
    assert invoice["verified_paid"] == "0.00" and invoice["lines"][0]["verified_paid"] == "0.00"

    call(client, "post", f"/payments/{payment_id}/correction-requests", admin, 422, json={"reason": "again"})


def test_self_approval_blocked_and_reject_needs_note(client, people, course):
    flow = paid_invoice(client, people, course, amount="5000")
    request = call(client, "post", f"/payments/{flow['payment']['payment_id']}/correction-requests", people["admin"]["h"],
                   201, json={"reason": "Wrong amount"})
    rid = request["correction_request_id"]
    assert client.post(f"{API}/correction-requests/{rid}/approve", json={}, headers=people["admin"]["h"]).status_code == 403
    assert client.post(f"{API}/correction-requests/{rid}/reject", json={}, headers=people["founder"]["h"]).status_code == 400
    rejected = call(client, "post", f"/correction-requests/{rid}/reject", people["founder"]["h"],
                    json={"decision_note": "Amount matches bank"})
    assert rejected["status"] == "Rejected" and rejected["reversal"] is None


def test_receipt_and_proof_upload(client, people, course):
    flow = issued_invoice(client, people, course)
    response = client.post(f"{API}/payments", headers=people["sravani"]["h"], content_type="multipart/form-data", data={
        "invoice_id": str(flow["invoice"]["invoice_id"]), "amount": "2000", "payment_mode_id": str(mode_id("UPI_BANK")),
        "reference": "UTR99", "proof": (io.BytesIO(b"%PDF-1.4 proof"), "proof.pdf")})
    assert response.status_code == 201, response.get_json()
    payment = response.get_json()["data"]["payment"]
    assert payment["proof_file_path"].startswith("payment-proofs/")

    claim = call(client, "get", f"/payments/{payment['payment_id']}/receipt", people["sravani"]["h"])
    assert claim["document"] == "Payment claim" and claim["receipt_number"] is None and claim["is_receipt"] is False
    assert claim["transaction_number"] == payment["transaction_number"]
    assert claim["issuer"]["address"].startswith("Door No. 6-4-35")
    verify_payment(client, people["accounts"]["h"], payment["payment_id"])
    receipt = call(client, "get", f"/payments/{payment['payment_id']}/receipt", people["sravani"]["h"])
    assert receipt["document"] == "Payment receipt" and receipt["receipt_number"].startswith("GNT-R-")

    bad = client.post(f"{API}/payments", headers=people["sravani"]["h"], content_type="multipart/form-data", data={
        "invoice_id": str(flow["invoice"]["invoice_id"]), "amount": "10", "payment_mode_id": str(mode_id("CASH")),
        "proof": (io.BytesIO(b"x"), "proof.exe")})
    assert bad.status_code == 400
