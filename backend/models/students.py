"""Student records: documents (+ mandatory checklist view), certificates, support cases."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.courses import Course
from models.enums import CertificateStatus, DocumentStatus, SupportCaseStatus
from models.leads import Person, user_summary
from models.masters import Branch, DocumentType, SupportCaseType


class Document(db.Model):
    """One live file per person per type (re-upload only after rejection); review time stamped by trigger."""

    __tablename__ = "documents"

    document_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    admission_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    document_type_id: Mapped[int] = mapped_column(Integer, ForeignKey("document_types.document_type_id"))
    status: Mapped[str] = mapped_column(DocumentStatus, default="Review Required")
    file_path: Mapped[str] = mapped_column(String(500))
    original_filename: Mapped[str | None] = mapped_column(String(255))
    mime_type: Mapped[str | None] = mapped_column(String(100))
    file_size_bytes: Mapped[int | None] = mapped_column(Integer)
    uploaded_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    reviewed_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    document_type: Mapped[DocumentType] = relationship(lazy="joined")
    person: Mapped[Person] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {
            "document_id": self.document_id,
            "person_id": self.person_id,
            "admission_id": self.admission_id,
            "document_type": {"document_type_id": self.document_type_id, "code": self.document_type.code,
                              "label": self.document_type.label, "is_mandatory": self.document_type.is_mandatory},
            "status": self.status,
            "original_filename": self.original_filename,
            "mime_type": self.mime_type,
            "file_size_bytes": self.file_size_bytes,
            "uploaded_by": self.uploaded_by,
            "uploaded_at": self.uploaded_at,
            "reviewed_by": self.reviewed_by,
            "reviewed_at": self.reviewed_at,
            "rejection_reason": self.rejection_reason,
        }


class DocumentChecklist(db.Model):
    """Read-only view: each admitted person × each mandatory document type → Not Uploaded / Review Required / ..."""

    __tablename__ = "document_checklist"

    person_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_type_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_code: Mapped[str] = mapped_column(String(20))
    document_type: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(30))
    document_id: Mapped[int | None] = mapped_column(Integer)
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def to_dict(self) -> dict:
        return {"document_type_id": self.document_type_id, "document_type": self.document_type, "status": self.status,
                "document_id": self.document_id, "uploaded_at": self.uploaded_at}


class Certificate(db.Model):
    """One live certificate per admission per course; number assigned on issue (per service branch + FY)."""

    __tablename__ = "certificates"

    certificate_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    certificate_number: Mapped[str | None] = mapped_column(String(30), unique=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    status: Mapped[str] = mapped_column(CertificateStatus, default="Eligibility Pending")
    eligibility_notes: Mapped[str | None] = mapped_column(Text)
    file_path: Mapped[str | None] = mapped_column(String(500))
    issued_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    course: Mapped[Course] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {"certificate_id": self.certificate_id, "certificate_number": self.certificate_number,
                "admission_id": self.admission_id, "course": self.course.to_summary(), "status": self.status,
                "eligibility_notes": self.eligibility_notes, "issued_by": self.issued_by, "issued_at": self.issued_at,
                "revoked_by": self.revoked_by, "revoked_at": self.revoked_at, "revoke_reason": self.revoke_reason}


class SupportCase(db.Model):
    """SUP-00001 (trigger); resolving stamps resolved_at and needs resolution notes."""

    __tablename__ = "support_cases"

    CLOSED_STATUSES = ("Resolved", "Closed")

    support_case_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    case_code: Mapped[str] = mapped_column(String(20), unique=True)
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    admission_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    support_case_type_id: Mapped[int] = mapped_column(Integer, ForeignKey("support_case_types.support_case_type_id"))
    subject: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(SupportCaseStatus, default="Open")
    owner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    refund_case_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("refund_cases.refund_case_id"))
    resolution_notes: Mapped[str | None] = mapped_column(Text)
    opened_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    case_type: Mapped[SupportCaseType] = relationship(lazy="joined")
    owner: Mapped[User | None] = relationship(foreign_keys=[owner_user_id], lazy="joined")

    def to_dict(self) -> dict:
        return {"support_case_id": self.support_case_id, "case_code": self.case_code, "person": self.person.to_summary(),
                "admission_id": self.admission_id, "branch": self.branch.to_summary(),
                "case_type": self.case_type.label, "subject": self.subject, "description": self.description,
                "status": self.status, "owner": user_summary(self.owner), "refund_case_id": self.refund_case_id,
                "resolution_notes": self.resolution_notes, "opened_by": self.opened_by, "opened_at": self.opened_at,
                "resolved_at": self.resolved_at}
