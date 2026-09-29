"""Fee discussions (one per lead + course), their frozen versions, and special closing requests."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.commercials import Offer, PaymentPlan
from models.courses import Course
from models.enums import CapacityReview, DeliveryMode, FeeDiscussionMilestone, FeeVersionStatus, ScrStatus, SeatType
from models.leads import Lead, user_summary
from models.masters import Branch


class FeeDiscussion(db.Model):
    __tablename__ = "fee_discussions"

    fee_discussion_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    discussion_code: Mapped[str] = mapped_column(String(20), unique=True)  # FD-00001, set by trigger
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    counsellor_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    milestone: Mapped[str] = mapped_column(FeeDiscussionMilestone, default="In Discussion")
    fee_shared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    lead: Mapped[Lead] = relationship(lazy="joined")
    course: Mapped[Course] = relationship(lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    counsellor: Mapped[User | None] = relationship(foreign_keys=[counsellor_id], lazy="joined")
    versions: Mapped[list["FeeDiscussionVersion"]] = relationship(
        foreign_keys="FeeDiscussionVersion.fee_discussion_id", lazy="selectin",
        order_by="FeeDiscussionVersion.version_no", back_populates="discussion",
    )

    CLOSED_MILESTONES = ("Converted", "Expired", "Cancelled")

    @property
    def current_version(self) -> "FeeDiscussionVersion | None":
        return self.versions[-1] if self.versions else None

    def to_summary(self) -> dict:
        return {"fee_discussion_id": self.fee_discussion_id, "discussion_code": self.discussion_code,
                "milestone": self.milestone}

    def to_dict(self) -> dict:
        current = self.current_version
        return {
            **self.to_summary(),
            "lead": self.lead.to_summary(),
            "person": self.lead.person.to_summary(),
            "course": {**self.course.to_summary(), "standard_fee": self.course.standard_fee},
            "branch": self.branch.to_summary(),
            "counsellor": user_summary(self.counsellor),
            "fee_shared_at": self.fee_shared_at,
            "current_version": current.to_dict() if current else None,
            "versions": [v.to_dict() for v in self.versions],
            "created_at": self.created_at,
        }


class FeeVersionInstallment(db.Model):
    """The version's payment schedule: a due date and amount per instalment (db 018). Frozen with the version."""

    __tablename__ = "fee_version_installments"

    version_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussion_versions.version_id"), primary_key=True)
    installment_no: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    due_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))

    def to_dict(self) -> dict:
        return {"installment_no": self.installment_no, "due_date": self.due_date, "amount": self.amount}


class FeeDiscussionVersion(db.Model):
    """v1, v2, ...: amounts are frozen once saved (trigger); status can change."""

    __tablename__ = "fee_discussion_versions"

    version_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fee_discussion_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussions.fee_discussion_id"))
    version_no: Mapped[int] = mapped_column(SmallInteger)  # set by trigger
    status: Mapped[str] = mapped_column(FeeVersionStatus, default="Discussion Saved")
    standard_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    offer_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("offers.offer_id"))
    offer_discount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    extra_concession: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    final_payable: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    minimum_floor: Mapped[Decimal] = mapped_column(Numeric(10, 2))  # default 70% of standard fee (trigger)
    payment_plan_id: Mapped[int] = mapped_column(Integer, ForeignKey("payment_plans.payment_plan_id"))
    valid_until: Mapped[date] = mapped_column(Date)  # default 7 days or offer end (trigger)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    discussion: Mapped[FeeDiscussion] = relationship(foreign_keys=[fee_discussion_id], back_populates="versions")
    offer: Mapped[Offer | None] = relationship(lazy="joined")
    payment_plan: Mapped[PaymentPlan] = relationship(lazy="joined")
    special_closing_requests: Mapped[list["SpecialClosingRequest"]] = relationship(
        lazy="selectin", order_by="SpecialClosingRequest.scr_id", back_populates="version"
    )
    installments: Mapped[list[FeeVersionInstallment]] = relationship(
        lazy="selectin", order_by=FeeVersionInstallment.installment_no, cascade="all, delete-orphan"
    )

    @property
    def is_below_floor(self) -> bool:
        return self.final_payable < self.minimum_floor

    @property
    def needs_special_closing(self) -> bool:
        return self.extra_concession > 0 or self.is_below_floor

    def to_dict(self) -> dict:
        return {
            "version_id": self.version_id,
            "fee_discussion_id": self.fee_discussion_id,
            "version_no": self.version_no,
            "status": self.status,
            "standard_fee": self.standard_fee,
            "offer": {"offer_id": self.offer.offer_id, "offer_code": self.offer.offer_code,
                      "offer_name": self.offer.offer_name} if self.offer else None,
            "offer_discount": self.offer_discount,
            "extra_concession": self.extra_concession,
            "final_payable": self.final_payable,
            "minimum_floor": self.minimum_floor,
            "below_floor": self.is_below_floor,
            "needs_special_closing": self.needs_special_closing,
            "payment_plan": {"payment_plan_id": self.payment_plan.payment_plan_id, "plan_code": self.payment_plan.plan_code,
                             "plan_name": self.payment_plan.plan_name},
            "installments": [i.to_dict() for i in self.installments],
            "valid_until": self.valid_until,
            "notes": self.notes,
            "special_closing_requests": [s.to_summary() for s in self.special_closing_requests],
            "created_by": self.created_by,
            "created_at": self.created_at,
        }


