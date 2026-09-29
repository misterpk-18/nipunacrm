"""Steps 10–12: Student 360, documents, certificates, support cases, collections, refunds."""
import io
from datetime import date, timedelta

from sqlalchemy import select

from config.database import db
from models import DocumentType, SupportCaseType, Task
from tests.helpers import API, admitted, backdate_installment, call, issued_invoice, lookup_id


def doc_type(code):
    return lookup_id(DocumentType, code)


# ---------------------------------------------------------------- students

def test_student_list_header_and_tabs(client, people, course):
    flow = admitted(client, people, course, amount="10000")
    person_id = flow["admission"]["person"]["person_id"]
    bm = people["bm"]["h"]

    rows = call(client, "get", "/students", bm)
    assert [r["person_id"] for r in rows] == [person_id]
    assert rows[0]["admissions"] == 1 and rows[0]["active_courses"] == ["Data Science"]
    assert rows[0]["verified_paid"] == "10000.00" and rows[0]["outstanding"] == "20000.00"
    assert call(client, "get", "/students", people["mounika"]["h"]) == []
    assert client.get(f"{API}/students/{person_id}", headers=people["mounika"]["h"]).status_code == 404

    header = call(client, "get", f"/students/{person_id}", bm)
    assert header["is_active"] and not header["is_alumni"]
    finance = call(client, "get", f"/students/{person_id}/finance", bm)
    assert len(finance["invoices"]) == 1 and len(finance["payments"]) == 1
    assert finance["balances"][0]["outstanding"] == "20000.00"
    assert len(call(client, "get", f"/students/{person_id}/admissions", bm)) == 1
    timeline = call(client, "get", f"/students/{person_id}/timeline", bm)
    assert {e["kind"] for e in timeline} >= {"payment", "admission", "lead_activity"}
    audit = call(client, "get", f"/students/{person_id}/audit", bm)
    assert {e["action"] for e in audit} >= {"ADMISSION_CREATED", "PAYMENT_VERIFIED"}
    assert client.get(f"{API}/students/{person_id}/nope", headers=bm).status_code == 404


def test_documents_upload_review_and_checklist(client, people, course):
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]
    nikhil, bm = people["nikhil"]["h"], people["bm"]["h"]

    checklist = call(client, "get", f"/students/{person_id}/documents", bm)["checklist"]
    assert [(c["document_type"], c["status"]) for c in checklist] == [("Identity proof", "Not Uploaded")]

    def upload(expected=201, name="aadhaar.pdf"):
        return client.post(f"{API}/persons/{person_id}/documents", headers=nikhil, content_type="multipart/form-data",
                           data={"document_type_id": str(doc_type("IDENTITY_PROOF")),
                                 "file": (io.BytesIO(b"%PDF id"), name)})

    first = upload()
    assert first.status_code == 201, first.get_json()
    document = first.get_json()["data"]
    assert document["status"] == "Review Required"
    assert db.session.execute(select(Task).where(Task.dedupe_key == f"document-review:{document['document_id']}")).scalar_one()
    assert upload().status_code == 409  # one live file per type
    assert client.post(f"{API}/persons/{person_id}/documents", headers=nikhil, content_type="multipart/form-data",
                       data={"document_type_id": str(doc_type("PHOTO"))}).status_code == 400

    url = f"{API}/documents/{document['document_id']}/review"
    assert client.post(url, json={"status": "Verified"}, headers=nikhil).status_code == 403  # uploader
    assert client.post(url, json={"status": "Rejected"}, headers=bm).status_code == 400
    rejected = call(client, "post", f"/documents/{document['document_id']}/review", bm,
                    json={"status": "Rejected", "rejection_reason": "Blurred scan"})
    assert rejected["status"] == "Rejected" and rejected["reviewed_at"]
    again = upload(name="aadhaar-2.pdf").get_json()["data"]
    call(client, "post", f"/documents/{again['document_id']}/review", bm, json={"status": "Verified"})
    checklist = call(client, "get", f"/students/{person_id}/documents", bm)["checklist"]
    assert checklist[0]["status"] == "Verified"


def test_certificates(client, people, course, run_sql):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    coordinator = people["coordinator"]["h"]

    certificate = call(client, "post", f"/admissions/{aid}/certificates", coordinator, 201, json={})
    assert certificate["status"] == "Eligibility Pending" and certificate["certificate_number"] is None
    assert client.post(f"{API}/certificates/{certificate['certificate_id']}/issue", headers=coordinator).status_code == 422
    call(client, "patch", f"/certificates/{certificate['certificate_id']}", coordinator, json={"status": "Eligible"})
    issued = call(client, "post", f"/certificates/{certificate['certificate_id']}/issue", coordinator)
    assert issued["status"] == "Issued" and issued["certificate_number"].startswith("GNT-C-")
    assert client.post(f"{API}/admissions/{aid}/certificates", json={}, headers=coordinator).status_code == 409
    assert client.post(f"{API}/certificates/{certificate['certificate_id']}/revoke", json={"reason": "x"},
                       headers=coordinator).status_code == 403
    revoked = call(client, "post", f"/certificates/{certificate['certificate_id']}/revoke", people["admin"]["h"],
                   json={"reason": "Issued in error"})
    assert revoked["status"] == "Revoked"
    assert call(client, "post", f"/admissions/{aid}/certificates", coordinator, 201, json={})  # new one after revoke


