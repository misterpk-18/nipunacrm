"""AI Copilot outputs: insights (briefs, explanations, suggested messages), Ask Nipuna queries, feedback.

Everything stored here is advisory and marked as needing human review.
"""
from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from config.database import db
from models.enums import AiFeedbackRating, AiInsightType, AppLanguage, LeadPriority


class AiInsight(db.Model):
    __tablename__ = "ai_insights"

    insight_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    insight_type: Mapped[str] = mapped_column(AiInsightType)
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    person_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("persons.person_id"))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    for_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    content: Mapped[str] = mapped_column(Text)
    suggested_message: Mapped[str | None] = mapped_column(Text)
    score: Mapped[int | None] = mapped_column(SmallInteger)
    priority: Mapped[str | None] = mapped_column(LeadPriority)
    language: Mapped[str] = mapped_column(AppLanguage, default="English")
    evidence_as_of: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sources: Mapped[Any] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(String(100))
    requires_human_review: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"insight_id": self.insight_id, "insight_type": self.insight_type, "lead_id": self.lead_id,
                "person_id": self.person_id, "branch_id": self.branch_id, "for_user_id": self.for_user_id,
                "content": self.content, "suggested_message": self.suggested_message, "score": self.score,
                "priority": self.priority, "language": self.language, "evidence_as_of": self.evidence_as_of,
                "sources": self.sources, "model": self.model, "requires_human_review": self.requires_human_review,
                "created_at": self.created_at}


class AiQuery(db.Model):
    """Ask Nipuna: question + scope → recorded facts, possible explanation, missing evidence, sources, freshness."""

    __tablename__ = "ai_queries"

    query_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    question: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(AppLanguage, default="English")
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    period_start: Mapped[date | None] = mapped_column(Date)
    period_end: Mapped[date | None] = mapped_column(Date)
    report_cutoff_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    answer: Mapped[str | None] = mapped_column(Text)
    recorded_facts: Mapped[str | None] = mapped_column(Text)
    possible_explanation: Mapped[str | None] = mapped_column(Text)
    missing_evidence: Mapped[str | None] = mapped_column(Text)
    data_freshness: Mapped[str | None] = mapped_column(Text)
    sources: Mapped[Any] = mapped_column(JSONB)
    supporting_table: Mapped[Any] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"query_id": self.query_id, "user_id": self.user_id, "question": self.question,
                "language": self.language, "branch_id": self.branch_id, "period_start": self.period_start,
                "period_end": self.period_end, "report_cutoff_at": self.report_cutoff_at, "answer": self.answer,
                "recorded_facts": self.recorded_facts, "possible_explanation": self.possible_explanation,
                "missing_evidence": self.missing_evidence, "data_freshness": self.data_freshness,
                "sources": self.sources, "supporting_table": self.supporting_table, "model": self.model,
                "requires_human_review": True, "created_at": self.created_at}


class AiFeedback(db.Model):
    __tablename__ = "ai_feedback"

    feedback_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    insight_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("ai_insights.insight_id"))
    query_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("ai_queries.query_id"))
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    rating: Mapped[str] = mapped_column(AiFeedbackRating)
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"feedback_id": self.feedback_id, "insight_id": self.insight_id, "query_id": self.query_id,
                "user_id": self.user_id, "rating": self.rating, "comment": self.comment, "created_at": self.created_at}