class SpecialClosingRequest(db.Model):
    """Extra concession approval. Decision due 5 staffed minutes after the request (trigger)."""

    __tablename__ = "special_closing_requests"

    scr_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scr_code: Mapped[str] = mapped_column(String(20), unique=True)  # SCR-00001, set by trigger
    version_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussion_versions.version_id"))
    requested_extra: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    request_reason: Mapped[str] = mapped_column(Text)
    requested_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    decision_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # set by trigger
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(ScrStatus, default="Pending")
    decided_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    counter_extra: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    independent_approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    independent_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    version: Mapped[FeeDiscussionVersion] = relationship(back_populates="special_closing_requests", lazy="joined")
    requester: Mapped[User] = relationship(foreign_keys=[requested_by], lazy="joined")
    decider: Mapped[User | None] = relationship(foreign_keys=[decided_by], lazy="joined")

    def to_summary(self) -> dict:
        return {"scr_id": self.scr_id, "scr_code": self.scr_code, "status": self.status,
                "requested_extra": self.requested_extra, "counter_extra": self.counter_extra}

    def to_dict(self) -> dict:
        version = self.version
        discussion = version.discussion
        return {
            **self.to_summary(),
            "version_id": self.version_id,
            "version_no": version.version_no,
            "fee_discussion": discussion.to_summary(),
            "lead": discussion.lead.to_summary(),
            "person": discussion.lead.person.to_summary(),
            "branch": discussion.branch.to_summary(),
            "standard_fee": version.standard_fee,
            "final_payable": version.final_payable,
            "minimum_floor": version.minimum_floor,
            "below_floor": version.is_below_floor,
            "request_reason": self.request_reason,
            "requested_by": user_summary(self.requester),
            "requested_at": self.requested_at,
            "decision_due_at": self.decision_due_at,
            "decided_by": user_summary(self.decider),
            "decided_at": self.decided_at,
            "decision_reason": self.decision_reason,
            "independent_approved_by": self.independent_approved_by,
            "independent_approved_at": self.independent_approved_at,
        }


class DeliveryPlan(db.Model):
    """Per course deal (db 020): DP-00001. Draft → accepted (student acceptance captured); accepted plans are frozen
    until reopened. Admissions take their service branch, mode, seat type and start from it."""

    __tablename__ = "delivery_plans"

    delivery_plan_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_code: Mapped[str] = mapped_column(String(20), unique=True)  # set by trigger
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"), unique=True)
    service_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    delivery_mode: Mapped[str] = mapped_column(DeliveryMode)
    seat_type: Mapped[str] = mapped_column(SeatType, default="Confirmed Seat")
    planned_start_date: Mapped[date | None] = mapped_column(Date)
    capacity_review: Mapped[str] = mapped_column(CapacityReview, default="Waiting")
    student_accepted: Mapped[bool] = mapped_column(Boolean, default=False)
    accepted_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    service_branch: Mapped[Branch] = relationship(lazy="joined")
    acceptor: Mapped[User | None] = relationship(foreign_keys=[accepted_by], lazy="joined")

    @property
    def status(self) -> str:
        return "Accepted" if self.accepted_at else "Draft"

    def to_dict(self) -> dict:
        return {
            "delivery_plan_id": self.delivery_plan_id, "plan_code": self.plan_code, "lead_id": self.lead_id,
            "status": self.status, "service_branch": self.service_branch.to_summary(),
            "delivery_mode": self.delivery_mode, "seat_type": self.seat_type,
            "planned_start_date": self.planned_start_date, "capacity_review": self.capacity_review,
            "student_accepted": self.student_accepted, "accepted_by": user_summary(self.acceptor),
            "accepted_at": self.accepted_at, "notes": self.notes, "updated_at": self.updated_at,
        }