def test_support_cases(client, people, course):
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]
    case_type = lookup_id(SupportCaseType, "LMS_TECHNICAL")
    case = call(client, "post", "/support-cases", people["nikhil"]["h"], 201, json={
        "person_id": person_id, "admission_id": flow["admission"]["admission_id"], "support_case_type_id": case_type,
        "subject": "Can't log into LMS"})
    assert case["case_code"] == "SUP-00001" and case["branch"]["branch_id"] == 1
    assert client.patch(f"{API}/support-cases/{case['support_case_id']}", json={"status": "Resolved"},
                        headers=people["nikhil"]["h"]).status_code == 400
    resolved = call(client, "patch", f"/support-cases/{case['support_case_id']}", people["nikhil"]["h"],
                    json={"status": "Resolved", "resolution_notes": "Password reset"})
    assert resolved["resolved_at"]
    assert len(call(client, "get", f"/students/{person_id}/cases", people["bm"]["h"])["support_cases"]) == 1
    assert call(client, "get", "/support-cases", people["mounika"]["h"]) == []


# ---------------------------------------------------------------- collections

def test_dues_ageing_and_promises(client, people, course, run_sql):
    flow = admitted(client, people, course, plan="TWO_INSTALMENTS", amount="15000")
    invoice_id = flow["invoice"]["invoice_id"]
    backdate_installment(run_sql, invoice_id, 2, 5)
    accounts = people["accounts"]["h"]

    plans = call(client, "get", "/collections/dues", accounts)
    assert len(plans) == 1 and plans[0]["balance"] == "15000.00" and plans[0]["max_days_overdue"] == 5
    assert [i["installment_no"] for i in plans[0]["installments"]] == [2]
    assert plans[0]["installments"][0]["age_band"] == "4–7"
    assert call(client, "get", "/collections/dues?position=Due Today", accounts) == []
    assert call(client, "get", "/collections/dues?plan_code=FULL", accounts) == []
    ageing = call(client, "get", "/collections/ageing", accounts)
    assert list(ageing) == ["1–3", "4–7", "8–15", "16–30", "31–60", "61–90", "91+"]
    assert ageing["4–7"] == {"installments": 1, "balance": "15000.00"}
    assert call(client, "get", "/collections/dues", people["mounika"]["h"]) == []

    aid = flow["admission"]["admission_id"]
    body = {"promised_amount": "15000", "promised_date": (date.today() + timedelta(days=3)).isoformat()}
    assert client.post(f"{API}/admissions/{aid}/promises", json={**body, "promised_amount": "99999"},
                       headers=accounts).status_code == 400
    promise = call(client, "post", f"/admissions/{aid}/promises", accounts, 201, json=body)
    assert client.post(f"{API}/admissions/{aid}/promises", json=body, headers=accounts).status_code == 409
    broken = call(client, "post", f"/payment-promises/{promise['promise_id']}/broken", accounts)
    assert broken["status"] == "Broken" and broken["resolved_at"]
    assert client.post(f"{API}/payment-promises/{promise['promise_id']}/kept", headers=accounts).status_code == 422
    assert len(call(client, "get", f"/admissions/{aid}/promises", accounts)) == 1


def test_promises_are_per_invoice_even_before_admission(client, people, course):
    """db 021: a promise to pay belongs to the invoice (shared by every course on it), so it works pre-admission."""
    invoice_id = issued_invoice(client, people, course)["invoice"]["invoice_id"]
    accounts = people["accounts"]["h"]
    body = {"promised_amount": "5000", "promised_date": (date.today() + timedelta(days=2)).isoformat()}
    promise = call(client, "post", f"/invoices/{invoice_id}/promises", accounts, 201, json=body)
    assert promise["invoice_id"] == invoice_id and promise["admission_id"] is None
    assert client.post(f"{API}/invoices/{invoice_id}/promises", json=body, headers=accounts).status_code == 409
    assert [p["promise_id"] for p in call(client, "get", f"/invoices/{invoice_id}/promises", accounts)] == [promise["promise_id"]]
    assert client.get(f"{API}/invoices/{invoice_id}/promises", headers=people["mounika"]["h"]).status_code == 404
    detail = call(client, "get", f"/invoices/{invoice_id}", accounts)
    assert [p["promise_id"] for p in detail["promises"]] == [promise["promise_id"]]


