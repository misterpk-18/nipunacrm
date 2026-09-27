"""Test setup.

- The test database (nipunacrm_test) is rebuilt from db/*.sql once per test run.
- Each test runs inside a transaction that is rolled back afterwards; commits made by
  the request hooks become savepoint releases, so nothing leaks between tests.
"""
import itertools
from types import SimpleNamespace

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import scoped_session, sessionmaker

from app import create_app
from cli.database import rebuild_database
from config.database import db
from config.settings import TestingConfig
from models import Role, User, UserRoleScope
from services.security import hash_password


@pytest.fixture(scope="session", autouse=True)
def test_database():
    rebuild_database(TestingConfig.SQLALCHEMY_DATABASE_URI, TestingConfig.MIGRATIONS_DIR)


@pytest.fixture
def app():
    app = create_app("test")
    with app.app_context():
        connection = db.engine.connect()
        transaction = connection.begin()
        original_session = db.session
        # A plain SQLAlchemy session: Flask-SQLAlchemy's Session.get_bind ignores `bind` and
        # would route straight to the engine, escaping the test transaction.
        db.session = scoped_session(sessionmaker(bind=connection, join_transaction_mode="create_savepoint"))

        yield app

        db.session.remove()
        db.session = original_session
        transaction.rollback()
        connection.close()
        db.engine.dispose()


@pytest.fixture
def client(app):
    return app.test_client()


# ---------------------------------------------------------------- auth helpers

PASSWORD = "Correct-horse-1"


def _commit():
    """Release the test savepoint so setup data survives a failed (rolled-back) request."""
    db.session.commit()


@pytest.fixture
def run_sql(app):
    def _run(statement: str, **params):
        result = db.session.execute(text(statement), params)
        _commit()
        return result

    return _run


@pytest.fixture
def make_user(app):
    """make_user(roles=[("SALES", 1)], email=..., password=..., **user_columns) -> SimpleNamespace(user_id, email)."""
    counter = itertools.count(1)

    def _make(roles=(("SUPER_ADMIN", None),), email=None, password=PASSWORD, **columns):
        n = next(counter)
        user = User(
            full_name=columns.pop("full_name", f"Test User {n}"),
            email=email or f"user{n}@nipuna.test",
            password_hash=hash_password(password),
            **columns,
        )
        db.session.add(user)
        db.session.flush()
        for role_code, branch_id in roles:
            role_id = db.session.execute(select(Role.role_id).where(Role.role_code == role_code)).scalar_one()
            db.session.add(UserRoleScope(user_id=user.user_id, role_id=role_id, branch_id=branch_id))
        db.session.flush()
        created = SimpleNamespace(user_id=user.user_id, email=user.email)
        _commit()
        return created

    return _make


@pytest.fixture
def login(client):
    """login(email, password) -> Authorization header dict."""

    def _login(email, password=PASSWORD):
        response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
        assert response.status_code == 200, response.get_json()
        return {"Authorization": f"Bearer {response.get_json()['data']['token']}"}

    return _login


# ---------------------------------------------------------------- shared domain fixtures

@pytest.fixture
def course(app):
    """Data Science (₹30,000), offered at Guntur only."""
    from models import Course, CourseBranch

    course = Course(course_code="NIT-CRS-018", course_title="Data Science", category="Data & Analytics",
                    standard_fee=30000, branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(course)
    db.session.commit()
    return course.course_id


@pytest.fixture
def people(make_user, login):
    """Guntur BM + two Guntur counsellors, a Vijayawada counsellor, an admin, an accounts user, and more."""
    users = {
        "bm": make_user(roles=[("BRANCH_MANAGER", 1)], full_name="BM Guntur"),
        "sravani": make_user(roles=[("SALES", 1)], full_name="Sravani"),
        "nikhil": make_user(roles=[("FRONT_OFFICE", 1)], full_name="Nikhil"),
        "mounika": make_user(roles=[("SALES", 2)], full_name="Mounika"),
        "admin": make_user(roles=[("SUPER_ADMIN", None)], full_name="Admin"),
        "accounts": make_user(roles=[("ACCOUNTS", 1)], full_name="Accounts"),
        "founder": make_user(roles=[("FOUNDER_CEO", None)], full_name="Founder"),
        "trainer": make_user(roles=[("TRAINER", 1)], full_name="Trainer G1"),
        "coordinator": make_user(roles=[("ACADEMIC_COORDINATOR", 1)], full_name="Coordinator G"),
        "bm_vij": make_user(roles=[("BRANCH_MANAGER", 2)], full_name="BM Vijayawada"),
        "accounts_vij": make_user(roles=[("ACCOUNTS", 2)], full_name="Accounts VIJ"),
        "placement": make_user(roles=[("PLACEMENT", 1)], full_name="Placement G"),
    }
    return {name: {"id": u.user_id, "h": login(u.email)} for name, u in users.items()}
