"""Step 4b: campaign / remarks / WhatsApp, Add Another Course, follow-up log, saved views, CSV import."""
import io

from sqlalchemy import select

from config.database import db
from models import Lead, LeadActivity, Task
from tests.helpers import API, convert_lead, create_lead, future, lead_body


def test_campaign_remarks_and_whatsapp(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course, campaign="Diwali referral drive",
                       remarks="Prefers weekend batch",
                       person={"full_name": "Ananya Rao", "phone": "9876543210", "whatsapp_number": ""})
    assert lead["campaign"] == "Diwali referral drive" and lead["remarks"] == "Prefers weekend batch"
    assert lead["person"]["whatsapp_number"] == "+919876543210"  # empty = same as mobile

    person_id = lead["person"]["person_id"]
    updated = client.patch(f"{API}/persons/{person_id}", json={"whatsapp_number": "9123456780"},
                           headers=people["sravani"]["h"]).get_json()["data"]
    assert updated["whatsapp_number"] == "+919123456780"
    patched = client.patch(f"{API}/leads/{lead['lead_id']}", json={"remarks": "Call after 6pm"},
                           headers=people["sravani"]["h"]).get_json()["data"]
    assert patched["remarks"] == "Call after 6pm"


def test_add_another_course_for_same_person(client, people, course):
    first = create_lead(client, people["sravani"]["h"], course_id=course)
    second = create_lead(client, people["sravani"]["h"], person_id=first["person"]["person_id"], person=None)

    assert second["person"]["person_id"] == first["person"]["person_id"]
    assert second["lead_id"] != first["lead_id"]
    # Vijayawada counsellor can't open one at Guntur
    other = client.post(f"{API}/leads", headers=people["mounika"]["h"],
                        json=lead_body(person_id=first["person"]["person_id"], person=None))
    assert other.status_code == 403


def test_intake_status_invalid_spam_and_test_are_settable(client, people):
    lead = create_lead(client, people["sravani"]["h"], intake_status="Test")
    assert lead["intake_status"] == "Test"
    patched = client.patch(f"{API}/leads/{lead['lead_id']}", json={"intake_status": "Invalid-Spam"},
                           headers=people["sravani"]["h"])
    assert patched.get_json()["data"]["intake_status"] == "Invalid-Spam"


def test_follow_up_log_writes_call_moves_follow_up_and_keeps_original_deadline(client, people):
    first_due = future(2)
    lead = create_lead(client, people["sravani"]["h"], next_follow_up_at=first_due)
    url = f"{API}/leads/{lead['lead_id']}/follow-up-log"
    body = {"purpose": "Fee follow-up", "response": "Call back later", "notes": "Parents deciding", "next_follow_up_at": future(26)}

    assert client.post(url, json={**body, "next_follow_up_at": None}, headers=people["sravani"]["h"]).status_code == 400
    assert client.post(url, json={**body, "purpose": "Chit-chat"}, headers=people["sravani"]["h"]).status_code == 400
    logged = client.post(url, json=body, headers=people["nikhil"]["h"])  # front office may log
    assert logged.status_code == 201, logged.get_json()
    data = logged.get_json()["data"]

    assert data["activity"]["activity_type"] == "Call"
    assert data["activity"]["purpose"] == "Fee follow-up" and data["activity"]["outcome"] == "Call back later"
    assert data["lead"]["next_follow_up_at"] != lead["next_follow_up_at"]
    task = db.session.get(Task, data["task"]["task_id"])
    assert task.task_type.code == "CALL" and task.lead_id == lead["lead_id"]
    assert task.original_due_at.isoformat()[:16] == first_due[:16] or task.original_due_at < task.revised_due_at
    assert task.revised_due_at is not None and task.revision_reason
    assert client.post(url, json=body, headers=people["mounika"]["h"]).status_code == 404


def test_follow_up_log_blocked_for_others_and_closed_leads(client, people, make_user, login):
    lead = create_lead(client, people["sravani"]["h"])
    other_sales = login(make_user(roles=[("SALES", 1)]).email)
    body = {"purpose": "Counselling call", "response": "Interested", "next_follow_up_at": future()}
    url = f"{API}/leads/{lead['lead_id']}/follow-up-log"

    assert client.post(url, json=body, headers=other_sales).status_code == 403
    convert_lead(client, people["bm"]["h"], lead["lead_id"])  # into the pipeline (Counselling)
    assert client.post(url, json=body, headers=people["bm"]["h"]).status_code == 201


# ---------------------------------------------------------------- saved views

