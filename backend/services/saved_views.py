"""Saved list filters: shared views (seeded or made by managers) plus each user's own."""
from sqlalchemy import or_, select

from config.database import db
from models import SavedView
from services import audit
from services.context import current_user
from services.errors import Forbidden, NotFound


def list_views(module: str) -> list[SavedView]:
    stmt = (
        select(SavedView)
        .where(SavedView.module == module,
               or_(SavedView.user_id.is_(None), SavedView.user_id == current_user().user_id))
        .order_by(SavedView.user_id.is_not(None), SavedView.sort_order, SavedView.name)
    )
    return list(db.session.execute(stmt).scalars())


def _can_share() -> bool:
    user = current_user()
    return user.is_admin or user.has_role("BRANCH_MANAGER")


def create_view(data: dict) -> SavedView:
    shared = data.pop("shared", False)
    if shared and not _can_share():
        raise Forbidden("Only admins and branch managers can create shared views")
    view = SavedView(user_id=None if shared else current_user().user_id, module=data["module"], name=data["name"],
                     filters=data["filters"])
    db.session.add(view)
    db.session.flush()
    if shared:
        audit.record("SAVED_VIEW_SHARED", "saved_view", view.saved_view_id, new=view.to_dict())
    return view


def delete_view(view_id: int) -> None:
    view = db.session.get(SavedView, view_id)
    user = current_user()
    if view is None or (view.user_id is not None and view.user_id != user.user_id):
        raise NotFound("Saved view not found")
    if view.user_id is None:
        if not user.is_admin:
            raise Forbidden("Only admins can delete shared views")
        audit.record("SAVED_VIEW_DELETED", "saved_view", view_id, old=view.to_dict())
    db.session.delete(view)
    db.session.flush()
