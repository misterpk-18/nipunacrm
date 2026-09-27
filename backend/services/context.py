"""The logged-in user for the current request.

Services read the actor from here instead of touching Flask's request directly.
"""
from dataclasses import dataclass

from flask import g, has_request_context, request

ADMIN_ROLES = ("FOUNDER_CEO", "SUPER_ADMIN")
COUNSELLOR_ROLES = ("SALES", "FRONT_OFFICE")
LEAD_ROLES = ADMIN_ROLES + ("BRANCH_MANAGER",) + COUNSELLOR_ROLES
MANAGER_ROLES = ADMIN_ROLES + ("BRANCH_MANAGER",)
# Demos: lead roles plus the academic side (trainers record outcomes, coordinators approve extra demos)
DEMO_ROLES = LEAD_ROLES + ("TRAINER", "ACADEMIC_COORDINATOR")
# Money: invoices, payments, collections
FINANCE_ROLES = LEAD_ROLES + ("ACCOUNTS",)
ACADEMIC_ROLES = MANAGER_ROLES + ("ACADEMIC_COORDINATOR",)
# Anyone on staff (everyone except students)
STAFF_ROLES = FINANCE_ROLES + ("ACADEMIC_COORDINATOR", "TRAINER", "PLACEMENT", "HR")


@dataclass(frozen=True)
class Scope:
    scope_id: int
    role_code: str
    role_name: str
    branch_id: int | None  # None = all branches
    is_company_wide: bool


@dataclass(frozen=True)
class CurrentUser:
    user_id: int
    email: str
    full_name: str
    session_id: str
    is_recovery_account: bool
    must_change_password: bool
    has_fresh_auth: bool
    scopes: tuple[Scope, ...]

    @property
    def role_codes(self) -> set[str]:
        return {s.role_code for s in self.scopes}

    @property
    def is_admin(self) -> bool:
        return bool(self.role_codes & set(ADMIN_ROLES))

    def has_role(self, *role_codes: str, branch_id: int | None = None) -> bool:
        """Holds any of these roles, for this branch (or company-wide). branch_id=None: any branch."""
        return any(
            s.role_code in role_codes and (s.branch_id is None or branch_id is None or s.branch_id == branch_id)
            for s in self.scopes
        )

    def branch_ids(self) -> set[int] | None:
        """Branches the user may see; None means all branches (company-wide role)."""
        if any(s.branch_id is None for s in self.scopes):
            return None
        return {s.branch_id for s in self.scopes}

    def can_access_branch(self, branch_id: int) -> bool:
        branch_ids = self.branch_ids()
        return branch_ids is None or branch_id in branch_ids

    def is_manager_of(self, branch_id: int) -> bool:
        """Admin, or Branch Manager of this branch."""
        return self.is_admin or self.has_role("BRANCH_MANAGER", branch_id=branch_id)


def set_current_user(user: CurrentUser) -> None:
    g.current_user = user


def current_user() -> CurrentUser | None:
    return g.get("current_user") if has_request_context() else None


def actor_id() -> int | None:
    user = current_user()
    return user.user_id if user else None


def client_ip() -> str | None:
    return request.remote_addr if has_request_context() else None


def client_user_agent() -> str | None:
    return request.user_agent.string if has_request_context() and request.user_agent else None
