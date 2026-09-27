"""Step 1: login, sessions, fresh auth, password changes."""
import pytest
from sqlalchemy import select

from config.database import db
from models import AuditLog, UserSession
from services.security import hash_token
from tests.conftest import PASSWORD

LOGIN = "/api/v1/auth/login"
ME = "/api/v1/auth/me"


def login_response(client, email, password=PASSWORD):
    return client.post(LOGIN, json={"email": email, "password": password})


# ---------------------------------------------------------------- login

def test_login_returns_token_profile_and_stores_only_a_hash(client, make_user):
    user = make_user(roles=[("BRANCH_MANAGER", 1)])

    response = login_response(client, user.email.upper())  # email is case-insensitive
    data = response.get_json()["data"]

    assert response.status_code == 200
    assert data["user"]["email"] == user.email
    assert [(s["role_code"], s["branch_code"]) for s in data["scopes"]] == [("BRANCH_MANAGER", "NIT-GNT")]
    assert data["allowed_branches"] == [{"branch_id": 1, "branch_code": "NIT-GNT", "branch_name": "Guntur"}]
    assert data["home_route"] == "/branch-manager"
    assert data["expires_at"]

    stored_ids = db.session.execute(select(UserSession.session_id).where(UserSession.user_id == user.user_id)).scalars().all()
    assert stored_ids == [hash_token(data["token"])]


@pytest.mark.parametrize(
    "roles, home_route, branch_count",
    [
        ([("FOUNDER_CEO", None)], "/dashboard", 2),
        ([("SALES", 2)], "/counsellor", 1),
        ([("FRONT_OFFICE", 1), ("SALES", 2)], "/counsellor", 2),
        ([("ACCOUNTS", 1)], "/dashboard", 1),
    ],
)
def test_home_route_and_branches_follow_role_scopes(client, make_user, roles, home_route, branch_count):
    user = make_user(roles=roles)

    data = login_response(client, user.email).get_json()["data"]

    assert data["home_route"] == home_route
    assert len(data["allowed_branches"]) == branch_count


def test_wrong_password_and_unknown_email_get_the_same_error(client, make_user):
    user = make_user()

    wrong_password = login_response(client, user.email, "not-the-password")
    unknown_email = login_response(client, "nobody@nipuna.test")

    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.get_json() == unknown_email.get_json()


def test_account_locks_after_five_failures(client, make_user):
    user = make_user()

    statuses = [login_response(client, user.email, "wrong-password").status_code for _ in range(5)]
    locked = login_response(client, user.email)  # correct password, but locked

    assert statuses == [401] * 5
    assert locked.status_code == 429
    assert locked.get_json()["error"]["code"] == "TOO_MANY_ATTEMPTS"


def test_inactive_user_cannot_log_in(client, make_user):
    user = make_user(is_active=False)

    assert login_response(client, user.email).status_code == 401


def test_user_without_active_access_cannot_log_in(client, make_user):
    user = make_user(roles=[])

    response = login_response(client, user.email)

    assert response.status_code == 403
    assert "no active access" in response.get_json()["error"]["message"]


def test_login_validates_input(client):
    response = client.post(LOGIN, json={"email": "not-an-email"})

    assert response.status_code == 400
    assert set(response.get_json()["error"]["details"]) == {"email", "password"}


def test_login_is_audited(client, make_user):
    user = make_user()
    login_response(client, user.email)

    actions = db.session.execute(select(AuditLog.action, AuditLog.actor_user_id)).all()
    assert ("LOGIN", user.user_id) in actions


# ---------------------------------------------------------------- sessions

def test_protected_endpoints_need_a_valid_token(client):
    assert client.get(ME).status_code == 401
    assert client.get(ME, headers={"Authorization": "Bearer made-up"}).status_code == 401
    assert client.get(ME, headers={"Authorization": "Basic abc"}).status_code == 401


def test_logout_revokes_the_session(client, make_user, login):
    headers = login(make_user().email)

    assert client.post("/api/v1/auth/logout", headers=headers).status_code == 204
    assert client.get(ME, headers=headers).status_code == 401


def test_session_expires_after_30_minutes_idle(client, make_user, login, run_sql):
    user = make_user()
    headers = login(user.email)

    run_sql("UPDATE user_sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = :u", u=user.user_id)

    assert client.get(ME, headers=headers).status_code == 401


def test_session_expires_after_12_hours(client, make_user, login, run_sql):
    user = make_user()
    headers = login(user.email)

    run_sql("UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE user_id = :u", u=user.user_id)

    assert client.get(ME, headers=headers).status_code == 401


def test_revoked_scope_loses_access_immediately(client, make_user, login, run_sql):
    admin = make_user(roles=[("SUPER_ADMIN", None), ("SALES", 1)])
    headers = login(admin.email)
    assert client.get("/api/v1/users", headers=headers).status_code == 200

    run_sql("UPDATE user_role_scopes SET revoked_at = now() WHERE user_id = :u AND branch_id IS NULL", u=admin.user_id)

    response = client.get("/api/v1/users", headers=headers)
    assert response.status_code == 403
    assert client.get(ME, headers=headers).get_json()["data"]["scopes"][0]["role_code"] == "SALES"


