"""Step 2: lookups, branches, shifts, holidays, concession limits, settings."""
import pytest
from sqlalchemy import select, text

from config.database import db
from models import AuditLog

API = "/api/v1"


@pytest.fixture
def admin(make_user, login):
    return login(make_user(roles=[("SUPER_ADMIN", None)]).email)


@pytest.fixture
def sales(make_user, login):
    return login(make_user(roles=[("SALES", 1)]).email)


# ---------------------------------------------------------------- lookups

def test_all_lookups_in_one_call(client, sales):
    data = client.get(f"{API}/lookups", headers=sales).get_json()["data"]

    assert [s["label"] for s in data["lead_sources"]][:2] == ["Organic Social Media", "Google Ads"]
    assert {"requires_reference", "requires_approval"} <= set(data["payment_modes"][0])
    assert data["enums"]["lead_stages"][0] == "New Enquiry"
    assert "Waiting for Batch / Future Joining" in data["enums"]["lead_priorities"]


def test_admin_adds_renames_and_deactivates_lookup_values(client, admin, sales):
    url = f"{API}/lookups/lead-sources"

    created = client.post(url, json={"code": "instagram_ads", "label": "Instagram Ads", "sort_order": 3}, headers=admin)
    assert created.status_code == 201
    assert created.get_json()["data"]["code"] == "INSTAGRAM_ADS"
    row_id = created.get_json()["data"]["id"]

    assert client.post(url, json={"code": "INSTAGRAM_ADS", "label": "Dup"}, headers=admin).status_code == 409
    assert client.post(url, json={"code": "has space", "label": "x"}, headers=admin).status_code == 400
    assert client.post(url, json={"code": "X_Y", "label": "x"}, headers=sales).status_code == 403

    client.patch(f"{url}/{row_id}", json={"label": "Instagram", "is_active": False}, headers=admin)
    active_labels = [s["label"] for s in client.get(f"{API}/lookups", headers=sales).get_json()["data"]["lead_sources"]]
    all_labels = [s["label"] for s in client.get(url, headers=admin).get_json()["data"]]
    assert "Instagram" not in active_labels
    assert "Instagram" in all_labels

    assert client.get(f"{API}/lookups/not-a-type", headers=admin).status_code == 404
    audit = db.session.execute(select(AuditLog.action).where(AuditLog.entity_type == "lead-sources")).scalars().all()
    assert audit == ["LOOKUP_CREATED", "LOOKUP_UPDATED"]


def test_lookup_extra_flags(client, admin):
    created = client.post(f"{API}/lookups/payment-modes", headers=admin,
                          json={"code": "DEMAND_DRAFT", "label": "Demand Draft", "requires_approval": True})

    assert created.get_json()["data"]["requires_approval"] is True
    assert created.get_json()["data"]["requires_reference"] is True  # DB default


# ---------------------------------------------------------------- branches, shifts, holidays

def test_branch_details(client, admin, sales):
    assert client.get(f"{API}/branches/1", headers=sales).get_json()["data"]["branch_code"] == "NIT-GNT"

    updated = client.patch(f"{API}/branches/1", json={"phone": "0863-2345678", "address": "Brodipet"}, headers=admin)
    assert updated.status_code == 200
    assert updated.get_json()["data"]["address"] == "Brodipet"
    assert client.patch(f"{API}/branches/1", json={"address": "x"}, headers=sales).status_code == 403
    assert client.get(f"{API}/branches/99", headers=sales).status_code == 404


def test_replace_shifts_changes_staffed_deadlines(client, admin):
    url = f"{API}/branches/1/shifts"
    assert len(client.get(url, headers=admin).get_json()["data"]) == 6  # placeholder Mon–Sat

    response = client.put(url, headers=admin, json={"shifts": [
        {"day_of_week": d, "opens_at": "10:00", "closes_at": "18:00"} for d in range(1, 6)
    ]})
    assert response.status_code == 200
    assert response.get_json()["data"][0] == {"day_of_week": 1, "opens_at": "10:00", "closes_at": "18:00"}

    # Friday 17:58 + 5 staffed minutes -> Monday 10:03 (Saturday is no longer staffed)
    deadline = db.session.execute(text(
        "SELECT to_char(add_staffed_minutes(1, '2026-10-02 17:58+05:30', 5) AT TIME ZONE 'Asia/Kolkata', 'Dy HH24:MI')"
    )).scalar()
    assert deadline == "Mon 10:03"


