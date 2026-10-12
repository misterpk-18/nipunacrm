"""UX build, section 2: System auto-ticks on the qualification checklist, the duplicate-phone lookup and staffed time."""
from datetime import datetime, timezone

from tests.helpers import API, QUALIFICATION_CHECKS, call, create_lead, error_of, future


def checks(client, headers, lead_id):
    data = call(client, "get", f"/leads/{lead_id}/qualification", headers)
    return {c["check"]: c for c in data["checks"]}


def outcome(client, headers, lead_id, expected=201, **body):
    body.setdefault("channel", "Call")
    return call(client, "post", f"/leads/{lead_id}/outcome", headers, expected, json=body)


def tick(client, headers, lead_id, check, reviewed=True, expected=200):
    return call(client, "put", f"/leads/{lead_id}/qualification/checks", headers, expected,
                json={"check": check, "reviewed": reviewed})


def test_course_ticks_at_creation_and_nothing_else(client, people, course):
    h = people["sravani"]["h"]
    bare = create_lead(client, h)
    assert [c for c, row in checks(client, h, bare["lead_id"]).items() if row["reviewed"]] == []

    lead = create_lead(client, h, course_id=course, person={"full_name": "With Course", "phone": "9000000501"})
    ticked = {c: row for c, row in checks(client, h, lead["lead_id"]).items() if row["reviewed"]}
    assert list(ticked) == ["Intended course(s) understood"]
    row = ticked["Intended course(s) understood"]
    assert row["auto"] is True and row["reviewed_by"] == {"user_id": None, "full_name": "System"} and row["reviewed_at"]


def test_outcome_ticks_reachable_contact_and_next_action(client, people, course):
    h = people["sravani"]["h"]
    lead = create_lead(client, h)  # no course yet
    lid = lead["lead_id"]

    outcome(client, h, lid, outcome="No answer")  # not reached: nothing proven
    assert not checks(client, h, lid)["Reachable contact confirmed"]["reviewed"]

    # follow-up date without an agreed action does not count
    outcome(client, h, lid, outcome="Connected", next_action_at=future(4))
    state = checks(client, h, lid)
    assert state["Reachable contact confirmed"]["reviewed"] and state["Reachable contact confirmed"]["auto"]
    assert not state["Exact next action agreed"]["reviewed"]

    outcome(client, h, lid, outcome="Interested", next_action="Share syllabus", next_action_at=future(30))
    assert checks(client, h, lid)["Exact next action agreed"]["auto"] is True
    # delivery mode and the judgement checks are never ticked by the system
    state = checks(client, h, lid)
    for manual in ("Branch and delivery mode discussed", "Genuine intent confirmed", "Possible identity match reviewed",
                   "Intended course(s) understood"):
        assert not state[manual]["reviewed"]

    # a later course change ticks the course check
    call(client, "patch", f"/leads/{lid}", h, json={"course_id": course})
    assert checks(client, h, lid)["Intended course(s) understood"]["auto"] is True


def test_manual_ticks_survive_and_staff_can_take_over_or_untick(client, people, course):
    h = people["sravani"]["h"]
    lead = create_lead(client, h, course_id=course)
    lid = lead["lead_id"]
    # staff tick a check the system could also prove first: it stays theirs
    tick(client, h, lid, "Reachable contact confirmed")
    outcome(client, h, lid, outcome="Connected")
    row = checks(client, h, lid)["Reachable contact confirmed"]
    assert row["auto"] is False and row["reviewed_by"]["full_name"] == "Sravani"

    # confirming a System tick takes it over; unticking one sticks (no re-tick on read)
    assert checks(client, h, lid)["Intended course(s) understood"]["auto"] is True
    tick(client, h, lid, "Intended course(s) understood")
    taken = checks(client, h, lid)["Intended course(s) understood"]
    assert taken["auto"] is False and taken["reviewed_by"]["full_name"] == "Sravani"
    tick(client, h, lid, "Intended course(s) understood", reviewed=False)
    assert not checks(client, h, lid)["Intended course(s) understood"]["reviewed"]
    assert not checks(client, h, lid)["Intended course(s) understood"]["reviewed"]


def test_read_backfills_a_lead_with_no_ticks_and_mark_qualified_still_needs_staff(client, people, course, run_sql):
    h = people["sravani"]["h"]
    lead = create_lead(client, h, course_id=course)
    lid = lead["lead_id"]
    outcome(client, h, lid, outcome="Connected", next_action="Share syllabus", next_action_at=future(30))
    run_sql("DELETE FROM lead_qualification_reviews WHERE lead_id = :id", id=lid)  # as if it predates auto-ticks
    state = checks(client, h, lid)
    assert {c for c, row in state.items() if row["auto"]} == {
        "Reachable contact confirmed", "Intended course(s) understood", "Exact next action agreed"}

    response = client.post(f"{API}/leads/{lid}/qualify", headers=h)
    assert response.status_code == 422
    assert set(error_of(response)["details"]["missing_checks"]) == {
        "Genuine intent confirmed", "Branch and delivery mode discussed", "Possible identity match reviewed"}
    for check in ("Genuine intent confirmed", "Branch and delivery mode discussed", "Possible identity match reviewed"):
        tick(client, h, lid, check)
    assert call(client, "post", f"/leads/{lid}/qualify", h)["qualified_at"]
    assert all(c["reviewed"] for c in call(client, "get", f"/leads/{lid}/qualification", h)["checks"])
    assert len(QUALIFICATION_CHECKS) == 6


# ---------------------------------------------------------------- duplicate-phone lookup

def test_lookup_finds_visible_person_with_course_count(client, people, course):
    h = people["sravani"]["h"]
    lead = create_lead(client, h, course_id=course)
    found = call(client, "get", "/persons/lookup?phone=98765%2043210", h)
    assert found["other_branch"] is False
    assert [m["person_id"] for m in found["matches"]] == [lead["person"]["person_id"]]
    assert found["matches"][0]["courses_count"] == 1 and found["matches"][0]["courses"] == ["Data Science"]

    empty = call(client, "get", "/persons/lookup?phone=9111122223", h)
    assert empty["matches"] == [] and empty["other_branch"] is False
    assert client.get(f"{API}/persons/lookup", headers=h).status_code == 400
    assert client.get(f"{API}/persons/lookup?phone=12", headers=h).status_code == 400
    assert client.get(f"{API}/persons/lookup?phone=9876543210", headers=people["accounts"]["h"]).status_code == 403


def test_lookup_hides_a_person_the_other_branch_cannot_see(client, people, course):
    create_lead(client, people["sravani"]["h"], course_id=course)  # Guntur person
    other = call(client, "get", "/persons/lookup?phone=9876543210", people["mounika"]["h"])  # Vijayawada staff
    assert other == {"phone": "+919876543210", "matches": [], "other_branch": True}
    admin = call(client, "get", "/persons/lookup?phone=9876543210", people["admin"]["h"])
    assert len(admin["matches"]) == 1 and admin["other_branch"] is False


# ---------------------------------------------------------------- staffed time

def test_staffed_time_is_in_the_future_and_branch_scoped(client, people):
    h = people["sravani"]["h"]
    at = call(client, "get", "/leads/staffed-time?branch_id=1&minutes=120", h)["at"]
    assert datetime.fromisoformat(at) > datetime.now(timezone.utc)
    assert client.get(f"{API}/leads/staffed-time?branch_id=2", headers=h).status_code == 403
    assert client.get(f"{API}/leads/staffed-time", headers=h).status_code == 400
