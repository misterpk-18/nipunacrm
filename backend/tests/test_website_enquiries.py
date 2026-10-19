"""db 047: the nipunatechnologies.com enquiry form (server-to-server) and staff triage of its enquiries."""
from sqlalchemy import select

from config.database import db
from models import AuditLog, Notification, Person
from tests.helpers import API, create_lead

URL = f"{API}/integrations/website/enquiries"
KEY = {"X-Service-Key": "test-website-key"}


def form(**overrides):
    body = {"submission_id": "web-0001", "name": "Ravi Kumar", "phone": "98765 43210", "email": "Ravi@Example.test",
            "branch_code": "nit-gnt", "enquiry_type": "form", "message": "Weekend batch?", "whatsapp_consent": True,
            "utm": {"source": "google", "medium": "cpc", "campaign": ""}, "page_url": "https://nipunatechnologies.com/ds"}
    return {**body, **overrides}


def post(client, **overrides):
    return client.post(URL, headers=KEY, json=form(**overrides))


def enquiry(client, headers, code):
    rows = client.get(f"{API}/enquiries?q={code}", headers=headers).get_json()["data"]
    assert len(rows) == 1
    return rows[0]


# ---------------------------------------------------------------- the website call

def test_key_is_required(client, people):
    assert client.post(URL, json=form()).status_code == 401
    assert client.post(URL, headers={"X-Service-Key": "wrong"}, json=form()).status_code == 401
    assert client.post(URL, headers=people["admin"]["h"], json=form()).status_code == 401  # a staff login is not a key


def test_submission_lands_in_enquiries_as_website(client, people, course):
    response = post(client, course_code="nit-crs-018")
    assert response.status_code == 201
    body = response.get_json()["data"]
    assert body["status"] == "received" and body["enquiry_code"].startswith("ENQ-")
    assert set(body) == {"enquiry_code", "status"}  # never says whether the person is known

    row = enquiry(client, people["bm"]["h"], body["enquiry_code"])
    assert (row["source"], row["channel"], row["entry_method"]) == ("Website", "Web form", "Website")
    assert row["intake_status"] == "New" and row["lead_id"] is None and row["owner"] is None
    assert row["branch"]["branch_code"] == "NIT-GNT" and row["course"]["course_code"] == "NIT-CRS-018"
    assert (row["raw_phone"], row["raw_email"]) == ("+919876543210", "ravi@example.test")
    assert row["attribution"] == {"source": "google", "medium": "cpc", "page_url": "https://nipunatechnologies.com/ds",
                                  "enquiry_type": "form", "marketing_source": "organic"}
    assert row["whatsapp_consent"] is True
    # not visible at the other branch
    assert client.get(f"{API}/enquiries?q={body['enquiry_code']}", headers=people["mounika"]["h"]).get_json()["data"] == []

    audit = db.session.execute(select(AuditLog).where(AuditLog.action == "ENQUIRY_CREATED")).scalars().one()
    assert audit.actor_user_id is None and audit.new_values["via"] == "website"


def test_branch_manager_founder_and_admin_are_notified(client, people):
    code = post(client).get_json()["data"]["enquiry_code"]
    notified = db.session.execute(select(Notification.recipient_user_id).where(
        Notification.entity_type == "enquiry")).scalars().all()
    assert sorted(notified) == sorted([people["bm"]["id"], people["founder"]["id"], people["admin"]["id"]])
    title = db.session.execute(select(Notification.title)).scalars().first()
    assert title == "Website enquiry: Ravi Kumar · course not chosen" and code


def test_same_submission_id_returns_the_first_enquiry(client, people):
    first = post(client)
    again = post(client, message="changed")
    assert first.status_code == 201 and again.status_code == 200
    assert again.get_json()["data"] == {"enquiry_code": first.get_json()["data"]["enquiry_code"],
                                        "status": "duplicate_submission"}
    assert len(client.get(f"{API}/enquiries", headers=people["bm"]["h"]).get_json()["data"]) == 1