def test_saved_views_shared_and_own(client, people):
    headers = people["sravani"]["h"]
    shared = client.get(f"{API}/saved-views?module=leads", headers=headers).get_json()["data"]
    assert {v["name"] for v in shared} >= {"All open", "Duplicate Review queue"}
    assert all(v["shared"] for v in shared)

    mine = client.post(f"{API}/saved-views", headers=headers,
                       json={"name": "My hot ones", "filters": {"queue": "hot", "assigned_to": "me"}})
    assert mine.status_code == 201
    assert client.post(f"{API}/saved-views", headers=headers,
                       json={"name": "Shared", "filters": {}, "shared": True}).status_code == 403
    assert client.post(f"{API}/saved-views", headers=headers,
                       json={"name": "Bad", "filters": {"stage": "Nope"}}).status_code == 400

    view_id = mine.get_json()["data"]["saved_view_id"]
    assert view_id in [v["saved_view_id"] for v in client.get(f"{API}/saved-views", headers=headers).get_json()["data"]]
    assert view_id not in [v["saved_view_id"] for v in client.get(f"{API}/saved-views", headers=people["nikhil"]["h"]).get_json()["data"]]
    assert client.delete(f"{API}/saved-views/{view_id}", headers=people["nikhil"]["h"]).status_code == 404
    assert client.delete(f"{API}/saved-views/{view_id}", headers=headers).status_code == 204
    assert client.delete(f"{API}/saved-views/{shared[0]['saved_view_id']}", headers=headers).status_code == 403


# ---------------------------------------------------------------- CSV import

CSV = """full_name,mobile,email,course,branch,source
Lokesh Babu,9000031001,lokesh.b@example.test,Data Science,NIT-GNT,Website
Ananya Again,98765 43210,,NIT-CRS-018,Guntur,Google Ads
Test Row,12345,invalid-email,Unknown Course,NIT-GNT,Website
Mahesh T,9000031005,,Data Science,Hyderabad,Referral
Pavani Sri,9000031002,,Data Science,NIT-VIJ,Meta Ads
"""


def test_csv_import_validates_then_imports(client, people, course):
    create_lead(client, people["sravani"]["h"], course_id=course)  # Ananya, +919876543210
    headers = people["sravani"]["h"]

    upload = client.post(f"{API}/lead-imports", headers=headers, data={"file": (io.BytesIO(CSV.encode()), "leads.csv")},
                         content_type="multipart/form-data")
    assert upload.status_code == 201, upload.get_json()
    batch = upload.get_json()["data"]
    assert batch["import_code"] == "IMP-00001" and batch["status"] == "Validated"
    results = {row["full_name"]: row for row in batch["rows"]}
    assert results["Lokesh Babu"]["result"] == "Ready"
    assert results["Ananya Again"]["result"] == "Duplicate Review" and results["Ananya Again"]["matched_lead_id"]
    assert set(results["Test Row"]["issues"]) >= {"Mobile number is not valid", "Invalid email", "Course not in Course Master"}
    assert results["Mahesh T"]["issues"] == ["Branch not found"]
    assert "Outside your branch scope" in results["Pavani Sri"]["issues"]
    assert (batch["ready_rows"], batch["duplicate_rows"], batch["invalid_rows"]) == (1, 1, 3)

    assert client.get(f"{API}/lead-imports/{batch['import_id']}", headers=people["mounika"]["h"]).status_code == 404
    assert client.get(f"{API}/lead-imports/{batch['import_id']}", headers=people["bm"]["h"]).status_code == 200

    imported = client.post(f"{API}/lead-imports/{batch['import_id']}/import", headers=headers).get_json()["data"]
    assert imported["status"] == "Imported"
    rows = {row["full_name"]: row for row in imported["rows"]}
    lokesh = db.session.get(Lead, rows["Lokesh Babu"]["lead_id"])
    dup = db.session.get(Lead, rows["Ananya Again"]["lead_id"])
    assert lokesh.entry_method.code == "CSV_IMPORT" and lokesh.intake_status == "New" and lokesh.last_contacted_at is None
    matched = db.session.get(Lead, results["Ananya Again"]["matched_lead_id"])
    assert dup.intake_status == "Duplicate Review" and dup.person_id != matched.person_id  # never auto-merged
    assert rows["Test Row"]["lead_id"] is None
    assert client.post(f"{API}/lead-imports/{batch['import_id']}/import", headers=headers).status_code == 422


def test_csv_import_json_body_and_missing_columns(client, people):
    headers = people["bm"]["h"]
    bad = client.post(f"{API}/lead-imports", headers=headers, json={"content": "name,phone\nA,1\n"})
    assert bad.status_code == 400 and "Missing column: full_name" in bad.get_json()["error"]["details"]["content"]
    ok = client.post(f"{API}/lead-imports", headers=headers,
                     json={"file_name": "x.csv", "content": "full_name,mobile,source,branch\nRavi,9000000123,Walk-in,NIT-GNT\n"})
    assert ok.status_code == 201 and ok.get_json()["data"]["rows"][0]["result"] == "Ready"
    assert client.post(f"{API}/lead-imports", headers=people["accounts"]["h"], json={"content": "x"}).status_code == 403
    assert db.session.execute(select(LeadActivity)).first() is None