def test_expired_scope_loses_access(client, make_user, login, run_sql):
    admin = make_user(roles=[("SUPER_ADMIN", None), ("SALES", 1)])
    headers = login(admin.email)

    run_sql("UPDATE user_role_scopes SET expires_at = now() - interval '1 minute' WHERE user_id = :u AND branch_id IS NULL",
            u=admin.user_id)

    assert client.get("/api/v1/users", headers=headers).status_code == 403


def test_list_and_revoke_own_sessions(client, make_user, login):
    user = make_user()
    other_user = make_user()
    first = login(user.email)
    second = login(user.email)
    others = login(other_user.email)

    sessions = client.get("/api/v1/auth/sessions", headers=first).get_json()["data"]
    assert len(sessions) == 2
    assert sum(s["current"] for s in sessions) == 1
    other_device = next(s["session_id"] for s in sessions if not s["current"])

    foreign = client.get("/api/v1/auth/sessions", headers=others).get_json()["data"][0]["session_id"]
    assert client.delete(f"/api/v1/auth/sessions/{foreign}", headers=first).status_code == 404

    assert client.delete(f"/api/v1/auth/sessions/{other_device}", headers=first).status_code == 204
    assert client.get(ME, headers=second).status_code == 401
    assert client.get(ME, headers=first).status_code == 200


# ---------------------------------------------------------------- fresh auth

def test_sensitive_action_needs_recent_password_entry(client, make_user, login, run_sql):
    admin = make_user()
    target = make_user(roles=[("SALES", 1)])
    headers = login(admin.email)
    run_sql("UPDATE user_sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = :u", u=admin.user_id)

    stale = client.post(f"/api/v1/users/{target.user_id}/reset-password", headers=headers)
    assert stale.status_code == 401
    assert stale.get_json()["error"]["code"] == "FRESH_AUTH_REQUIRED"

    wrong = client.post("/api/v1/auth/reauthenticate", json={"password": "nope"}, headers=headers)
    assert wrong.status_code == 400
    assert client.post("/api/v1/auth/reauthenticate", json={"password": PASSWORD}, headers=headers).status_code == 204

    assert client.post(f"/api/v1/users/{target.user_id}/reset-password", headers=headers).status_code == 200


# ---------------------------------------------------------------- passwords

def test_change_password_signs_out_other_sessions(client, make_user, login):
    user = make_user()
    this_device = login(user.email)
    other_device = login(user.email)
    url = "/api/v1/auth/change-password"

    wrong_current = client.post(url, json={"current_password": "nope", "new_password": "Another-pass-2"}, headers=this_device)
    too_short = client.post(url, json={"current_password": PASSWORD, "new_password": "short"}, headers=this_device)
    assert wrong_current.status_code == too_short.status_code == 400

    assert client.post(url, json={"current_password": PASSWORD, "new_password": "Another-pass-2"},
                       headers=this_device).status_code == 204
    assert client.get(ME, headers=other_device).status_code == 401
    assert client.get(ME, headers=this_device).status_code == 200
    assert login_response(client, user.email).status_code == 401
    assert login_response(client, user.email, "Another-pass-2").status_code == 200


def test_temporary_password_must_be_changed_before_anything_else(client, make_user, login):
    admin_headers = login(make_user().email)
    created = client.post("/api/v1/users", headers=admin_headers, json={
        "full_name": "Sravani", "email": "sravani@nipuna.test", "scopes": [{"role_code": "SALES", "branch_id": 1}],
    }).get_json()["data"]

    first_login = login_response(client, "sravani@nipuna.test", created["temporary_password"]).get_json()["data"]
    headers = {"Authorization": f"Bearer {first_login['token']}"}
    assert first_login["user"]["must_change_password"] is True

    blocked = client.get("/api/v1/roles", headers=headers)
    assert blocked.status_code == 403
    assert blocked.get_json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"
    assert client.get(ME, headers=headers).status_code == 200

    client.post("/api/v1/auth/change-password", headers=headers,
                json={"current_password": created["temporary_password"], "new_password": "Sravani-new-pass"})
    assert client.get("/api/v1/roles", headers=headers).status_code == 200


def test_recovery_account_requests_are_audited(client, make_user, login):
    recovery = make_user(roles=[("SUPER_ADMIN", None)], is_recovery_account=True)
    headers = login(recovery.email)

    client.get("/api/v1/roles", headers=headers)

    entries = db.session.execute(
        select(AuditLog.entity_id, AuditLog.new_values).where(AuditLog.action == "RECOVERY_ACCESS")
    ).all()
    assert ("reference.list_roles", {"method": "GET", "path": "/api/v1/roles"}) in entries
