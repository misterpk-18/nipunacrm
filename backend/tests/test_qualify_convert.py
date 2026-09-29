"""V4 Phase 2 (db 019): qualification checklist and Convert to deal."""
from datetime import date, timedelta

from models import Admission, LostReason, Payment
from tests.helpers import (
    API, QUALIFICATION_CHECKS, call, convert_lead, create_lead, deal_course, error_of, lookup_id, qualify_lead,
)


def tick(client, headers, lead_id, check, reviewed=True, expected=200):
    return call(client, "put", f"/leads/{lead_id}/qualification/checks", headers, expected,
                json={"check": check, "reviewed": reviewed})


def test_checklist_needs_all_six_and_freezes(client, people):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani)
    url = f"/leads/{lead['lead_id']}"

    checklist = call(client, "get", f"{url}/qualification", sravani)
    assert [c["check"] for c in checklist["checks"]] == list(QUALIFICATION_CHECKS)
    assert checklist["complete"] is False and checklist["can_convert"] is False

    for check in QUALIFICATION_CHECKS[:5]:
        tick(client, sravani, lead["lead_id"], check)
    response = client.post(f"{API}{url}/qualify", headers=sravani)
    assert response.status_code == 422
    assert error_of(response)["details"]["missing_checks"] == ["Possible identity match reviewed"]

    # Unticking works before qualification; the reviewer and time are kept per check
    tick(client, sravani, lead["lead_id"], QUALIFICATION_CHECKS[0], reviewed=False)
    checklist = tick(client, sravani, lead["lead_id"], QUALIFICATION_CHECKS[0])
    first = checklist["checks"][0]
    assert first["reviewed"] and first["reviewed_by"]["full_name"] == "Sravani" and first["reviewed_at"]

    tick(client, sravani, lead["lead_id"], QUALIFICATION_CHECKS[5])
    qualified = call(client, "post", f"{url}/qualify", sravani)
    assert qualified["qualified_at"] and qualified["can_convert"] is True
    assert call(client, "get", url, sravani)["stage"] == "New Enquiry"  # qualifying never changes the stage

    tick(client, sravani, lead["lead_id"], QUALIFICATION_CHECKS[0], reviewed=False, expected=422)
    assert client.post(f"{API}{url}/qualify", headers=sravani).status_code == 422  # already qualified

    # Validation, access
    assert client.put(f"{API}{url}/qualification/checks", json={"check": "Other", "reviewed": True},
                      headers=sravani).status_code == 400
    other = create_lead(client, sravani, person={"full_name": "Second", "phone": "9000000401"})
    assert client.put(f"{API}/leads/{other['lead_id']}/qualification/checks", headers=people["mounika"]["h"],
                      json={"check": QUALIFICATION_CHECKS[0], "reviewed": True}).status_code == 404
    assert client.get(f"{API}{url}/qualification", headers=people["accounts"]["h"]).status_code == 403


