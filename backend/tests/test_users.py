"""Step 1: Admin → Users & Access, roles and branches lists, create-admin CLI."""
from sqlalchemy import select

from config.database import db
from models import AuditLog, User
from tests.conftest import PASSWORD

USERS = "/api/v1/users"


def new_user_body(**overrides):
    body = {"full_name": "Mounika", "email": "mounika@nipuna.test", "scopes": [{"role_code": "SALES", "branch_id": 2}]}
    return {**body, **overrides}


# ---------------------------------------------------------------- access control

def test_only_admins_can_manage_users(client, make_user, login):
    headers = login(make_user(roles=[("BRANCH_MANAGER", 1)]).email)

    assert client.get(USERS, headers=headers).status_code == 403
    assert client.post(USERS, json=new_user_body(), headers=headers).status_code == 403


# ---------------------------------------------------------------- create

def test_create_user_returns_one_time_temporary_password(client, make_user, login):
    admin = make_user()
    headers = login(admin.email)
    body = new_user_body(email="  Mounika@Nipuna.TEST ", scopes=[
        {"role_code": "SALES", "branch_id": 2}, {"role_code": "FRONT_OFFICE", "branch_id": 2},
    ])

    response = client.post(USERS, json=body, headers=headers)
    data = response.get_json()["data"]

    assert response.status_code == 201
    assert data["user"]["email"] == "mounika@nipuna.test"
    assert data["user"]["must_change_password"] is True
    assert sorted(s["role_code"] for s in data["user"]["scopes"]) == ["FRONT_OFFICE", "SALES"]
    assert client.post("/api/v1/auth/login", json={"email": "mounika@nipuna.test",
                                                   "password": data["temporary_password"]}).status_code == 200

    audit = db.session.execute(select(AuditLog.actor_user_id).where(AuditLog.action == "USER_CREATED")).scalars().all()
    assert audit == [admin.user_id]


def test_create_user_rejects_duplicate_email_in_any_case(client, make_user, login):
    make_user(email="mounika@nipuna.test")
    headers = login(make_user().email)

    response = client.post(USERS, json=new_user_body(email="MOUNIKA@nipuna.test"), headers=headers)

    assert response.status_code == 409


def test_create_user_validates_body(client, make_user, login):
    headers = login(make_user().email)

    response = client.post(USERS, json={"full_name": "", "email": "bad", "scopes": []}, headers=headers)

    assert response.status_code == 400
    assert set(response.get_json()["error"]["details"]) == {"full_name", "email", "scopes"}


def test_role_and_branch_must_fit_together(client, make_user, login):
    headers = login(make_user().email)

    company_role_with_branch = client.post(USERS, headers=headers, json=new_user_body(
        scopes=[{"role_code": "SUPER_ADMIN", "branch_id": 1}]))
    branch_role_without_branch = client.post(USERS, headers=headers, json=new_user_body(
        email="b@nipuna.test", scopes=[{"role_code": "SALES", "branch_id": None}]))
    unknown_role = client.post(USERS, headers=headers, json=new_user_body(
        email="c@nipuna.test", scopes=[{"role_code": "WIZARD", "branch_id": 1}]))
    unknown_branch = client.post(USERS, headers=headers, json=new_user_body(
        email="d@nipuna.test", scopes=[{"role_code": "SALES", "branch_id": 99}]))

    assert company_role_with_branch.status_code == 422
    assert "all branches" in company_role_with_branch.get_json()["error"]["message"]
    assert branch_role_without_branch.status_code == 422
    assert unknown_role.status_code == unknown_branch.status_code == 400


def test_only_a_founder_can_grant_founder_access(client, make_user, login):
    super_admin = login(make_user(roles=[("SUPER_ADMIN", None)]).email)
    founder = login(make_user(roles=[("FOUNDER_CEO", None)]).email)
    body = new_user_body(scopes=[{"role_code": "FOUNDER_CEO", "branch_id": None}])

    assert client.post(USERS, json=body, headers=super_admin).status_code == 403
    assert client.post(USERS, json=body, headers=founder).status_code == 201


def test_only_a_founder_can_create_a_recovery_account(client, make_user, login):
    super_admin = login(make_user(roles=[("SUPER_ADMIN", None)]).email)
    founder = login(make_user(roles=[("FOUNDER_CEO", None)]).email)
    body = new_user_body(is_recovery_account=True, scopes=[{"role_code": "SUPER_ADMIN", "branch_id": None}])

    assert client.post(USERS, json=body, headers=super_admin).status_code == 403
    assert client.post(USERS, json=body, headers=founder).status_code == 201


