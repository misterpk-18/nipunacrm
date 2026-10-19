"""Fee discussions, versions, special closing requests, and approver limits."""
from sqlalchemy import Select, select

from config.database import db
from models import ConcessionLimit, FeeDiscussion, Offer, SpecialClosingRequest
from repositories.common import raw_select, text


def discussions_for_lead(lead_id: int) -> list[FeeDiscussion]:
    sql = text("""
        SELECT fd.*
        FROM fee_discussions fd
        WHERE fd.lead_id = :lead_id
        ORDER BY fd.fee_discussion_id
    """)
    return list(db.session.execute(select(FeeDiscussion).from_statement(sql), {"lead_id": lead_id}).scalars())


def open_discussion(lead_id: int, course_id: int) -> FeeDiscussion | None:
    sql = text("""
        SELECT fd.*
        FROM fee_discussions fd
        WHERE fd.lead_id = :lead_id AND fd.course_id = :course_id
          AND NOT (CAST(fd.milestone AS text) = ANY(:closed_milestones))
    """)
    params = {"lead_id": lead_id, "course_id": course_id, "closed_milestones": list(FeeDiscussion.CLOSED_MILESTONES)}
    return db.session.execute(select(FeeDiscussion).from_statement(sql), params).scalars().first()


def applicable_offers(branch_id: int, course_id: int, on_date) -> list[Offer]:
    """Active offers valid on the date whose scope covers the branch and course."""
    sql = text("""
        SELECT o.*
        FROM offers o
        WHERE o.status = 'Active' AND o.valid_from <= :on_date AND o.valid_to >= :on_date
          AND (o.applies_to_all_branches
               OR o.offer_id IN (SELECT ob.offer_id FROM offer_branches ob WHERE ob.branch_id = :branch_id))
          AND (o.applies_to_all_courses
               OR o.offer_id IN (SELECT oc.offer_id FROM offer_courses oc WHERE oc.course_id = :course_id))
        ORDER BY o.offer_code
    """)
    params = {"on_date": on_date, "branch_id": branch_id, "course_id": course_id}
    return list(db.session.execute(select(Offer).from_statement(sql), params).scalars())


def offers_by_ids(ids: list[int]) -> list[Offer]:
    if not ids:
        return []
    sql = text("SELECT o.* FROM offers o WHERE o.offer_id = ANY(:ids)")
    return list(db.session.execute(select(Offer).from_statement(sql), {"ids": list(ids)}).scalars())


def concession_limits() -> list[ConcessionLimit]:
    sql = text("""
        SELECT cl.*
        FROM concession_limits cl
        JOIN roles r ON r.role_id = cl.role_id
        ORDER BY r.role_id
    """)
    return list(db.session.execute(select(ConcessionLimit).from_statement(sql)).scalars().unique())


def used_offers(person_id: int) -> list[dict]:
    """Offers the person has already used (one row per offer code, earliest admission), from person_offer_redemptions."""
    rows = db.session.execute(text(
        "SELECT DISTINCT ON (offer_code) offer_code, admission_id, admission_code, used_as "
        "FROM person_offer_redemptions WHERE person_id = :person_id ORDER BY offer_code, admission_id"),
        {"person_id": person_id}).mappings()
    return [dict(row) for row in rows]


def approver_limits(user_id: int, branch_id: int) -> list[ConcessionLimit]:
    """Concession limits of every role the user holds at this branch (or company-wide)."""
    sql = text("""
        SELECT cl.*
        FROM concession_limits cl
        JOIN roles r ON r.role_id = cl.role_id
        JOIN user_role_scopes urs ON urs.role_id = r.role_id
        WHERE urs.user_id = :user_id
          AND urs.revoked_at IS NULL AND (urs.expires_at IS NULL OR urs.expires_at > now())
          AND (urs.branch_id IS NULL OR urs.branch_id = :branch_id)
    """)
    params = {"user_id": user_id, "branch_id": branch_id}
    return list(db.session.execute(select(ConcessionLimit).from_statement(sql), params).scalars().unique())


def scr_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("fd.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        conditions.append("fd.branch_id = :branch_id")
        params["branch_id"] = filters["branch_id"]
    if filters.get("status"):
        conditions.append("scr.status = :status")
        params["status"] = filters["status"]
    sql = text("""
        SELECT scr.*
        FROM special_closing_requests scr
        JOIN fee_discussion_versions fdv ON fdv.version_id = scr.version_id
        JOIN fee_discussions fd ON fd.fee_discussion_id = fdv.fee_discussion_id
        WHERE """ + " AND ".join(conditions))
    return raw_select(SpecialClosingRequest, sql, params, "decision_due_at, scr_id")