def test_unconverted_lead_stays_out_of_the_pipeline(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    base = f"{API}/leads/{lead['lead_id']}"

    for path, body in (("/stage", {"stage": "Counselling"}), ("/demos", {"scheduled_at": "2099-01-01T10:00:00+05:30"}),
                       ("/fee-discussions", {})):
        response = client.post(f"{base}{path}", json=body, headers=sravani)
        assert response.status_code == 422, path
        assert "convert" in error_of(response)["message"]
    response = client.post(f"{base}/convert", json={"course_ids": [course]}, headers=sravani)
    assert response.status_code == 422 and error_of(response)["details"] == {"missing_fields": ["qualified_at"]}

    # Straight to Lost is still allowed, without a card
    lost = call(client, "post", f"/leads/{lead['lead_id']}/lost", sravani, json={"lost_reason_id": lookup_id(LostReason, "FEE_TOO_HIGH")})
    assert lost["stage"] == "Lost - closed" and lost["pipeline_entry_id"] is None


def test_convert_creates_deals_on_one_card(client, people, course):
    sravani = people["sravani"]["h"]
    java = deal_course(1)
    lead = create_lead(client, sravani, course_id=course, next_follow_up_at="2099-01-01T10:00:00+05:30")
    qualify_lead(client, sravani, lead["lead_id"])
    url = f"{API}/leads/{lead['lead_id']}/convert"
    close = (date.today() + timedelta(days=5)).isoformat()

    # The lead's own course must be included; courses must be offered at the branch
    assert client.post(url, json={"course_ids": [java]}, headers=sravani).status_code == 400
    assert client.post(url, json={"course_ids": [course, deal_course(2)]}, headers=sravani).status_code == 400
    assert client.post(url, json={"course_ids": []}, headers=sravani).status_code == 400
    assert client.post(url, json={"course_ids": [course], "expected_close_date": "2020-01-01"},
                       headers=sravani).status_code == 400
    assert client.post(url, json={"course_ids": [course]}, headers=people["nikhil"]["h"]).status_code == 403

    result = call(client, "post", f"/leads/{lead['lead_id']}/convert", sravani,
                  json={"course_ids": [course, java], "expected_close_date": close})
    entry = result["pipeline_entry"]
    assert entry["stage"] == "Counselling" and entry["expected_close_date"] == close
    assert entry["owner"]["full_name"] == "Sravani"
    assert [(c["course"]["course_id"], c["result"]) for c in result["courses"]] == [(course, "converted"), (java, "created")]
    assert len(entry["courses"]) == 2 and {c["stage"] for c in entry["courses"]} == {"Counselling"}
    added = call(client, "get", f"/leads/{result['courses'][1]['lead']['lead_id']}", sravani)
    assert added["qualified_at"] and added["converted_at"] and added["pipeline_entry_id"] == entry["pipeline_entry_id"]
    assert added["owner"]["full_name"] == "Sravani" and added["person"]["person_id"] == lead["person"]["person_id"]

    # Conversion creates no admission, receipt or LMS access
    assert Admission.query.count() == 0 and Payment.query.count() == 0

    response = client.post(url, json={"course_ids": [course]}, headers=sravani)
    assert response.status_code == 422 and "already a deal" in error_of(response)["message"]


def test_converting_a_later_enquiry_reuses_the_person_and_returns_open_deals(client, people, course):
    sravani = people["sravani"]["h"]
    java = deal_course(1)
    first = create_lead(client, sravani, course_id=course)
    convert_lead(client, sravani, first["lead_id"])
    person_id = first["person"]["person_id"]

    # A later enquiry for another course stays a lead until converted; the open course is returned, not duplicated
    later = create_lead(client, sravani, person=None, person_id=person_id, course_id=java)
    assert later["stage"] == "New Enquiry" and later["pipeline_entry_id"] is None
    result = convert_lead(client, sravani, later["lead_id"], course_ids=[java, course])
    assert [c["result"] for c in result["courses"]] == ["converted", "existing"]
    assert result["courses"][1]["lead"]["lead_id"] == first["lead_id"]
    card = result["pipeline_entry"]
    assert sorted(c["lead_id"] for c in card["courses"]) == sorted([first["lead_id"], later["lead_id"]])

    # A New Enquiry lead the person already has for a chosen course is converted, not recreated
    other = create_lead(client, sravani, person={"full_name": "Sibling", "phone": "9000000402"}, course_id=course)
    extra = create_lead(client, sravani, person=None, person_id=other["person"]["person_id"], course_id=java)
    result = convert_lead(client, sravani, other["lead_id"], course_ids=[course, java])
    assert [c["result"] for c in result["courses"]] == ["converted", "converted"]
    assert result["courses"][1]["lead"]["lead_id"] == extra["lead_id"]


def test_convert_into_another_branch_and_reactivation(client, people, make_user, login, course):
    admin = people["admin"]["h"]
    vij_course = deal_course(2)
    lead = create_lead(client, admin, person={"full_name": "Mover", "phone": "9000000403"})  # no course yet
    qualify_lead(client, admin, lead["lead_id"])
    result = call(client, "post", f"/leads/{lead['lead_id']}/convert", admin,
                  json={"course_ids": [vij_course], "branch_id": 2, "assigned_to": people["mounika"]["id"]})
    assert result["pipeline_entry"]["branch"]["branch_id"] == 2
    assert result["pipeline_entry"]["owner"]["full_name"] == people_name(people, "mounika")
    moved = call(client, "get", f"/leads/{lead['lead_id']}", admin)
    assert moved["branch"]["branch_id"] == 2 and moved["course"]["course_id"] == vij_course

    # Lost after conversion; reactivating to New Enquiry makes it a lead again (needs a new conversion)
    call(client, "post", f"/pipeline-entries/{result['pipeline_entry']['pipeline_entry_id']}/stage", admin,
         json={"stage": "Lost - closed", "lost_reason_id": lookup_id(LostReason, "FEE_TOO_HIGH")})
    again = call(client, "post", f"/leads/{lead['lead_id']}/reactivate", admin, json={"stage": "New Enquiry"})
    assert again["stage"] == "New Enquiry" and again["converted_at"] is None and again["qualified_at"]
    response = client.post(f"{API}/leads/{lead['lead_id']}/stage", json={"stage": "Counselling"}, headers=admin)
    assert response.status_code == 422


def people_name(people, key):
    from config.database import db
    from models import User

    return db.session.get(User, people[key]["id"]).full_name
