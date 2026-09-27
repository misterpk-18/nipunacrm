"""Query helpers shared by repositories."""
from sqlalchemy import Select, text

from config.database import db


def paginate(stmt: Select, page: int, per_page: int) -> tuple[list, dict]:
    result = db.paginate(stmt, page=page, per_page=per_page, error_out=False, max_per_page=None)
    meta = {"page": page, "per_page": per_page, "total": result.total, "pages": result.pages}
    return result.items, meta


def set_db_user(user_id: int) -> None:
    """SET LOCAL app.current_user_id, so triggers credit stage changes, task completions etc. to this user."""
    db.session.execute(
        text("SELECT set_config('app.current_user_id', :user_id, true)"),
        {"user_id": str(user_id)},
    )
