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

CSV = """full_name,mobile,email,course,branch,source,notes
Lokesh Babu,9000031001,lokesh.b@example.test,Data Science,NIT-GNT,Website,ignored
Ananya Again,98765 43210,ananya.new@example.test,NIT-CRS-018,Guntur,Google Ads,
Ananya Rao,98765 43210,ananya.rao@example.test,,NIT-GNT,Website,
Test Row,12345,invalid-email,Unknown Course,NIT-GNT,Website,
Mahesh T,9000031005,mahesh@example.test,Data Science,Hyderabad,Referral,
Pavani Sri,9000031002,pavani@example.test,Data Science,NIT-VIJ,Meta Ads,
Only Name,,,,,,
Lokesh Again,9000031001,lokesh.b@example.test,,NIT-GNT,Website,
Lokesh Twice,9000031001,lokesh.b@example.test,Data Science,NIT-GNT,Website,
"""


def _upload_csv(client, headers, text=CSV, name="leads.csv"):
    return client.post(f"{API}/lead-imports", headers=headers, data={"file": (io.BytesIO(text.encode()), name)},
                       content_type="multipart/form-data")


def test_csv_import_validates_then_merges(client, people, course, app):
    from pathlib import Path

    from models import Person

    ananya = create_lead(client, people["sravani"]["h"], course_id=course)  # Ananya, +919876543210, no CSV match by course
    ananya_person = db.session.get(Person, ananya["person"]["person_id"])
    ananya_person.email = None  # an empty field the import may fill
    db.session.flush()
    headers = people["sravani"]["h"]

    upload = _upload_csv(client, headers)
    assert upload.status_code == 201, upload.get_json()
    batch = upload.get_json()["data"]
    assert batch["import_code"] == "IMP-00001" and batch["status"] == "Validated"
    rows = {row["row_no"]: row for row in batch["rows"]}
    assert rows[1]["result"] == "Ready"
    assert rows[2]["result"] == "Invalid" and "already has the open lead" in rows[2]["issues"][0]  # same person, same course
    assert rows[3]["result"] == "Duplicate Review" and rows[3]["matched_person_id"] == ananya_person.person_id
    assert rows[4]["issues"] == ["mobile: not a valid phone number (10 digits, optional +91)",
                                 "email: not a valid email address", "course: not in Course Master"]
    assert rows[5]["issues"] == ["branch: not found"]
    assert rows[6]["issues"][0] == "branch: outside your branch scope"
    assert rows[7]["issues"] == ["mobile: required", "email: required", "branch: required", "source: required"]
    assert rows[8]["result"] == "Duplicate Review" and rows[8]["matched_person_id"] is None  # same person as row 1
    assert rows[9]["result"] == "Invalid" and "same mobile, course and branch as row 1" in rows[9]["issues"][0]
    assert (batch["ready_rows"], batch["duplicate_rows"], batch["invalid_rows"]) == (1, 2, 6)

    # sample records + per-column checks
    preview = batch["preview"]
    assert [r["row_no"] for r in preview["sample_rows"]] == [1, 2, 3, 4, 5] and preview["ignored_columns"] == ["notes"]
    columns = {c["column"]: c for c in preview["columns"]}
    assert columns["email"]["required"] and columns["email"]["filled"] == 8 and columns["email"]["invalid"] == 2
    assert not columns["course"]["required"] and columns["mobile"]["invalid"] == 2

    # the original file was kept (no bucket in tests -> local disk)
    assert batch["storage_path"] == "lead-imports/IMP-00001/leads.csv"
    assert (Path(app.config["UPLOAD_DIR"]) / batch["storage_path"]).read_text().startswith("full_name,mobile")

    assert client.get(f"{API}/lead-imports/{batch['import_id']}", headers=people["mounika"]["h"]).status_code == 404
    assert client.get(f"{API}/lead-imports/{batch['import_id']}", headers=people["bm"]["h"]).status_code == 200

    persons_before = db.session.execute(select(db.func.count()).select_from(Person)).scalar()
    imported = client.post(f"{API}/lead-imports/{batch['import_id']}/import", headers=headers).get_json()["data"]
    assert imported["status"] == "Imported" and (imported["imported_rows"], imported["merged_rows"]) == (3, 2)
    done = {row["row_no"]: row for row in imported["rows"]}
    lokesh = db.session.get(Lead, done[1]["lead_id"])
    assert lokesh.entry_method.code == "CSV_IMPORT" and lokesh.intake_status == "New" and lokesh.last_contacted_at is None

    # row 3 merged into Ananya: same person, a second lead, her empty email filled from the row
    merged = db.session.get(Lead, done[3]["lead_id"])
    assert done[3]["merged"] and merged.person_id == ananya_person.person_id and merged.intake_status == "New"
    assert merged.lead_id != ananya["lead_id"] and ananya_person.email == "ananya.rao@example.test"
    # row 8: merged into the person row 1 created, email already there
    assert done[8]["merged"] and db.session.get(Lead, done[8]["lead_id"]).person_id == lokesh.person_id
    # only Lokesh is a new person
    assert db.session.execute(select(db.func.count()).select_from(Person)).scalar() == persons_before + 1
    assert done[4]["lead_id"] is None and done[9]["result"] == "Invalid"
    assert client.post(f"{API}/lead-imports/{batch['import_id']}/import", headers=headers).status_code == 422