def test_validation(client):
    response = client.post(URL, headers=KEY, json={"submission_id": "bad id!", "phone": "123", "email": "x",
                                                   "message": "m" * 2001})
    assert response.status_code == 400
    details = response.get_json()["error"]["details"]
    assert set(details) >= {"submission_id", "name", "phone", "email", "branch_code", "enquiry_type", "message"}
    assert "marketing_source" in post(client, marketing_source="tv").get_json()["error"]["details"]
    assert "submitted_at" in post(client, submitted_at="yesterday").get_json()["error"]["details"]
    unknown = post(client, branch_code="NIT-XYZ")
    assert unknown.status_code == 400 and "branch_code" in unknown.get_json()["error"]["details"]


def test_marketing_source_and_enquiry_type_are_kept_apart(client, people):
    bm = people["bm"]["h"]
    cases = [("w-1", "9000000021", "google_ads", "form", "Google Ads", "Web form"),
             ("w-2", "9000000022", "meta_ads", "call_request", "Meta Ads", "Phone call"),
             ("w-3", "9000000023", None, "whatsapp_request", "Website", "WhatsApp")]
    for sid, phone, source, kind, source_label, channel in cases:
        extra = {"marketing_source": source} if source else {}
        code = post(client, submission_id=sid, phone=phone, email=None, enquiry_type=kind, **extra).get_json()["data"]["enquiry_code"]
        row = enquiry(client, bm, code)
        assert (row["source"], row["channel"], row["entry_method"]) == (source_label, channel, "Website"), sid
    titles = db.session.execute(select(Notification.title).distinct()).scalars().all()
    assert any(t.startswith("Website call request: ") for t in titles)


def test_submitted_at_is_the_enquiry_time_when_recent(client, people):
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(hours=3)).replace(microsecond=0)
    old = (now - timedelta(hours=72)).replace(microsecond=0)
    bm = people["bm"]["h"]
    a = post(client, submission_id="w-1", phone="9000000031", email=None, submitted_at=recent.isoformat()).get_json()["data"]
    b = post(client, submission_id="w-2", phone="9000000032", email=None, submitted_at=old.isoformat()).get_json()["data"]
    row_a, row_b = enquiry(client, bm, a["enquiry_code"]), enquiry(client, bm, b["enquiry_code"])
    assert datetime.fromisoformat(row_a["received_at"]) == recent
    assert datetime.fromisoformat(row_b["received_at"]) > now - timedelta(minutes=5)     # too old: CRM time
    assert row_b["attribution"]["submitted_at"] == old.isoformat()                         # but kept


def test_unknown_or_unoffered_course_is_kept_in_the_message(client, people, course):
    # Data Science is offered at Guntur only
    vij = post(client, submission_id="w-1", branch_code="NIT-VIJ", course_code="NIT-CRS-018").get_json()["data"]
    odd = post(client, submission_id="w-2", phone="9123456789", course_code="Cyber Security", message=None)
    row = enquiry(client, people["bm_vij"]["h"], vij["enquiry_code"])
    assert row["course"] is None and row["message"] == "Course asked on website: NIT-CRS-018\n\nWeekend batch?"
    assert enquiry(client, people["bm"]["h"], odd.get_json()["data"]["enquiry_code"])["message"] == \
        "Course asked on website: Cyber Security"


def test_known_person_or_recent_repeat_goes_to_duplicate_review(client, people, course, run_sql):
    bm = people["bm"]["h"]
    create_lead(client, people["sravani"]["h"], course_id=course)          # Ananya, 98765 43210
    known = post(client, submission_id="w-1").get_json()["data"]
    first = post(client, submission_id="w-2", phone="9000000011", email=None).get_json()["data"]
    repeat = post(client, submission_id="w-3", phone="9000000011", email=None).get_json()["data"]
    run_sql("UPDATE enquiries SET received_at = now() - interval '25 hours' WHERE enquiry_code = :c",
            c=first["enquiry_code"])
    run_sql("UPDATE enquiries SET received_at = now() - interval '25 hours' WHERE enquiry_code = :c",
            c=repeat["enquiry_code"])
    later = post(client, submission_id="w-4", phone="9000000011", email=None).get_json()["data"]

    assert [enquiry(client, bm, e["enquiry_code"])["intake_status"] for e in (known, first, repeat, later)] == \
        ["Duplicate Review", "New", "Duplicate Review", "New"]               # 24-hour window

    detail = client.get(f"{API}/enquiries/{enquiry(client, bm, repeat['enquiry_code'])['enquiry_id']}",
                        headers=bm).get_json()["data"]
    assert {e["enquiry_code"] for e in detail["matches"]["enquiries"]} == {first["enquiry_code"], later["enquiry_code"]}
    known_detail = client.get(f"{API}/enquiries/{enquiry(client, bm, known['enquiry_code'])['enquiry_id']}",
                              headers=bm).get_json()["data"]
    assert len(known_detail["matches"]["persons"]) == 1 and len(known_detail["matches"]["open_leads"]) == 1


