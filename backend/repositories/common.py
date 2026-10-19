"""Query helpers shared by repositories."""
import re

from sqlalchemy import Select, bindparam, select, text as sa_text
from sqlalchemy.types import NullType
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import TextClause

from config.database import db


_BIND = re.compile(r"(?<![:\w\\]):(\w+)(?!:)")


def text(sql: str):
    """sqlalchemy.text() whose :named binds are untyped, so psycopg sends strings as unknown and Postgres resolves
    them against the column (an enum column cannot be compared to the VARCHAR cast SQLAlchemy adds to str binds)."""
    return sa_text(sql).bindparams(*[bindparam(name, type_=NullType()) for name in dict.fromkeys(_BIND.findall(sql))])


def raw_select(model, query: TextClause, params: dict, order_by: str) -> Select:
    """A Select over a raw-SQL query that returns the model's own columns (SELECT alias.* ...).

    Keeps list endpoints working with paginate(), .limit() and execute(...).scalars() while the SQL itself stays
    plain text with :named placeholders. order_by is a fixed SQL literal (never request input). The raw SQL and
    its params ride along as execution options so a totals query can wrap them (see raw_parts)."""
    sub = text(query.text).bindparams(**params).columns(*model.__table__.c).subquery()
    return select(aliased(model, sub)).order_by(text(order_by)).execution_options(raw_sql=query.text, raw_params=params)


def raw_parts(stmt: Select) -> tuple[str, dict]:
    """The (SQL, params) a raw_select() was built from, to use as a subquery in a totals query."""
    options = stmt.get_execution_options()
    return options["raw_sql"], options["raw_params"]


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
