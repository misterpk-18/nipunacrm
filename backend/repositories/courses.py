"""Course Master queries."""
from sqlalchemy import Select, exists, or_, select

from models import Branch, Course, CourseBranch


def list_stmt(filters: dict) -> Select:
    stmt = select(Course).order_by(Course.is_combo, Course.course_code)

    if filters.get("type") == "standalone":
        stmt = stmt.where(Course.is_combo.is_(False))
    elif filters.get("type") == "combo":
        stmt = stmt.where(Course.is_combo.is_(True))
    if filters.get("status"):
        stmt = stmt.where(Course.status == filters["status"])
    if filters.get("category"):
        stmt = stmt.where(Course.category == filters["category"])
    if filters.get("branch_id"):
        stmt = stmt.where(exists().where(
            CourseBranch.course_id == Course.course_id,
            CourseBranch.branch_code == select(Branch.branch_code).where(Branch.branch_id == filters["branch_id"]).scalar_subquery(),
        ))
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Course.course_code.ilike(pattern), Course.course_title.ilike(pattern)))
    return stmt