def test_shift_validation(client, admin):
    url = f"{API}/branches/1/shifts"

    backwards = client.put(url, headers=admin, json={"shifts": [{"day_of_week": 1, "opens_at": "18:00", "closes_at": "09:00"}]})
    duplicate = client.put(url, headers=admin, json={"shifts": [{"day_of_week": 1, "opens_at": "09:00", "closes_at": "18:00"},
                                                                 {"day_of_week": 1, "opens_at": "09:00", "closes_at": "18:00"}]})
    bad_day = client.put(url, headers=admin, json={"shifts": [{"day_of_week": 8, "opens_at": "09:00", "closes_at": "18:00"}]})

    assert backwards.status_code == 422
    assert duplicate.status_code == 400
    assert bad_day.status_code == 400


def test_holidays(client, admin, sales):
    created = client.post(f"{API}/holidays", json={"holiday_date": "2099-10-02", "name": "Gandhi Jayanti"}, headers=admin)
    branch_only = client.post(f"{API}/holidays", json={"branch_id": 2, "holiday_date": "2099-10-03", "name": "Local"},
                              headers=admin)
    duplicate = client.post(f"{API}/holidays", json={"holiday_date": "2099-10-02", "name": "Again"}, headers=admin)

    assert created.status_code == branch_only.status_code == 201
    assert duplicate.status_code == 409
    guntur = client.get(f"{API}/holidays?year=2099&branch_id=1", headers=sales).get_json()["data"]
    assert [h["name"] for h in guntur] == ["Gandhi Jayanti"]

    holiday_id = created.get_json()["data"]["holiday_id"]
    assert client.delete(f"{API}/holidays/{holiday_id}", headers=admin).status_code == 204

    past = client.post(f"{API}/holidays", json={"holiday_date": "2020-01-26", "name": "Past"}, headers=admin)
    assert client.delete(f"{API}/holidays/{past.get_json()['data']['holiday_id']}", headers=admin).status_code == 400


# ---------------------------------------------------------------- concession limits / settings

def test_concession_limits_replace_set(client, admin):
    url = f"{API}/concession-limits"
    before = {row["role_code"]: row for row in client.get(url, headers=admin).get_json()["data"]}
    assert before["BRANCH_MANAGER"]["max_amount"] == "1000.00"
    assert before["SUPER_ADMIN"]["unlimited"] is True

    response = client.put(url, headers=admin, json={"limits": [
        {"role_code": "BRANCH_MANAGER", "max_percent": 5, "max_amount": 1500},
        {"role_code": "FOUNDER_CEO", "max_percent": None, "max_amount": None},
    ]})
    after = {row["role_code"]: row for row in response.get_json()["data"]}
    assert after["BRANCH_MANAGER"]["max_amount"] == "1500.00"
    assert "SUPER_ADMIN" not in after

    assert client.put(url, headers=admin, json={"limits": [{"role_code": "WIZARD"}]}).status_code == 400
    assert client.put(url, headers=admin, json={"limits": [{"role_code": "SALES", "max_percent": 150}]}).status_code == 400


def test_settings_keep_their_type(client, admin):
    url = f"{API}/settings"
    assert any(s["key"] == "session_idle_minutes" for s in client.get(url, headers=admin).get_json()["data"])

    updated = client.patch(url, headers=admin, json={"login_max_attempts": 7, "report_cutoff_time": "21:00"})
    values = {s["key"]: s["value"] for s in updated.get_json()["data"]}
    assert values["login_max_attempts"] == 7 and values["report_cutoff_time"] == "21:00"

    assert client.patch(url, headers=admin, json={"not_a_setting": 1}).status_code == 400
    assert client.patch(url, headers=admin, json={"login_max_attempts": "seven"}).status_code == 400
    assert client.patch(url, headers=admin, json={}).status_code == 400
