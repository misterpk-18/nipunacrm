"""Step 4: persons, enquiries, leads, activities."""
from sqlalchemy import select

from config.database import db
from models import LeadActivity, LostReason, Task
from tests.helpers import API, create_lead, future, lead_body, lookup_id


# ---------------------------------------------------------------- access

def test_only_lead_roles_reach_leads(client, people):
    assert client.get(f"{API}/leads", headers=people["accounts"]["h"]).status_code == 403
    assert client.get(f"{API}/leads", headers=people["sravani"]["h"]).status_code == 200


# ---------------------------------------------------------------- persons

def test_person_phone_is_normalised_and_searchable(client, people):
    headers = people["sravani"]["h"]
    created = client.post(f"{API}/persons", headers=headers, json={
        "full_name": "Ananya Rao", "phone": "098765-43210", "registered_branch_id": 1}).get_json()["data"]

    assert created["phone"] == "+919876543210"
    assert created["person_code"] == "PER-GNT-00001"
    for query in ("phone=9876543210", "phone=%2B91%2098765%2043210", "name=anany"):
        results = client.get(f"{API}/persons/search?{query}", headers=headers).get_json()["data"]
        assert [p["person_id"] for p in results] == [created["person_id"]], query
    assert client.get(f"{API}/persons/search", headers=headers).status_code == 400
    assert client.post(f"{API}/persons", headers=headers, json={
        "full_name": "X", "phone": "12345", "registered_branch_id": 1}).status_code == 400


def test_persons_are_scoped_to_branches(client, people):
    guntur_person = client.post(f"{API}/persons", headers=people["sravani"]["h"], json={
        "full_name": "Ravi", "phone": "9000000001", "registered_branch_id": 1}).get_json()["data"]

    assert client.get(f"{API}/persons/{guntur_person['person_id']}", headers=people["mounika"]["h"]).status_code == 404
    assert client.post(f"{API}/persons", headers=people["mounika"]["h"], json={
        "full_name": "X", "phone": "9000000002", "registered_branch_id": 1}).status_code == 403
    # Search still finds people across branches, so a second-branch enquiry isn't duplicated blindly
    found = client.get(f"{API}/persons/search?phone=9000000001", headers=people["mounika"]["h"]).get_json()["data"]
    assert len(found) == 1


# ---------------------------------------------------------------- create lead

def test_counsellor_creates_lead_and_owns_it(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course)

    assert lead["lead_code"] == "LD-00001"
    assert lead["stage"] == "New Enquiry"
    assert lead["owner"]["full_name"] == "Sravani"
    assert lead["original_source"] == "Google Ads"
    assert lead["person"]["phone"] == "+919876543210" and lead["person"]["email"] == "ananya@example.test"

    enquiries = client.get(f"{API}/leads/{lead['lead_id']}/enquiries", headers=people["sravani"]["h"]).get_json()["data"]
    assert [e["enquiry_code"] for e in enquiries] == ["ENQ-00001"]
    assert enquiries[0]["lead_code"] == "LD-00001"


def test_unassigned_lead_creates_task_that_assignment_completes(client, people):
    lead = create_lead(client, people["bm"]["h"])
    assert lead["owner"] is None

    task = db.session.execute(select(Task).where(Task.lead_id == lead["lead_id"])).scalar_one()
    assert task.title.startswith("Assign new lead LD-") and task.team_role.role_code == "BRANCH_MANAGER"

    assigned = client.post(f"{API}/leads/{lead['lead_id']}/assign", json={"assigned_to": people["sravani"]["id"]},
                           headers=people["bm"]["h"])
    assert assigned.get_json()["data"]["owner"]["full_name"] == "Sravani"
    db.session.refresh(task)
    assert task.status == "Completed"

    timeline = client.get(f"{API}/leads/{lead['lead_id']}/activities", headers=people["bm"]["h"]).get_json()["data"]
    assert timeline[0]["activity_type"] == "Assignment Change"
    assert timeline[0]["summary"] == "Assigned to Sravani (was unassigned)"


