"""Persons section: list / search by name or mobile, and Person 360 overview."""
from tests.helpers import API, admitted, call, create_deal, create_lead


def test_persons_list_search_and_scope(client, people):
    sravani = people["sravani"]["h"]
    create_deal(client, sravani)  # Ananya Rao, +919876543210, on a pipeline card
    b = create_lead(client, sravani, person={"full_name": "Vamsi Krishna", "phone": "9123456789"})
    create_lead(client, people["mounika"]["h"], branch_id=2, person={"full_name": "Karthik", "phone": "9111111111"})

    names = lambda url, h=sravani: [row["full_name"] for row in call(client, "get", url, h)]  # noqa: E731
    assert names("/persons") == ["Vamsi Krishna", "Ananya Rao"]  # newest first, own branch only
    assert names("/persons?q=ananya") == ["Ananya Rao"]
    assert names("/persons?q=98765") == ["Ananya Rao"]           # part of the mobile number
    assert names("/persons?q=+91 91234 56789") == ["Vamsi Krishna"]
    assert names("/persons?q=zzz") == []
    assert len(names("/persons", people["admin"]["h"])) == 3
    assert names("/persons?branch_id=2", people["admin"]["h"]) == ["Karthik"]
    assert client.get(f"{API}/persons?branch_id=2", headers=sravani).status_code == 403
    assert client.get(f"{API}/persons", headers=people["accounts"]["h"]).status_code == 403

    rows = {row["full_name"]: row for row in call(client, "get", "/persons", sravani)}
    assert rows["Ananya Rao"]["open_cards"][0]["stage"] == "Counselling"
    assert rows["Ananya Rao"]["active_leads"] == []
    assert [lead["lead_code"] for lead in rows["Vamsi Krishna"]["active_leads"]] == [b["lead_code"]]
    assert rows["Vamsi Krishna"]["open_cards"] == [] and rows["Vamsi Krishna"]["leads_count"] == 1


def test_person_overview(client, people, course):
    sravani = people["sravani"]["h"]
    flow = admitted(client, people, course)
    person_id = flow["lead"]["person"]["person_id"]
    other = create_lead(client, sravani, person_id=person_id)  # a second enquiry, still New Enquiry

    overview = call(client, "get", f"/persons/{person_id}/overview", sravani)
    assert overview["person"]["full_name"] == "Ananya Rao"
    assert [lead["lead_code"] for lead in overview["leads"]] == [other["lead_code"], flow["lead"]["lead_code"]]
    assert [card["stage"] for card in overview["pipeline_cards"]] == ["Admitted"]
    assert overview["pipeline_cards"][0]["is_open"] is False
    assert [a["admission_code"] for a in overview["admissions"]] == [flow["admission"]["admission_code"]]

    assert client.get(f"{API}/persons/{person_id}/overview", headers=people["mounika"]["h"]).status_code == 404
    assert client.get(f"{API}/persons/999999/overview", headers=sravani).status_code == 404