def test_rate_limit_per_phone(client, run_sql):
    run_sql("UPDATE app_settings SET setting_value = '2' WHERE setting_key = 'website_max_per_phone_per_hour'")
    assert post(client, submission_id="w-1").status_code == 201
    assert post(client, submission_id="w-2").status_code == 201
    assert post(client, submission_id="w-3").status_code == 429
    assert post(client, submission_id="w-1").status_code == 200       # a retry is still answered
    assert post(client, submission_id="w-4", phone="9123456789").status_code == 201


# ---------------------------------------------------------------- staff side

def test_convert_records_consent_and_follows_the_lead_rules(client, people):
    code = post(client).get_json()["data"]["enquiry_code"]
    row = enquiry(client, people["sravani"]["h"], code)
    converted = client.post(f"{API}/enquiries/{row['enquiry_id']}/convert", json={}, headers=people["sravani"]["h"])
    assert converted.status_code == 201
    lead = converted.get_json()["data"]
    assert lead["original_source"] == "Website" and lead["original_enquiry_id"] == row["enquiry_id"]
    person = db.session.get(Person, lead["person"]["person_id"])
    db.session.refresh(person)
    assert (person.whatsapp_consent, person.whatsapp_consent_source, person.whatsapp_consent_by) == \
        ("Explicit Consent", "Web form", None)


def test_consent_never_overrides_a_recorded_choice(client, people, run_sql):
    lead = create_lead(client, people["sravani"]["h"])
    run_sql("UPDATE persons SET whatsapp_consent = 'Withdrawn', whatsapp_consent_at = now() WHERE person_id = :p",
            p=lead["person"]["person_id"])
    code = post(client).get_json()["data"]["enquiry_code"]
    row = enquiry(client, people["sravani"]["h"], code)
    assert client.post(f"{API}/enquiries/{row['enquiry_id']}/link", json={"lead_id": lead["lead_id"]},
                       headers=people["sravani"]["h"]).status_code == 200
    person = db.session.get(Person, lead["person"]["person_id"])
    db.session.refresh(person)
    assert person.whatsapp_consent == "Withdrawn"


def test_staff_mark_spam_on_unconverted_enquiries_only(client, people):
    code = post(client).get_json()["data"]["enquiry_code"]
    row = enquiry(client, people["bm"]["h"], code)
    url = f"{API}/enquiries/{row['enquiry_id']}"

    assert client.patch(url, json={}, headers=people["bm"]["h"]).status_code == 400
    assert client.patch(url, json={"intake_status": "Duplicate Review"}, headers=people["bm"]["h"]).status_code == 400
    assert client.patch(url, json={"intake_status": "Invalid-Spam"}, headers=people["mounika"]["h"]).status_code == 404
    assert client.patch(url, json={"intake_status": "Invalid-Spam"}, headers=people["accounts"]["h"]).status_code == 403
    marked = client.patch(url, json={"intake_status": "Invalid-Spam", "is_genuine": False}, headers=people["bm"]["h"])
    assert marked.status_code == 200
    assert (marked.get_json()["data"]["intake_status"], marked.get_json()["data"]["is_genuine"]) == ("Invalid-Spam", False)

    client.patch(url, json={"intake_status": "New"}, headers=people["bm"]["h"])
    client.post(f"{url}/convert", json={}, headers=people["sravani"]["h"])
    assert client.patch(url, json={"intake_status": "Test"}, headers=people["bm"]["h"]).status_code == 422
