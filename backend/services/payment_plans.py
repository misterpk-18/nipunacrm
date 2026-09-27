"""Payment plan templates (installments as % of fee with due-day windows)."""
from decimal import Decimal

from sqlalchemy import select, text

from config.database import db
from models import PaymentPlan, PaymentPlanInstallment
from services import audit
from services.errors import BusinessRule, NotFound, ValidationError


def list_plans(include_inactive: bool) -> list[PaymentPlan]:
    stmt = select(PaymentPlan).order_by(PaymentPlan.payment_plan_id)
    if not include_inactive:
        stmt = stmt.where(PaymentPlan.is_active)
    return list(db.session.execute(stmt).scalars())


def get_plan(plan_id: int) -> PaymentPlan:
    plan = db.session.get(PaymentPlan, plan_id)
    if plan is None:
        raise NotFound("Payment plan not found")
    return plan


def create_plan(data: dict) -> PaymentPlan:
    installments = data.pop("installments")
    plan = PaymentPlan(**data, installments=_build_installments(installments))
    db.session.add(plan)
    db.session.flush()  # plan_code is unique
    audit.record("PAYMENT_PLAN_CREATED", "payment_plan", plan.payment_plan_id, new=plan.to_dict())
    return plan


def update_plan(plan_id: int, data: dict) -> PaymentPlan:
    plan = get_plan(plan_id)
    old = plan.to_dict()

    installments = data.pop("installments", None)
    if installments is not None:
        if _in_use(plan_id):
            raise BusinessRule("This plan is already used by fee discussions or admissions; "
                               "create a new plan instead of changing its installments")
        plan.installments = _build_installments(installments)

    for field, value in data.items():
        setattr(plan, field, value)
    db.session.flush()
    audit.record("PAYMENT_PLAN_UPDATED", "payment_plan", plan_id, old=old, new=plan.to_dict())
    return plan


def _build_installments(installments: list[dict]) -> list[PaymentPlanInstallment]:
    total = sum((i["percent_of_fee"] for i in installments), Decimal("0"))
    if total != Decimal("100"):
        raise ValidationError("Installments must add up to 100%", {"installments": [f"They add up to {total}%"]})

    rows = []
    for number, item in enumerate(installments, start=1):
        due = item["due_days_after_admission"]
        due_min = item.get("due_days_min", due)
        due_max = item.get("due_days_max", due)
        if not due_min <= due <= due_max:
            raise ValidationError("Due day must sit inside its window",
                                  {"installments": {str(number - 1): {"due_days_after_admission": ["Outside min / max"]}}})
        rows.append(PaymentPlanInstallment(installment_no=number, percent_of_fee=item["percent_of_fee"],
                                           due_days_after_admission=due, due_days_min=due_min, due_days_max=due_max))
    return rows


def _in_use(plan_id: int) -> bool:
    return db.session.execute(text(
        "SELECT EXISTS (SELECT 1 FROM admissions WHERE payment_plan_id = :id)"
        " OR EXISTS (SELECT 1 FROM fee_discussion_versions WHERE payment_plan_id = :id)"
    ), {"id": plan_id}).scalar()
