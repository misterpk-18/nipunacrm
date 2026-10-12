"""Lead 360 is read-only for Accounts: they GET the lead and its tab endpoints in their own branch (404 for another
branch) and every write stays refused (403)."""
import pytest

from tests.helpers import API, call, convert_lead, create_lead

READERS = ("accounts",)


@pytest.fixture
def deal(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    convert_lead(client, people["sravani"]["h"], lead["lead_id"])
    return call(client, "get", f"/leads/{lead['lead_id']}", people["sravani"]["h"])


@pytest.mark.parametrize("who", READERS)
def test_reads_in_own_branch(client, people, deal, who):
    h, lid = people[who]["h"], deal["lead_id"]
    assert call(client, "get", f"/leads/{lid}", h)["lead_id"] == lid
    for tail in ("activities", "enquiries", "journey", "workbench", "delivery-plan"):
        call(client, "get", f"/leads/{lid}/{tail}", h)
    call(client, "get", f"/pipeline-entries/{deal['pipeline_entry_id']}", h)
    assert client.get(f"{API}/tasks?view=team&lead_id={lid}", headers=h).status_code == 200


def test_money_and_demo_tabs_by_role(client, people, deal):
    lid = deal["lead_id"]
    acc = people["accounts"]["h"]
    call(client, "get", f"/leads/{lid}/fee-discussions", acc)
    call(client, "get", f"/demos?lead_id={lid}", acc)
    call(client, "get", f"/demos", acc, 403)  # Accounts never lists the whole schedule
    call(client, "get", f"/leads/{lid}/ai/insights", acc, 403)


@pytest.mark.parametrize("who", READERS)
def test_other_branch_is_not_found(client, people, course, who):
    other = create_lead(client, people["mounika"]["h"], branch_id=2)
    lid, h = other["lead_id"], people[who]["h"]
    for tail in ("", "/activities", "/enquiries", "/journey", "/workbench"):
        call(client, "get", f"/leads/{lid}{tail}", h, 404)


@pytest.mark.parametrize("who", READERS)
def test_writes_stay_refused(client, people, deal, who):
    h, lid = people[who]["h"], deal["lead_id"]
    call(client, "patch", f"/leads/{lid}", h, 403, json={"remarks": "x"})
    call(client, "post", f"/leads/{lid}/stage", h, 403, json={"stage": "Counselling"})
    call(client, "post", f"/leads/{lid}/assign", h, 403, json={"assigned_to": people["nikhil"]["id"]})
    call(client, "post", f"/leads/{lid}/outcome", h, 403,
         json={"channel": "Call", "outcome": "Connected"})
    call(client, "post", f"/leads/{lid}/activities", h, 403, json={"activity_type": "Call"})
    call(client, "post", f"/leads/{lid}/lost", h, 403, json={})
