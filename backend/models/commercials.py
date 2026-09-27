"""Payment plans, Offer Master and concession approval limits."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import Role
from models.courses import Course
from models.enums import OfferBenefitType, OfferStatus
from models.masters import Branch


class PaymentPlan(db.Model):
    __tablename__ = "payment_plans"

    payment_plan_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_code: Mapped[str] = mapped_column(String(30), unique=True)
    plan_name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    installments: Mapped[list["PaymentPlanInstallment"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="PaymentPlanInstallment.installment_no"
    )

    def to_dict(self) -> dict:
        return {
            "payment_plan_id": self.payment_plan_id,
            "plan_code": self.plan_code,
            "plan_name": self.plan_name,
            "description": self.description,
            "is_active": self.is_active,
            "installments": [i.to_dict() for i in self.installments],
        }


class PaymentPlanInstallment(db.Model):
    __tablename__ = "payment_plan_installments"

    payment_plan_id: Mapped[int] = mapped_column(Integer, ForeignKey("payment_plans.payment_plan_id"), primary_key=True)
    installment_no: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    percent_of_fee: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    due_days_after_admission: Mapped[int] = mapped_column(SmallInteger, default=0)
    due_days_min: Mapped[int] = mapped_column(SmallInteger)
    due_days_max: Mapped[int] = mapped_column(SmallInteger)

    def to_dict(self) -> dict:
        return {
            "installment_no": self.installment_no,
            "percent_of_fee": self.percent_of_fee,
            "due_days_after_admission": self.due_days_after_admission,
            "due_days_min": self.due_days_min,
            "due_days_max": self.due_days_max,
        }


class Offer(db.Model):
    """Offer Master campaign version. Editing an Active offer means creating a new version."""

    __tablename__ = "offers"

    offer_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    offer_code: Mapped[str] = mapped_column(String(30))
    version: Mapped[int] = mapped_column(SmallInteger, default=1)
    offer_name: Mapped[str] = mapped_column(String(150))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(OfferStatus, default="Draft")
    benefit_type: Mapped[str] = mapped_column(OfferBenefitType)
    discount_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    discount_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    applies_to_all_branches: Mapped[bool] = mapped_column(Boolean, default=True)
    applies_to_all_courses: Mapped[bool] = mapped_column(Boolean, default=False)
    allows_stacking: Mapped[bool] = mapped_column(Boolean, default=False)
    qualifying_payment_rule: Mapped[str | None] = mapped_column(String(255))
    valid_from: Mapped[date | None] = mapped_column(Date)
    valid_to: Mapped[date | None] = mapped_column(Date)
    approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    branch_links: Mapped[list["OfferBranch"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    course_links: Mapped[list["OfferCourse"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    complimentary_courses: Mapped[list["OfferComplimentaryCourse"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )

    EDITABLE_STATUSES = ("Draft", "Configured")

    def to_dict(self) -> dict:
        return {
            "offer_id": self.offer_id,
            "offer_code": self.offer_code,
            "version": self.version,
            "offer_name": self.offer_name,
            "description": self.description,
            "status": self.status,
            "benefit_type": self.benefit_type,
            "discount_amount": self.discount_amount,
            "discount_percent": self.discount_percent,
            "applies_to_all_branches": self.applies_to_all_branches,
            "branch_ids": sorted(link.branch_id for link in self.branch_links),
            "applies_to_all_courses": self.applies_to_all_courses,
            "courses": [link.course.to_summary() for link in self.course_links],
            "complimentary_courses": [c.to_dict() for c in self.complimentary_courses],
            "allows_stacking": self.allows_stacking,
            "qualifying_payment_rule": self.qualifying_payment_rule,
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "approved_by": self.approved_by,
            "approved_at": self.approved_at,
            "created_by": self.created_by,
            "created_at": self.created_at,
        }


class OfferBranch(db.Model):
    __tablename__ = "offer_branches"

    offer_id: Mapped[int] = mapped_column(Integer, ForeignKey("offers.offer_id"), primary_key=True)
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"), primary_key=True)

    branch: Mapped[Branch] = relationship(lazy="joined")


class OfferCourse(db.Model):
    __tablename__ = "offer_courses"

    offer_id: Mapped[int] = mapped_column(Integer, ForeignKey("offers.offer_id"), primary_key=True)
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"), primary_key=True)

    course: Mapped[Course] = relationship(lazy="joined")


class OfferComplimentaryCourse(db.Model):
    """Free course when the final agreed fee reaches min_final_fee (e.g. Advanced Excel at ≥ ₹15,000)."""

    __tablename__ = "offer_complimentary_courses"

    offer_id: Mapped[int] = mapped_column(Integer, ForeignKey("offers.offer_id"), primary_key=True)
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"), primary_key=True)
    min_final_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    access_period_days: Mapped[int | None] = mapped_column(Integer)

    course: Mapped[Course] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {**self.course.to_summary(), "min_final_fee": self.min_final_fee,
                "access_period_days": self.access_period_days}


class ConcessionLimit(db.Model):
    """Max extra concession a role may approve: the lower of max_percent and max_amount. Both NULL = unlimited."""

    __tablename__ = "concession_limits"

    role_id: Mapped[int] = mapped_column(Integer, ForeignKey("roles.role_id"), primary_key=True)
    max_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    max_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    role: Mapped[Role] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {
            "role_code": self.role.role_code,
            "role_name": self.role.role_name,
            "max_percent": self.max_percent,
            "max_amount": self.max_amount,
            "unlimited": self.max_percent is None and self.max_amount is None,
        }
