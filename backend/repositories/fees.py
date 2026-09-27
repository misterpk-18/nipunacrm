"""Fee discussions, versions, special closing requests, and approver limits."""
from sqlalchemy import Select, select

from config.database import db
from models import (
    ConcessionLimit, FeeDiscussion, FeeDiscussionVersion, Offer, OfferBranch, OfferCourse, Role, SpecialClosingRequest,
    UserRoleScope,
)
from repositories.users import _active_scope_condition


def discussions_for_lead(lead_id: int) -> list[FeeDiscussion]:
    stmt = select(FeeDiscussion).where(FeeDiscussion.lead_id == lead_id).order_by(FeeDiscussion.fee_discussion_id)
    return list(db.session.execute(stmt).scalars())


def open_discussion(lead_id: int, course_id: int) -> FeeDiscussion | None:
    stmt = select(FeeDiscussion).where(FeeDiscussion.lead_id == lead_id, FeeDiscussion.course_id == course_id,
                                       FeeDiscussion.milestone.not_in(FeeDiscussion.CLOSED_MILESTONES))
    return db.session.execute(stmt).scalars().first()


def applicable_offers(branch_id: int, course_id: int, on_date) -> list[Offer]:
    """Active offers valid on the date whose scope covers the branch and course."""
    stmt = (
        select(Offer)
        .where(Offer.status == "Active", Offer.valid_from <= on_date, Offer.valid_to >= on_date,
               Offer.applies_to_all_branches | Offer.offer_id.in_(
                   select(OfferBranch.offer_id).where(OfferBranch.branch_id == branch_id)),
               Offer.applies_to_all_courses | Offer.offer_id.in_(
                   select(OfferCourse.offer_id).where(OfferCourse.course_id == course_id)))
        .order_by(Offer.offer_code)
    )
    return list(db.session.execute(stmt).scalars())


def approver_limits(user_id: int, branch_id: int) -> list[ConcessionLimit]:
    """Concession limits of every role the user holds at this branch (or company-wide)."""
    stmt = (
        select(ConcessionLimit)
        .join(Role, Role.role_id == ConcessionLimit.role_id)
        .join(UserRoleScope, UserRoleScope.role_id == Role.role_id)
        .where(UserRoleScope.user_id == user_id, _active_scope_condition(),
               UserRoleScope.branch_id.is_(None) | (UserRoleScope.branch_id == branch_id))
    )
    return list(db.session.execute(stmt).scalars().unique())


def scr_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = (
        select(SpecialClosingRequest)
        .join(FeeDiscussionVersion, FeeDiscussionVersion.version_id == SpecialClosingRequest.version_id)
        .join(FeeDiscussion, FeeDiscussion.fee_discussion_id == FeeDiscussionVersion.fee_discussion_id)
        .order_by(SpecialClosingRequest.decision_due_at, SpecialClosingRequest.scr_id)
    )
    if branch_ids is not None:
        stmt = stmt.where(FeeDiscussion.branch_id.in_(branch_ids))
    if filters.get("branch_id"):
        stmt = stmt.where(FeeDiscussion.branch_id == filters["branch_id"])
    if filters.get("status"):
        stmt = stmt.where(SpecialClosingRequest.status == filters["status"])
    return stmt