def test_pre_admission_invoice_shows_in_dues(client, people, course):
    issued_invoice(client, people, course)
    plans = call(client, "get", "/collections/dues?position=Due Today", people["accounts"]["h"])
    assert len(plans) == 1 and plans[0]["admission_ids"] == [] and len(plans[0]["courses"]) == 1


# ---------------------------------------------------------------- refunds

def test_refund_case_lifecycle(client, people, course):
    flow = admitted(client, people, course, amount="30000")
    aid, payment_id = flow["admission"]["admission_id"], flow["payment"]["payment_id"]
    bm, admin, accounts = people["bm"]["h"], people["admin"]["h"], people["accounts"]["h"]

    case = call(client, "post", "/refund-cases", bm, 201, json={
        "admission_id": aid, "request_reason": "Relocating abroad", "payment_ids": [payment_id]})
    assert case["case_code"] == "NIT-RF-00001" and case["status"] == "Registered" and case["decision_due_at"]
    assert case["receipt_payment_ids"] == [payment_id]
    cid = case["refund_case_id"]
    assessed = call(client, "patch", f"/refund-cases/{cid}", bm,
                    json={"assessment_date": date.today().isoformat(), "evidence_status": "Evidence Complete"})
    assert assessed["status"] == "Under Assessment"

    assert client.post(f"{API}/refund-cases/{cid}/decide", json={"decision": "Refund Approved", "amount": "5000"},
                       headers=bm).status_code == 403
    too_much = client.post(f"{API}/refund-cases/{cid}/decide", json={"decision": "Refund Approved", "amount": "40000"},
                           headers=admin)
    assert too_much.status_code == 422 and "exceeds verified payments" in too_much.get_json()["error"]["message"]
    decided = call(client, "post", f"/refund-cases/{cid}/decide", admin, json={"decision": "Refund Approved", "amount": "12000"})
    assert decided["refund_decision"] == "Refund Approved" and decided["payout_due_at"] and decided["payout_status"] == "Approved"

    assert client.post(f"{API}/refund-cases/{cid}/payout", json={"status": "Completed"}, headers=accounts).status_code == 422
    processing = call(client, "post", f"/refund-cases/{cid}/payout", accounts,
                      json={"status": "Processing", "payout_reference": "NEFT-778"})
    assert processing["payout_amount"] == "12000.00"
    not_reconciled = client.post(f"{API}/refund-cases/{cid}/payout", json={"status": "Completed"}, headers=accounts)
    assert not_reconciled.status_code == 422 and "Reconcile" in not_reconciled.get_json()["error"]["message"]
    call(client, "post", f"/refund-cases/{cid}/reconcile", accounts)
    done = call(client, "post", f"/refund-cases/{cid}/payout", accounts, json={"status": "Completed"})
    assert done["status"] == "Completed" and done["payout_status"] == "Completed"
    assert call(client, "get", f"/admissions/{aid}", bm)["balance"]["refunded"] == "12000.00"
    assert client.post(f"{API}/refund-cases/{cid}/withdraw", json={}, headers=bm).status_code == 422


def test_refund_separation_of_duties_waiver_and_withdraw(client, people, course, make_user, login):
    flow = admitted(client, people, course, amount="10000")
    aid = flow["admission"]["admission_id"]
    # someone who is both Super Admin and Accounts can't decide and then pay out the same refund
    both = make_user(roles=[("SUPER_ADMIN", None), ("ACCOUNTS", 1)])
    both_h = login(both.email)
    case = call(client, "post", "/refund-cases", people["accounts"]["h"], 201, json={"admission_id": aid, "request_reason": "x"})
    call(client, "post", f"/refund-cases/{case['refund_case_id']}/decide", both_h, json={"decision": "Refund Approved", "amount": "1000"})
    same = client.post(f"{API}/refund-cases/{case['refund_case_id']}/payout", json={"status": "Processing", "payout_reference": "r"},
                       headers=both_h)
    assert same.status_code == 422

    waiver = call(client, "post", "/refund-cases", people["bm"]["h"], 201, json={"admission_id": aid, "request_reason": "Hardship"})
    decided = call(client, "post", f"/refund-cases/{waiver['refund_case_id']}/decide", people["founder"]["h"],
                   json={"decision": "Waiver Approved", "amount": "5000"})
    assert decided["approved_waiver_amount"] == "5000.00"
    assert call(client, "get", f"/admissions/{aid}", people["bm"]["h"])["balance"]["outstanding"] == "15000.00"

    third = call(client, "post", "/refund-cases", people["bm"]["h"], 201, json={"admission_id": aid, "request_reason": "Changed mind"})
    assert client.post(f"{API}/refund-cases/{third['refund_case_id']}/decide", json={"decision": "Rejected"},
                       headers=people["admin"]["h"]).status_code == 400
    withdrawn = call(client, "post", f"/refund-cases/{third['refund_case_id']}/withdraw", people["bm"]["h"], json={})
    assert withdrawn["status"] == "Withdrawn"
    assert client.get(f"{API}/refund-cases", headers=people["sravani"]["h"]).status_code == 403
