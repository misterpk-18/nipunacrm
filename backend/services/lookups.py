"""Dropdown lookups (sources, channels, entry methods, payment modes, lost reasons, task / document / support types)."""
from sqlalchemy import select

from config.database import db
from models import LOOKUPS
from models import enums
from services import audit
from services.errors import NotFound

ENUMS = {
    "lead_stages": enums.LEAD_STAGES,
    "intake_statuses": enums.INTAKE_STATUSES,
    "lead_priorities": enums.LEAD_PRIORITIES,
    "activity_types": enums.ACTIVITY_TYPES,
    "activity_directions": enums.ACTIVITY_DIRECTIONS,
    "course_statuses": enums.COURSE_STATUSES,
    "offer_statuses": enums.OFFER_STATUSES,
    "offer_benefit_types": enums.OFFER_BENEFIT_TYPES,
    "task_statuses": enums.TASK_STATUSES,
    "languages": enums.LANGUAGES,
}


def _model(lookup_type: str):
    model = LOOKUPS.get(lookup_type)
    if model is None:
        raise NotFound(f"Unknown lookup type '{lookup_type}'")
    return model


def _query(model, include_inactive: bool):
    stmt = select(model).order_by(model.sort_order, model.label)
    if not include_inactive:
        stmt = stmt.where(model.is_active)
    return list(db.session.execute(stmt).scalars())


def all_lookups() -> dict:
    """Every active dropdown list plus the fixed enum values, for one call on app start."""
    data = {lookup_type.replace("-", "_"): [row.to_dict() for row in _query(model, False)]
            for lookup_type, model in LOOKUPS.items()}
    data["enums"] = {name: list(values) for name, values in ENUMS.items()}
    return data


def list_type(lookup_type: str) -> list:
    return _query(_model(lookup_type), include_inactive=True)


def extra_fields(lookup_type: str) -> tuple[str, ...]:
    return _model(lookup_type).EXTRA_FIELDS


def create(lookup_type: str, data: dict):
    model = _model(lookup_type)
    row = model(**data)
    db.session.add(row)
    db.session.flush()
    audit.record("LOOKUP_CREATED", lookup_type, row.id, new=row.to_dict())
    return row


def update(lookup_type: str, row_id: int, data: dict):
    model = _model(lookup_type)
    row = db.session.get(model, row_id)
    if row is None:
        raise NotFound("Lookup value not found")
    old = row.to_dict()
    for field, value in data.items():
        setattr(row, field, value)
    db.session.flush()
    audit.record("LOOKUP_UPDATED", lookup_type, row.id, old=old, new=row.to_dict())
    return row
