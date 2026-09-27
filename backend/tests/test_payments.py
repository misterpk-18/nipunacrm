"""Step 8: payments ledger, verification, advances, corrections, receipts."""
import io
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import Payment, Task
from tests.helpers import API, call, issued_invoice, mode_id, paid_invoice, record_payment


def test_record_verify_and_balances(client, people, course):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS")
    invoice_id = flow["invoice"]["invoice_id"]
    sravani, accounts = people["sravani"]["h"], people["accounts"]["h"]

    recorded = record_payment(client, sravani, invoice_id, "15000")
    payment = recorded["payment"]
    assert recorded["advance"] is None
    assert payment["receipt_number"].startswith("GNT-R-") and payment["verification_status"] == "Pending Verification"
    assert call(client, "get", f"/leads/{flow['lead']['lead_id']}", sravani)["stage"] == "Payment Pending Verification"
    task = db.session.execute(select(Task).where(Task.dedupe_key == f"payment-verify:{payment['payment_id']}")).scalar_one()
    assert task.team_role.role_code == "ACCOUNTS"

    invoice = call(client, "get", f"/invoices/{invoice_id}", sravani)
    assert invoice["pending_verification"] == "15000.00" and invoice["verified_paid"] == "0.00"
    assert invoice["schedule"][0]["contact_hold"] is True

    assert client.post(f"{API}/payments/{payment['payment_id']}/verify", headers=sravani).status_code == 403
    verified = call(client, "post", f"/payments/{payment['payment_id']}/verify", accounts)
    assert verified["verification_status"] == "Verified" and verified["verified_by"]["full_name"] == "Accounts"
    again = client.post(f"{API}/payments/{payment['payment_id']}/verify", headers=accounts)
    assert again.status_code == 422
    db.session.refresh(task)
    assert task.status == "Completed"

    invoice = call(client, "get", f"/invoices/{invoice_id}", sravani)
    assert invoice["payment_completion"] == "Part Paid" and invoice["outstanding"] == "15000.00"
    assert invoice["schedule"][0]["due_position"] == "Paid"
    ledger = client.get(f"{API}/payments", headers=accounts).get_json()
    assert Decimal(ledger["meta"]["totals"]["verified_net"]) == Decimal("15000")


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
    assert split["advance"]["invoice"] is None

    unallocated = client.get(f"{API}/payments/unallocated", headers=accounts).get_json()["data"]
    assert [row["payment_id"] for row in unallocated] == [split["advance"]["payment_id"]]

    # a separate advance before any invoice (lead only), then allocated to the invoice once there's room
    advance = call(client, "post", "/payments", sravani, 201, json={
        "lead_id": flow["lead"]["lead_id"], "amount": "500", "payment_mode_id": mode_id("CASH")})["payment"]
    assert advance["invoice"] is None and advance["collecting_branch"]["branch_id"] == 1
    full = client.post(f"{API}/payments/{advance['payment_id']}/allocate", json={"invoice_id": invoice_id}, headers=accounts)
    assert full.status_code == 422 and "exceeds outstanding" in full.get_json()["error"]["message"]
    assert client.post(f"{API}/payments/{advance['payment_id']}/allocate", json={"invoice_id": invoice_id},
                       headers=sravani).status_code == 403


def test_fail_needs_reason_and_frees_the_cap(client, people, course):
    flow = issued_invoice(client, people, course)
    invoice_id = flow["invoice"]["invoice_id"]
    payment = record_payment(client, people["sravani"]["h"], invoice_id, "30000")["payment"]

    assert client.post(f"{API}/payments/{payment['payment_id']}/fail", json={}, headers=people["accounts"]["h"]).status_code == 400
    failed = call(client, "post", f"/payments/{payment['payment_id']}/fail", people["accounts"]["h"],
                  json={"failure_reason": "UTR not found in bank statement"})
    assert failed["verification_status"] == "Failed"
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
    original = call(client, "get", f"/payments/{payment_id}", accounts)
    assert original["reversed_by_payment_id"] == reversal.payment_id and original["verification_status"] == "Verified"
    invoice = call(client, "get", f"/invoices/{flow['invoice']['invoice_id']}", accounts)
    assert invoice["verified_paid"] == "0.00"

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

    receipt = call(client, "get", f"/payments/{payment['payment_id']}/receipt", people["sravani"]["h"])
    assert receipt["document"].startswith("Acknowledgement of proof only")
    call(client, "post", f"/payments/{payment['payment_id']}/verify", people["accounts"]["h"])
    assert call(client, "get", f"/payments/{payment['payment_id']}/receipt", people["sravani"]["h"])["document"] == "Payment receipt"

    bad = client.post(f"{API}/payments", headers=people["sravani"]["h"], content_type="multipart/form-data", data={
        "invoice_id": str(flow["invoice"]["invoice_id"]), "amount": "10", "payment_mode_id": str(mode_id("CASH")),
        "proof": (io.BytesIO(b"x"), "proof.exe")})
    assert bad.status_code == 400