def test_duplicate_open_lead_is_rejected_with_its_code(client, people, course):
    first = create_lead(client, people["sravani"]["h"], course_id=course)

    again = client.post(f"{API}/leads", headers=people["sravani"]["h"],
                        json=lead_body(person_id=first["person"]["person_id"], person=None, course_id=course))

    assert again.status_code == 409
    assert first["lead_code"] in again.get_json()["error"]["message"]


def test_course_must_be_offered_at_the_branch(client, people, course):
    response = client.post(f"{API}/leads", headers=people["admin"]["h"], json=lead_body(branch_id=2, course_id=course))

    assert response.status_code == 400
    assert response.get_json()["error"]["details"] == {"course_id": ["Not offered at this branch"]}


def test_assignee_must_work_at_the_branch(client, people):
    response = client.post(f"{API}/leads", headers=people["bm"]["h"], json=lead_body(assigned_to=people["mounika"]["id"]))

    assert response.status_code == 400


# ---------------------------------------------------------------- enquiries

def test_enquiry_with_known_phone_goes_to_duplicate_review(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    headers = people["nikhil"]["h"]
    base = {k: v for k, v in lead_body().items() if k != "person"}

    duplicate = client.post(f"{API}/enquiries", headers=headers, json={**base, "raw_phone": "9876543210",
                                                                       "message": "Weekend batch?"}).get_json()["data"]
    fresh = client.post(f"{API}/enquiries", headers=headers, json={**base, "raw_phone": "9123456789",
                                                                   "raw_name": "Vamsi"}).get_json()["data"]

    assert duplicate["enquiry"]["intake_status"] == "Duplicate Review"
    assert [lead_["lead_code"] for lead_ in duplicate["matches"]["open_leads"]] == [lead["lead_code"]]
    assert fresh["enquiry"]["intake_status"] == "New" and fresh["matches"] == {"persons": [], "open_leads": []}

    review = client.get(f"{API}/enquiries?intake_status=Duplicate Review", headers=headers).get_json()["data"]
    assert [e["enquiry_id"] for e in review] == [duplicate["enquiry"]["enquiry_id"]]

    # Staff decide: it's a repeat enquiry for the existing lead
    linked = client.post(f"{API}/enquiries/{duplicate['enquiry']['enquiry_id']}/link",
                         json={"lead_id": lead["lead_id"]}, headers=headers)
    assert linked.get_json()["data"]["intake_status"] == "New"
    assert len(client.get(f"{API}/leads/{lead['lead_id']}/enquiries", headers=headers).get_json()["data"]) == 2
    note = client.get(f"{API}/leads/{lead['lead_id']}/activities", headers=headers).get_json()["data"][0]
    assert note["summary"].startswith("Repeat enquiry ENQ-") and note["summary"].endswith("Weekend batch?")


def test_convert_enquiry_into_lead(client, people):
    base = {k: v for k, v in lead_body().items() if k != "person"}
    enquiry = client.post(f"{API}/enquiries", headers=people["sravani"]["h"], json={
        **base, "raw_name": "Vamsi Krishna", "raw_phone": "9123456789"}).get_json()["data"]["enquiry"]

    converted = client.post(f"{API}/enquiries/{enquiry['enquiry_id']}/convert", json={}, headers=people["sravani"]["h"])
    again = client.post(f"{API}/enquiries/{enquiry['enquiry_id']}/convert", json={}, headers=people["sravani"]["h"])

    assert converted.status_code == 201
    lead = converted.get_json()["data"]
    assert lead["name"] == "Vamsi Krishna" and lead["original_source"] == "Google Ads"
    assert lead["original_enquiry_id"] == enquiry["enquiry_id"]
    assert again.status_code == 422


# ---------------------------------------------------------------- list / workspace

def test_list_filters_scope_and_queues(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    ananya = create_lead(client, sravani, course_id=course)
    vamsi = create_lead(client, people["bm"]["h"], person={"full_name": "Vamsi", "phone": "9123456789"})
    create_lead(client, people["mounika"]["h"], branch_id=2, person={"full_name": "Karthik", "phone": "9111111111"})
    run_sql("UPDATE leads SET next_follow_up_at = now() - interval '1 day' WHERE lead_id = :id", id=ananya["lead_id"])
    run_sql("UPDATE leads SET ai_priority = 'Hot', ai_score = 92 WHERE lead_id = :id", id=vamsi["lead_id"])

    def codes(query, headers=sravani):
        return [row["lead_code"] for row in client.get(f"{API}/leads?{query}", headers=headers).get_json()["data"]]

    assert codes("") == [vamsi["lead_code"], ananya["lead_code"]]          # own branch only, newest first
    assert len(codes("", people["admin"]["h"])) == 3                          # company-wide
    assert codes("assigned_to=me") == [ananya["lead_code"]]
    assert codes("assigned_to=unassigned") == [vamsi["lead_code"]]
    assert codes("queue=overdue") == [ananya["lead_code"]]
    assert codes("queue=hot") == [vamsi["lead_code"]]
    assert codes("queue=untouched") == [vamsi["lead_code"], ananya["lead_code"]]
    assert codes("q=ananya") == codes("q=98765") == codes(f"q={ananya['lead_code']}") == [ananya["lead_code"]]
    assert client.get(f"{API}/leads?queue=nope", headers=sravani).status_code == 400

    page = client.get(f"{API}/leads?per_page=1", headers=sravani).get_json()
    assert page["meta"]["total"] == 2 and len(page["data"]) == 1


def test_workspace_puts_overdue_first_and_counts_queues(client, people, run_sql):
    headers = people["sravani"]["h"]
    later = create_lead(client, headers, person={"full_name": "Later", "phone": "9000000011"}, next_follow_up_at=future(48))
    overdue = create_lead(client, headers, person={"full_name": "Overdue", "phone": "9000000012"})
    run_sql("UPDATE leads SET next_follow_up_at = now() - interval '2 hours' WHERE lead_id = :id", id=overdue["lead_id"])

    body = client.get(f"{API}/leads/workspace", headers=headers).get_json()

    assert [row["lead_code"] for row in body["data"]["leads"]] == [overdue["lead_code"], later["lead_code"]]
    assert body["data"]["counts"]["overdue"] == 1
    assert body["data"]["counts"]["new"] == 2


# ---------------------------------------------------------------- stage / follow-up / lost

def test_stage_changes_are_logged_and_guarded(client, people, course):
    owner = people["sravani"]
    lead = create_lead(client, owner["h"])
    url = f"{API}/leads/{lead['lead_id']}/stage"

    moved = client.post(url, json={"stage": "Counselling", "note": "Discussed outcomes"}, headers=owner["h"])
    assert moved.get_json()["data"]["stage"] == "Counselling"
    change = db.session.execute(select(LeadActivity).where(LeadActivity.activity_type == "Stage Change")).scalar_one()
    assert (change.from_stage, change.to_stage, change.performed_by) == ("New Enquiry", "Counselling", owner["id"])

    missing_course = client.post(url, json={"stage": "Payment Pending Verification"}, headers=owner["h"])
    assert missing_course.status_code == 422
    assert missing_course.get_json()["error"]["details"] == {"missing_fields": ["course_id"]}

    client.patch(f"{API}/leads/{lead['lead_id']}", json={"course_id": course}, headers=owner["h"])
    assert client.post(url, json={"stage": "Payment Pending Verification"}, headers=owner["h"]).status_code == 200
    backwards = client.post(url, json={"stage": "Counselling"}, headers=owner["h"])
    assert backwards.status_code == 422 and "cannot move back" in backwards.get_json()["error"]["message"]

    assert client.post(url, json={"stage": "Admitted"}, headers=owner["h"]).status_code == 422
    assert client.post(url, json={"stage": "Demo Scheduled"}, headers=people["nikhil"]["h"]).status_code == 403


def test_follow_up_lost_and_reactivate(client, people):
    owner = people["sravani"]["h"]
    lead = create_lead(client, owner)
    base = f"{API}/leads/{lead['lead_id']}"

    assert client.post(f"{base}/follow-up", json={"next_follow_up_at": "2020-01-01T10:00:00+05:30"}, headers=owner).status_code == 400
    scheduled = client.post(f"{base}/follow-up", json={"next_follow_up_at": future(), "note": "Call after exams"}, headers=owner)
    assert scheduled.get_json()["data"]["next_follow_up_at"] is not None

    assert client.post(f"{base}/lost", json={}, headers=owner).status_code == 400
    lost = client.post(f"{base}/lost", headers=owner, json={
        "lost_reason_id": lookup_id(LostReason, "FEE_TOO_HIGH"), "lost_competitor": "Other Institute",
        "reactivation_date": "2099-01-15"}).get_json()["data"]
    assert lost["stage"] == "Lost - closed"
    assert lost["lost"] == {"reason": "Fee too high", "competitor": "Other Institute", "notes": None,
                            "reactivation_date": "2099-01-15"}
    assert lost["next_follow_up_at"] is None
    assert client.post(f"{base}/follow-up", json={"next_follow_up_at": future()}, headers=owner).status_code == 422

    assert client.post(f"{base}/reactivate", json={}, headers=owner).status_code == 403
    reactivated = client.post(f"{base}/reactivate", json={"stage": "Counselling"}, headers=people["bm"]["h"]).get_json()["data"]
    assert reactivated["stage"] == "Counselling" and reactivated["lost"] is None


# ---------------------------------------------------------------- activities

def test_logging_contact_updates_last_contacted(client, people):
    lead = create_lead(client, people["sravani"]["h"])
    url = f"{API}/leads/{lead['lead_id']}/activities"
    headers = people["nikhil"]["h"]  # front office can log contact on branch leads

    call = client.post(url, headers=headers, json={"activity_type": "Call", "direction": "Outbound", "outcome": "Answered",
                                                   "summary": "Discussed course outcomes", "call_duration_seconds": 384})
    assert call.status_code == 201
    assert call.get_json()["data"]["performed_by"]["full_name"] == "Nikhil"
    assert client.get(f"{API}/leads/{lead['lead_id']}", headers=headers).get_json()["data"]["last_contacted_at"] is not None

    assert client.post(url, json={"activity_type": "Stage Change"}, headers=headers).status_code == 400
    assert client.post(url, json={"activity_type": "Note", "occurred_at": future()}, headers=headers).status_code == 400
    assert client.get(url, headers=people["mounika"]["h"]).status_code == 404  # other branch


def test_bulk_assign_is_all_or_nothing(client, people):
    guntur = [create_lead(client, people["bm"]["h"], person={"full_name": f"P{i}", "phone": f"900000010{i}"}) for i in range(2)]
    vijayawada = create_lead(client, people["mounika"]["h"], branch_id=2, person={"full_name": "V", "phone": "9000000200"})
    url = f"{API}/leads/bulk-assign"

    mixed = client.post(url, headers=people["bm"]["h"], json={
        "lead_ids": [guntur[0]["lead_id"], vijayawada["lead_id"]], "assigned_to": people["sravani"]["id"]})
    assert mixed.status_code == 404
    assert client.get(f"{API}/leads/{guntur[0]['lead_id']}", headers=people["bm"]["h"]).get_json()["data"]["owner"] is None

    done = client.post(url, headers=people["bm"]["h"], json={
        "lead_ids": [lead["lead_id"] for lead in guntur], "assigned_to": people["sravani"]["id"]})
    assert [row["owner"]["full_name"] for row in done.get_json()["data"]] == ["Sravani", "Sravani"]
    assert client.post(url, headers=people["sravani"]["h"], json={
        "lead_ids": [guntur[0]["lead_id"]], "assigned_to": people["nikhil"]["id"]}).status_code == 403