# ---------------------------------------------------------------- scopes

def test_grant_list_and_revoke_scopes(client, make_user, login):
    headers = login(make_user().email)
    target = make_user(roles=[("SALES", 1)])
    scopes_url = f"{USERS}/{target.user_id}/scopes"

    granted = client.post(scopes_url, json={"role_code": "BRANCH_MANAGER", "branch_id": 2}, headers=headers)
    assert granted.status_code == 201
    assert client.post(scopes_url, json={"role_code": "BRANCH_MANAGER", "branch_id": 2}, headers=headers).status_code == 409

    scope_id = granted.get_json()["data"]["scope_id"]
    revoked = client.delete(f"{scopes_url}/{scope_id}", headers=headers)
    assert revoked.status_code == 200
    assert revoked.get_json()["data"]["status"] == "revoked"
    assert client.delete(f"{scopes_url}/{scope_id}", headers=headers).status_code == 422

    statuses = {(s["role_code"], s["status"]) for s in client.get(scopes_url, headers=headers).get_json()["data"]}
    assert statuses == {("SALES", "active"), ("BRANCH_MANAGER", "revoked")}


def test_temporary_access_expires_and_can_be_granted_again(client, make_user, login, run_sql):
    headers = login(make_user().email)
    target = make_user(roles=[("SALES", 1)])
    scopes_url = f"{USERS}/{target.user_id}/scopes"

    first = client.post(scopes_url, json={"role_code": "ACCOUNTS", "branch_id": 1,
                                          "expires_at": "2099-01-01T00:00:00+05:30"}, headers=headers)
    assert first.status_code == 201
    past = client.post(scopes_url, json={"role_code": "ACCOUNTS", "branch_id": 2,
                                         "expires_at": "2020-01-01T00:00:00+05:30"}, headers=headers)
    assert past.status_code == 400

    run_sql("UPDATE user_role_scopes SET expires_at = now() - interval '1 day' WHERE scope_id = :s",
            s=first.get_json()["data"]["scope_id"])
    again = client.post(scopes_url, json={"role_code": "ACCOUNTS", "branch_id": 1}, headers=headers)

    assert again.status_code == 201
    statuses = sorted(s["status"] for s in client.get(scopes_url, headers=headers).get_json()["data"])
    assert statuses == ["active", "active", "revoked"]


def test_admins_cannot_change_their_own_access(client, make_user, login):
    admin = make_user()
    headers = login(admin.email)

    assert client.post(f"{USERS}/{admin.user_id}/scopes", json={"role_code": "SALES", "branch_id": 1},
                       headers=headers).status_code == 403


# ---------------------------------------------------------------- update / deactivate / reset

def test_deactivating_a_user_signs_them_out(client, make_user, login):
    admin = make_user()
    admin_headers = login(admin.email)
    target = make_user(roles=[("SALES", 1)])
    target_headers = login(target.email)

    response = client.patch(f"{USERS}/{target.user_id}", json={"is_active": False, "phone": "+919000000001"},
                            headers=admin_headers)

    assert response.status_code == 200
    assert response.get_json()["data"]["phone"] == "+919000000001"
    assert client.get("/api/v1/auth/me", headers=target_headers).status_code == 401
    assert client.patch(f"{USERS}/{admin.user_id}", json={"is_active": False}, headers=admin_headers).status_code == 403
    assert client.patch(f"{USERS}/{target.user_id}", json={}, headers=admin_headers).status_code == 400


def test_reset_password_unlocks_and_forces_a_change(client, make_user, login, run_sql):
    admin = make_user()
    admin_headers = login(admin.email)
    target = make_user(roles=[("SALES", 1)])
    target_headers = login(target.email)
    run_sql("UPDATE users SET locked_until = now() + interval '1 hour' WHERE user_id = :u", u=target.user_id)

    response = client.post(f"{USERS}/{target.user_id}/reset-password", headers=admin_headers)
    temporary = response.get_json()["data"]["temporary_password"]

    assert response.status_code == 200
    assert client.get("/api/v1/auth/me", headers=target_headers).status_code == 401
    relogin = client.post("/api/v1/auth/login", json={"email": target.email, "password": temporary})
    assert relogin.status_code == 200
    assert relogin.get_json()["data"]["user"]["must_change_password"] is True
    assert client.post(f"{USERS}/{admin.user_id}/reset-password", headers=admin_headers).status_code == 403