def test_csv_import_merge_fills_empty_email_only(client, people, course):
    from models import Person

    lead = create_lead(client, people["sravani"]["h"], course_id=course, person={"full_name": "Ananya Rao", "phone": "98765 43210", "email": "old@example.test"})
    person = db.session.get(Person, lead["person"]["person_id"])
    text = "full_name,mobile,email,branch,source\nAnanya R,9876543210,new@example.test,NIT-GNT,Website\n"
    batch = _upload_csv(client, people["sravani"]["h"], text).get_json()["data"]
    assert batch["rows"][0]["result"] == "Duplicate Review"
    client.post(f"{API}/lead-imports/{batch['import_id']}/import", headers=people["sravani"]["h"])
    assert person.email == "old@example.test" and person.full_name == "Ananya Rao"  # nothing overwritten


def test_csv_import_json_body_and_missing_columns(client, people):
    headers = people["bm"]["h"]
    bad = client.post(f"{API}/lead-imports", headers=headers, json={"content": "name,phone\nA,1\n"})
    assert bad.status_code == 400 and "Missing column: full_name" in bad.get_json()["error"]["details"]["content"]
    partial = client.post(f"{API}/lead-imports", headers=headers, json={"content": "full_name,mobile\nA,9000000123\n"})
    assert partial.status_code == 400
    assert set(partial.get_json()["error"]["details"]["content"]) == {"Missing column: email", "Missing column: branch", "Missing column: source"}
    ok = client.post(f"{API}/lead-imports", headers=headers,
                     json={"file_name": "x.csv", "content": "full_name,mobile,email,source,branch\nRavi,9000000123,ravi@example.test,Walk-in,NIT-GNT\n"})
    assert ok.status_code == 201 and ok.get_json()["data"]["rows"][0]["result"] == "Ready"
    assert client.post(f"{API}/lead-imports", headers=headers, json={"file_name": "x.xlsx", "content": "x"}).status_code == 400
    assert client.post(f"{API}/lead-imports", headers=people["accounts"]["h"], json={"content": "x"}).status_code == 403
    assert db.session.execute(select(LeadActivity)).first() is None


class _FakeS3:
    def __init__(self, fail=False):
        self.puts, self.fail = [], fail

    def put_object(self, **kwargs):
        if self.fail:
            raise RuntimeError("AccessDenied")
        self.puts.append(kwargs)


def test_csv_import_is_kept_in_s3(client, people, app, monkeypatch):
    from services import storage

    fake = _FakeS3()
    monkeypatch.setattr(storage, "_s3_client", lambda: fake)
    monkeypatch.setitem(app.config, "S3_IMPORT_BUCKET", "crm-test-bucket")
    text = "full_name,mobile,email,branch,source\nRavi,9000000123,ravi@example.test,NIT-GNT,Website\n"
    batch = _upload_csv(client, people["bm"]["h"], text, "my leads (1).csv").get_json()["data"]
    assert batch["storage_path"] == "s3://crm-test-bucket/lead-imports/IMP-00001/my_leads__1_.csv"
    assert fake.puts[0]["Bucket"] == "crm-test-bucket" and fake.puts[0]["Body"] == text.encode()
    assert fake.puts[0]["ServerSideEncryption"] == "AES256"


def test_csv_import_rejected_when_s3_fails(client, people, app, monkeypatch):
    from models import LeadImport
    from services import storage

    monkeypatch.setattr(storage, "_s3_client", lambda: _FakeS3(fail=True))
    monkeypatch.setitem(app.config, "S3_IMPORT_BUCKET", "crm-test-bucket")
    text = "full_name,mobile,email,branch,source\nRavi,9000000123,ravi@example.test,NIT-GNT,Website\n"
    response = _upload_csv(client, people["bm"]["h"], text)
    assert response.status_code == 503 and response.get_json()["error"]["code"] == "STORAGE_UNAVAILABLE"
    assert db.session.execute(select(LeadImport)).first() is None  # nothing saved without the stored file
