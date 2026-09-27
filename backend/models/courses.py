"""Course Master: standalone courses, combos, and the branches offering them."""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.enums import CourseStatus
from models.masters import Branch


class Course(db.Model):
    __tablename__ = "courses"

    course_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    course_code: Mapped[str] = mapped_column(String(20), unique=True)
    course_title: Mapped[str] = mapped_column(String(255))
    category: Mapped[str] = mapped_column(String(100))
    standard_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    is_combo: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(CourseStatus, default="Active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    branch_links: Mapped[list["CourseBranch"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    component_links: Mapped[list["ComboCourse"]] = relationship(
        cascade="all, delete-orphan", foreign_keys="ComboCourse.combo_course_id", lazy="selectin",
        order_by="ComboCourse.sort_order",
    )

    def to_summary(self) -> dict:
        return {"course_id": self.course_id, "course_code": self.course_code, "course_title": self.course_title}

    def to_dict(self) -> dict:
        return {
            "course_id": self.course_id,
            "course_code": self.course_code,
            "course_title": self.course_title,
            "category": self.category,
            "standard_fee": self.standard_fee,
            "is_combo": self.is_combo,
            "status": self.status,
            "branches": sorted(link.branch_code for link in self.branch_links),
            "components": [link.to_dict() for link in self.component_links] if self.is_combo else [],
        }


class CourseBranch(db.Model):
    __tablename__ = "course_branches"

    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"), primary_key=True)
    branch_code: Mapped[str] = mapped_column(String(20), ForeignKey("branches.branch_code"), primary_key=True)

    branch: Mapped[Branch] = relationship(lazy="joined")


class ComboCourse(db.Model):
    """A standalone course inside a combo; is_bonus marks the "+1" in a 3+1 combo."""

    __tablename__ = "combo_courses"

    combo_course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"), primary_key=True)
    component_course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"), primary_key=True)
    is_bonus: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(SmallInteger, default=0)

    component: Mapped[Course] = relationship(foreign_keys=[component_course_id], lazy="joined")

    def to_dict(self) -> dict:
        return {**self.component.to_summary(), "is_bonus": self.is_bonus, "sort_order": self.sort_order}
