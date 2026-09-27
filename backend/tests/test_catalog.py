"""Step 2: Course Master, payment plans, Offer Master."""
import pytest

API = "/api/v1"


@pytest.fixture
def admin(make_user, login):
    return login(make_user(roles=[("SUPER_ADMIN", None)]).email)


@pytest.fixture
def make_course(client, admin):
    def _make(code, title="Course", fee=20000, is_combo=False, branch_ids=(1, 2), category="Data & Analytics"):
        response = client.post(f"{API}/courses", headers=admin, json={
            "course_code": code, "course_title": title, "category": category, "standard_fee": fee,
            "is_combo": is_combo, "branch_ids": list(branch_ids),
        })
        assert response.status_code == 201, response.get_json()
        return response.get_json()["data"]

    return _make


# ---------------------------------------------------------------- courses

def test_create_and_list_courses(client, admin, make_course, make_user, login):
    make_course("NIT-CRS-018", "Data Science", 30000)
    make_course("NIT-CRS-019", "Power BI", 22000, branch_ids=(2,))
    make_course("NIT-CMB-001", "AI Java Full Stack", 25000, is_combo=True, category="3+1 Career Combo")
    sales = login(make_user(roles=[("SALES", 1)]).email)

    all_courses = client.get(f"{API}/courses", headers=sales).get_json()
    guntur = client.get(f"{API}/courses?branch_id=1&type=standalone", headers=sales).get_json()["data"]
    search = client.get(f"{API}/courses?q=power", headers=sales).get_json()["data"]

    assert all_courses["meta"]["total"] == 3
    assert [c["course_code"] for c in guntur] == ["NIT-CRS-018"]
    assert guntur[0]["standard_fee"] == "30000.00" and guntur[0]["branches"] == ["NIT-GNT", "NIT-VIJ"]
    assert [c["course_code"] for c in search] == ["NIT-CRS-019"]


def test_course_validation_and_duplicates(client, admin, make_course):
    make_course("NIT-CRS-018")

    duplicate = client.post(f"{API}/courses", headers=admin, json={
        "course_code": "nit-crs-018", "course_title": "x", "category": "x", "standard_fee": 1})
    invalid = client.post(f"{API}/courses", headers=admin, json={
        "course_code": "bad code!", "course_title": "", "category": "x", "standard_fee": -5, "branch_ids": [99]})
    unknown_branch = client.post(f"{API}/courses", headers=admin, json={
        "course_code": "NIT-CRS-099", "course_title": "x", "category": "x", "standard_fee": 1, "branch_ids": [99]})

    assert duplicate.status_code == 409
    assert invalid.status_code == 400
    assert set(invalid.get_json()["error"]["details"]) == {"course_code", "course_title", "standard_fee"}
    assert unknown_branch.status_code == 400


def test_update_course_and_branches(client, admin, make_course):
    course = make_course("NIT-CRS-007", "AWS with DevOps", 22000)

    updated = client.patch(f"{API}/courses/{course['course_id']}", json={"standard_fee": "24000", "status": "Inactive"},
                           headers=admin)
    branches = client.put(f"{API}/courses/{course['course_id']}/branches", json={"branch_ids": [2]}, headers=admin)

    assert updated.get_json()["data"]["standard_fee"] == "24000.00"
    assert updated.get_json()["data"]["status"] == "Inactive"
    assert branches.get_json()["data"]["branches"] == ["NIT-VIJ"]


def test_combo_components(client, admin, make_course):
    java = make_course("NIT-CRS-047", "Java Full Stack")
    excel = make_course("NIT-CRS-034", "Advanced Excel", 5000)
    combo = make_course("NIT-CMB-001", "AI Java Full Stack", is_combo=True)
    other_combo = make_course("NIT-CMB-002", "AI Python Full Stack", is_combo=True)
    url = f"{API}/courses/{combo['course_id']}/components"

    response = client.put(url, headers=admin, json={"components": [
        {"course_id": java["course_id"]}, {"course_id": excel["course_id"], "is_bonus": True},
    ]})
    components = response.get_json()["data"]["components"]
    assert response.status_code == 200
    assert [(c["course_code"], c["is_bonus"]) for c in components] == [("NIT-CRS-047", False), ("NIT-CRS-034", True)]

    nested = client.put(url, headers=admin, json={"components": [{"course_id": other_combo["course_id"]}]})
    itself = client.put(url, headers=admin, json={"components": [{"course_id": combo["course_id"]}]})
    not_combo = client.put(f"{API}/courses/{java['course_id']}/components", headers=admin,
                           json={"components": [{"course_id": excel["course_id"]}]})
    assert nested.status_code == itself.status_code == 400
    assert not_combo.status_code == 422


# ---------------------------------------------------------------- payment plans

