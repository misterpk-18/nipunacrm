from controllers.common import Validator, json_body, no_content, ok
from services import auth as auth_service
from services.context import current_user


def _profile(user, scopes, branches, home_route) -> dict:
    return {
        "user": user.to_dict(include_scopes=False),
        "scopes": [s.to_dict() for s in scopes],
        "allowed_branches": [b.to_summary() for b in branches],
        "home_route": home_route,
    }


def login():
    v = Validator(json_body())
    v.email("email", required=True)
    v.string("password", required=True, max_length=200, strip=False)
    data = v.validate()

    result = auth_service.login(data["email"], data["password"])
    profile = _profile(*auth_service.profile(result.current))
    return ok({"token": result.token, "expires_at": result.session.expires_at, **profile})


def logout():
    auth_service.logout()
    return no_content()


def me():
    return ok(_profile(*auth_service.profile()))


def reauthenticate():
    v = Validator(json_body())
    v.string("password", required=True, max_length=200, strip=False)
    auth_service.reauthenticate(v.validate()["password"])
    return no_content()


def change_password():
    v = Validator(json_body())
    v.string("current_password", required=True, max_length=200, strip=False)
    v.string("new_password", required=True, max_length=200, strip=False)
    data = v.validate()

    auth_service.change_password(data["current_password"], data["new_password"])
    return no_content()


def list_sessions():
    session_id = current_user().session_id
    return ok([s.to_dict(current_session_id=session_id) for s in auth_service.list_sessions()])


def revoke_session(session_id: str):
    auth_service.revoke_session(session_id)
    return no_content()