# ---------------------------------------------------------------- list / get

def test_list_users_filters_and_paginates(client, make_user, login):
    headers = login(make_user(full_name="Admin").email)
    make_user(full_name="Sravani", roles=[("SALES", 1)])
    make_user(full_name="Mounika", roles=[("SALES", 2)])
    make_user(full_name="Nikhil", roles=[("SALES", 2)], is_active=False)

    by_role_branch = client.get(f"{USERS}?role=SALES&branch_id=2", headers=headers).get_json()
    active_only = client.get(f"{USERS}?role=SALES&branch_id=2&is_active=true", headers=headers).get_json()
    by_search = client.get(f"{USERS}?q=srav", headers=headers).get_json()
    first_page = client.get(f"{USERS}?per_page=2", headers=headers).get_json()

    assert [u["full_name"] for u in by_role_branch["data"]] == ["Mounika", "Nikhil"]
    assert [u["full_name"] for u in active_only["data"]] == ["Mounika"]
    assert [u["full_name"] for u in by_search["data"]] == ["Sravani"]
    assert first_page["meta"] == {"page": 1, "per_page": 2, "total": 4, "pages": 2}


def test_get_unknown_user_is_404(client, make_user, login):
    headers = login(make_user().email)

    assert client.get(f"{USERS}/999999", headers=headers).status_code == 404


def test_roles_and_branches_for_any_logged_in_user(client, make_user, login):
    headers = login(make_user(roles=[("SALES", 1)]).email)

    roles = client.get("/api/v1/roles", headers=headers).get_json()["data"]
    branches = client.get("/api/v1/branches", headers=headers).get_json()["data"]

    assert {"SALES", "FRONT_OFFICE", "FOUNDER_CEO", "STUDENT"} <= {r["role_code"] for r in roles}
    assert [b["branch_code"] for b in branches] == ["NIT-GNT", "NIT-VIJ"]


# ---------------------------------------------------------------- CLI

def test_create_admin_command(app):
    runner = app.test_cli_runner()
    args = ["create-admin", "--email", "Founder@Nipuna.test", "--name", "Founder", "--password", PASSWORD]

    created = runner.invoke(args=args)
    duplicate = runner.invoke(args=args)
    weak = runner.invoke(args=["create-admin", "--email", "x@nipuna.test", "--name", "X", "--password", "short"])

    assert created.exit_code == 0, created.output
    assert duplicate.exit_code == 1 and "already exists" in duplicate.output
    assert weak.exit_code == 1 and "at least 10 characters" in weak.output
    user = db.session.execute(select(User).where(User.email == "founder@nipuna.test")).scalar_one()
    assert [s.role.role_code for s in user.scopes] == ["FOUNDER_CEO"]
    assert user.must_change_password is False


# ---------------------------------------------------------------- staff directory (dropdowns)

def test_staff_directory_is_branch_scoped(client, people, make_user):
    make_user(roles=[("SALES", 1)], full_name="Inactive Sales", is_active=False)
    sales_gnt = client.get("/api/v1/staff?role=SALES,FRONT_OFFICE", headers=people["sravani"]["h"]).get_json()["data"]
    assert {s["full_name"] for s in sales_gnt} == {"Sravani", "Nikhil"}
    assert sales_gnt[0]["roles"][0]["branch_code"] == "NIT-GNT"

    trainers = client.get("/api/v1/staff?role=TRAINER&branch_id=1", headers=people["admin"]["h"]).get_json()["data"]
    assert [s["full_name"] for s in trainers] == ["Trainer G1"]
    everyone_vij = client.get("/api/v1/staff?branch_id=2", headers=people["admin"]["h"]).get_json()["data"]
    names = {s["full_name"] for s in everyone_vij}
    assert {"Mounika", "BM Vijayawada", "Admin", "Founder"} <= names and "Sravani" not in names

    assert client.get("/api/v1/staff?branch_id=2", headers=people["sravani"]["h"]).status_code == 404
    assert client.get("/api/v1/staff?branch_id=x", headers=people["sravani"]["h"]).status_code == 400
    assert client.get("/api/v1/staff").status_code == 401
