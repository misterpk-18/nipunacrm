"""Course Master queries."""
from sqlalchemy import Select

from models import Course
from repositories.common import raw_select, text


def list_stmt(filters: dict) -> Select:
    conditions = ["TRUE"]
    params = {}

    if filters.get("type") == "standalone":
        conditions.append("c.is_combo IS FALSE")
    elif filters.get("type") == "combo":
        conditions.append("c.is_combo IS TRUE")
    if filters.get("status"):
        conditions.append("c.status = :status")
        params["status"] = filters["status"]
    if filters.get("category"):
        conditions.append("c.category = :category")
        params["category"] = filters["category"]
    if filters.get("branch_id"):
        conditions.append("""EXISTS (SELECT 1 FROM course_branches cb WHERE cb.course_id = c.course_id
                             AND cb.branch_code = (SELECT b.branch_code FROM branches b WHERE b.branch_id = :branch_id))""")
        params["branch_id"] = filters["branch_id"]
    if filters.get("q"):
        conditions.append("(c.course_code ILIKE :pattern OR c.course_title ILIKE :pattern)")
        params["pattern"] = f"%{filters['q']}%"
    sql = text("SELECT c.* FROM courses c WHERE " + " AND ".join(conditions))
    return raw_select(Course, sql, params, "is_combo, course_code")
