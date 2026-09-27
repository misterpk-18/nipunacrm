"""Step 0: health check, error mapping, JSON encoding, pagination, request transactions."""
from datetime import date, datetime, timezone
from decimal import Decimal

from flask import Blueprint
from sqlalchemy import text

from config.database import db
from controllers.common import Validator, get_page_params, json_body, ok
from repositories.common import set_db_user
from services.errors import BusinessRule


def add_test_routes(app, routes: dict) -> None:
    """Register throwaway routes (must run before the test's first request)."""
    bp = Blueprint("test_only", __name__)
    for path, view in routes.items():
        bp.add_url_rule(path, view_func=view, methods=["GET", "POST"], endpoint=path.strip("/").replace("/", "_"))
    app.register_blueprint(bp, url_prefix="/test")


def count_holidays() -> int:
    return db.session.execute(text("SELECT count(*) FROM holidays")).scalar()


# ---------------------------------------------------------------- health / routing

def test_health_reports_database_ok(client):
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.get_json() == {"data": {"status": "ok", "database": "ok"}}


def test_unknown_route_returns_json_404(client):
    response = client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "NOT_FOUND"


def test_wrong_method_returns_json_405(client):
    response = client.post("/api/v1/health")

    assert response.status_code == 405
    assert response.get_json()["error"]["code"] == "METHOD_NOT_ALLOWED"


# ---------------------------------------------------------------- error mapping

def test_app_error_maps_to_its_status_and_code(app, client):
    def view():
        raise BusinessRule("Lead is already admitted", {"lead_id": 7})

    add_test_routes(app, {"/app-error": view})
    response = client.get("/test/app-error")

    assert response.status_code == 422
    assert response.get_json() == {
        "error": {"code": "BUSINESS_RULE", "message": "Lead is already admitted", "details": {"lead_id": 7}}
    }


def test_validator_returns_400_with_field_details(app, client):
    def view():
        v = Validator(json_body())
        v.string("phone", required=True, max_length=20)
        v.email("email", required=True)
        v.integer("branch_id", min_value=1)
        v.list_of("scopes", lambda item: item.string("role_code", required=True), min_items=1)
        return ok(v.validate())

    add_test_routes(app, {"/validate": view})
    bad = client.post("/test/validate", json={"email": "nope", "branch_id": "x", "scopes": [{}]}).get_json()
    good = client.post("/test/validate", json={
        "phone": " +919000011001 ", "email": " Ananya@Example.TEST", "branch_id": 2, "scopes": [{"role_code": "SALES"}],
    }).get_json()

    assert bad["error"]["code"] == "VALIDATION_ERROR"
    assert bad["error"]["details"] == {
        "phone": ["Required"],
        "email": ["Not a valid email address"],
        "branch_id": ["Must be a whole number"],
        "scopes": {"0": {"role_code": ["Required"]}},
    }
    assert good["data"] == {"phone": "+919000011001", "email": "ananya@example.test", "branch_id": 2,
                            "scopes": [{"role_code": "SALES"}]}


def test_trigger_exception_passes_its_message_through(app, client):
    def view():
        db.session.execute(text("DO $$ BEGIN RAISE EXCEPTION 'Prerequisite missing: accepted plan'; END $$"))

    add_test_routes(app, {"/trigger": view})
    response = client.get("/test/trigger")

    assert response.status_code == 422
    assert response.get_json()["error"] == {"code": "BUSINESS_RULE", "message": "Prerequisite missing: accepted plan"}


def test_unique_violation_returns_409(app, client):
    def view():
        db.session.execute(text(
            "INSERT INTO branches (branch_code, branch_name, city, receipt_prefix) VALUES ('NIT-GNT', 'x', 'x', 'ZZZ')"
        ))

    add_test_routes(app, {"/unique": view})
    response = client.get("/test/unique")

    assert response.status_code == 409
    error = response.get_json()["error"]
    assert error["code"] == "CONFLICT"
    assert error["details"]["constraint"] == "branches_branch_code_key"


def test_foreign_key_violation_returns_invalid_reference(app, client):
    def view():
        db.session.execute(text("INSERT INTO holidays (branch_id, holiday_date, name) VALUES (999999, '2026-10-02', 'x')"))

    add_test_routes(app, {"/fk": view})
    response = client.get("/test/fk")

    assert response.status_code == 422
    assert response.get_json()["error"]["code"] == "INVALID_REFERENCE"


def test_check_violation_returns_business_rule_with_constraint(app, client):
    def view():
        db.session.execute(text(
            "INSERT INTO branch_shifts (branch_id, day_of_week, opens_at, closes_at) VALUES (1, 7, '18:00', '09:00')"
        ))

    add_test_routes(app, {"/check": view})
    error = client.get("/test/check").get_json()["error"]

    assert error["code"] == "BUSINESS_RULE"
    assert error["details"]["constraint"] == "branch_shifts_check"


def test_unhandled_exception_returns_generic_500(app, client):
    def view():
        raise RuntimeError("secret internals")

    add_test_routes(app, {"/boom": view})
    response = client.get("/test/boom")

    assert response.status_code == 500
    assert response.get_json()["error"] == {"code": "INTERNAL_ERROR", "message": "Something went wrong"}


# ---------------------------------------------------------------- transactions

def test_successful_request_commits(app, client):
    def view():
        db.session.execute(text("INSERT INTO holidays (holiday_date, name) VALUES ('2026-10-02', 'Gandhi Jayanti')"))
        return ok({"saved": True})

    add_test_routes(app, {"/save": view})

    assert client.post("/test/save").status_code == 200
    assert count_holidays() == 1


def test_failed_request_rolls_back(app, client):
    def view():
        db.session.execute(text("INSERT INTO holidays (holiday_date, name) VALUES ('2026-10-02', 'Gandhi Jayanti')"))
        raise BusinessRule("Stop after the insert")

    add_test_routes(app, {"/save-then-fail": view})

    assert client.post("/test/save-then-fail").status_code == 422
    assert count_holidays() == 0


def test_set_db_user_is_visible_to_triggers(app, client):
    def view():
        set_db_user(42)
        return ok(db.session.execute(text("SELECT current_setting('app.current_user_id')")).scalar())

    add_test_routes(app, {"/whoami": view})

    assert client.get("/test/whoami").get_json() == {"data": "42"}


# ---------------------------------------------------------------- JSON / pagination

def test_json_encodes_money_dates_as_strings(app, client):
    def view():
        return ok({
            "amount": Decimal("27000.00"),
            "admission_date": date(2026, 9, 24),
            "verified_at": datetime(2026, 9, 24, 12, 30, tzinfo=timezone.utc),
        })

    add_test_routes(app, {"/json": view})

    assert client.get("/test/json").get_json()["data"] == {
        "amount": "27000.00",
        "admission_date": "2026-09-24",
        "verified_at": "2026-09-24T12:30:00+00:00",
    }


def test_pagination_defaults_and_limits(app, client):
    def view():
        page, per_page = get_page_params()
        return ok({"page": page, "per_page": per_page})

    add_test_routes(app, {"/pages": view})

    assert client.get("/test/pages").get_json()["data"] == {"page": 1, "per_page": 25}
    assert client.get("/test/pages?page=3&per_page=100").get_json()["data"] == {"page": 3, "per_page": 100}

    bad = client.get("/test/pages?page=0&per_page=500").get_json()["error"]
    assert bad["code"] == "VALIDATION_ERROR"
    assert set(bad["details"]) == {"page", "per_page"}