def test_payment_plans(client, admin, make_user, login):
    sales = login(make_user(roles=[("SALES", 1)]).email)
    seeded = [p["plan_code"] for p in client.get(f"{API}/payment-plans", headers=sales).get_json()["data"]]
    assert seeded == ["FULL", "TWO_INSTALMENTS", "THREE_INSTALMENTS"]

    bad_total = client.post(f"{API}/payment-plans", headers=admin, json={
        "plan_code": "SPLIT", "plan_name": "Split", "installments": [{"percent_of_fee": 60}, {"percent_of_fee": 30}]})
    bad_window = client.post(f"{API}/payment-plans", headers=admin, json={
        "plan_code": "SPLIT", "plan_name": "Split", "installments": [
            {"percent_of_fee": 100, "due_days_after_admission": 20, "due_days_min": 5, "due_days_max": 10}]})
    created = client.post(f"{API}/payment-plans", headers=admin, json={
        "plan_code": "split_70_30", "plan_name": "70 / 30", "installments": [
            {"percent_of_fee": 70}, {"percent_of_fee": 30, "due_days_after_admission": 20, "due_days_min": 15, "due_days_max": 25}]})

    assert bad_total.status_code == bad_window.status_code == 400
    assert created.status_code == 201
    plan = created.get_json()["data"]
    assert plan["plan_code"] == "SPLIT_70_30"
    assert [(i["installment_no"], i["due_days_min"], i["due_days_max"]) for i in plan["installments"]] == [(1, 0, 0), (2, 15, 25)]

    renamed = client.patch(f"{API}/payment-plans/{plan['payment_plan_id']}", headers=admin, json={
        "plan_name": "70/30 split", "installments": [{"percent_of_fee": 100}]})
    assert renamed.get_json()["data"]["plan_name"] == "70/30 split"
    assert len(renamed.get_json()["data"]["installments"]) == 1

    assert client.post(f"{API}/payment-plans", headers=sales, json={}).status_code == 403


# ---------------------------------------------------------------- offers

def offer_body(**overrides):
    body = {"offer_code": "OM-2026-10", "offer_name": "October campaign", "benefit_type": "Discount Amount",
            "discount_amount": 2000, "valid_from": "2026-10-01", "valid_to": "2099-10-31",
            "applies_to_all_courses": True}
    return {**body, **overrides}


def test_offer_lifecycle_and_versions(client, admin):
    created = client.post(f"{API}/offers", json=offer_body(), headers=admin)
    offer = created.get_json()["data"]
    assert created.status_code == 201
    assert (offer["version"], offer["status"]) == (1, "Draft")
    assert client.post(f"{API}/offers", json=offer_body(), headers=admin).status_code == 409

    edited = client.patch(f"{API}/offers/{offer['offer_id']}", json={"discount_amount": 2500, "status": "Configured"},
                          headers=admin)
    assert edited.get_json()["data"]["status"] == "Configured"

    activated = client.post(f"{API}/offers/{offer['offer_id']}/activate", headers=admin).get_json()["data"]
    assert activated["status"] == "Active" and activated["approved_by"] is not None
    assert client.patch(f"{API}/offers/{offer['offer_id']}", json={"discount_amount": 1}, headers=admin).status_code == 422

    version_2 = client.post(f"{API}/offers/{offer['offer_id']}/new-version", headers=admin).get_json()["data"]
    assert (version_2["version"], version_2["status"], version_2["discount_amount"]) == (2, "Draft", "2500.00")

    client.post(f"{API}/offers/{version_2['offer_id']}/activate", headers=admin)
    statuses = {o["version"]: o["status"] for o in client.get(f"{API}/offers?offer_code=OM-2026-10", headers=admin).get_json()["data"]}
    assert statuses == {1: "Inactive", 2: "Active"}


def test_offer_rules(client, admin, make_user, login):
    missing_percent = client.post(f"{API}/offers", headers=admin, json=offer_body(
        offer_code="OM-PCT", benefit_type="Discount Percent", discount_amount=None))
    no_branches = client.post(f"{API}/offers", headers=admin, json=offer_body(
        offer_code="OM-BR", applies_to_all_branches=False))
    complimentary = client.post(f"{API}/offers", headers=admin, json=offer_body(
        offer_code="OM-FREE", benefit_type="Complimentary Course", discount_amount=None)).get_json()["data"]

    assert missing_percent.status_code == 422  # DB check: percent offers need discount_percent
    assert no_branches.status_code == 400
    activate_empty = client.post(f"{API}/offers/{complimentary['offer_id']}/activate", headers=admin)
    assert activate_empty.status_code == 400

    course = client.post(f"{API}/courses", headers=admin, json={
        "course_code": "NIT-CRS-034", "course_title": "Advanced Excel", "category": "x", "standard_fee": 5000}).get_json()["data"]
    with_course = client.put(f"{API}/offers/{complimentary['offer_id']}/complimentary-courses", headers=admin, json={
        "courses": [{"course_id": course["course_id"], "min_final_fee": 15000, "access_period_days": 90}]})
    assert with_course.get_json()["data"]["complimentary_courses"][0]["min_final_fee"] == "15000.00"
    assert client.post(f"{API}/offers/{complimentary['offer_id']}/activate", headers=admin).status_code == 200

    manager = login(make_user(roles=[("BRANCH_MANAGER", 1)]).email)
    assert client.get(f"{API}/offers", headers=manager).status_code == 200
    assert client.post(f"{API}/offers", json=offer_body(offer_code="OM-BM"), headers=manager).status_code == 403


def test_offer_scope(client, admin):
    offer = client.post(f"{API}/offers", json=offer_body(), headers=admin).get_json()["data"]

    scoped = client.put(f"{API}/offers/{offer['offer_id']}/scope", headers=admin,
                        json={"applies_to_all_branches": False, "branch_ids": [2]})

    assert scoped.get_json()["data"]["branch_ids"] == [2]
    assert scoped.get_json()["data"]["applies_to_all_branches"] is False
