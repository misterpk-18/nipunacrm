"""Reports (management, funnel, performance, SLA), CSV export with a report_runs record, scheduled reports,
and the Target Master (versions + lines, approval, achievement)."""
import csv
import io
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import insert, select

from config.database import db
from models import (
    Course, LeadSource, ReportRun, ScheduledReport, TargetAchievement, TargetVersion, User, target_lines,
)
from repositories import reports as reports_repo
from repositories import settings as settings_repo
from services import audit
from services.context import current_user
from services.errors import BusinessRule, NotFound, ValidationError

PERIODS = ("Today", "Yesterday", "This Week", "Last Week", "This Month", "Last Month", "Custom")
REPORTS = ("management", "funnel", "performance", "sla")
ZERO = Decimal("0.00")


# ---------------------------------------------------------------- periods

def business_now() -> datetime:
    return datetime.now(ZoneInfo(settings_repo.get("business_timezone", "Asia/Kolkata")))


def period_range(period: str, start: date | None = None, end: date | None = None) -> tuple[date, date]:
    """IST business dates; weeks run Monday–Sunday."""
    today = business_now().date()
    monday = today - timedelta(days=today.weekday())
    first = today.replace(day=1)
    if period == "Today":
        return today, today
    if period == "Yesterday":
        return today - timedelta(days=1), today - timedelta(days=1)
    if period == "This Week":
        return monday, monday + timedelta(days=6)
    if period == "Last Week":
        return monday - timedelta(days=7), monday - timedelta(days=1)
    if period == "This Month":
        next_month = (first + timedelta(days=32)).replace(day=1)
        return first, next_month - timedelta(days=1)
    if period == "Last Month":
        last_end = first - timedelta(days=1)
        return last_end.replace(day=1), last_end
    if not start or not end:
        raise ValidationError("A custom period needs from and to", {"from": ["Required for Custom"]})
    if end < start:
        raise ValidationError("The period ends before it starts", {"to": ["Must be on or after from"]})
    return start, end


def _scope(filters: dict) -> set[int] | None:
    """The user's branches (all for background jobs), narrowed to branch_id when given."""
    user = current_user()
    branch_ids = user.branch_ids() if user else None
    if filters.get("branch_id"):
        if branch_ids is not None and filters["branch_id"] not in branch_ids:
            return set()
        return {filters["branch_id"]}
    return branch_ids


def cutoff(end: date) -> tuple[datetime, str, str | None]:
    """Report cutoff (end date at the daily cutoff time, IST) and whether the data is complete yet."""
    now = business_now()
    hours, minutes = (int(x) for x in str(settings_repo.get("report_cutoff_time", "20:00")).split(":"))
    end_cutoff = datetime.combine(end, time(hours, minutes), tzinfo=now.tzinfo)
    if now >= end_cutoff:
        return end_cutoff, "Complete", None
    return now, "Partial", f"Period still open: figures as of {now.strftime('%d %b %H:%M')} IST"


# ---------------------------------------------------------------- reports

def management(start: date, end: date, filters: dict) -> dict:
    branch_ids = _scope(filters)
    collections = reports_repo.collections_by_branch(start, end, branch_ids)
    recovery = reports_repo.dues_recovery_by_branch(start, end, branch_ids)
    refunds = reports_repo.refunds_by_branch(start, end, branch_ids)
    paid = reports_repo.paid_admissions_by_branch(start, end, branch_ids, filters.get("course_id"))
    rows = []
    for branch in reports_repo.branches(branch_ids):
        c = collections.get(branch.branch_id, {})
        gross, reversals = c.get("gross_verified", ZERO), c.get("reversals", ZERO)
        refunded = refunds.get(branch.branch_id, ZERO)
        rows.append({"branch": branch.to_summary(), "verified_collections": gross + reversals,
                     "gross_verified": gross, "reversals": reversals, "refunds": refunded,
                     "net": gross + reversals - refunded, "dues_recovery": recovery.get(branch.branch_id, ZERO),
                     "new_paid_admissions": paid.get(branch.branch_id, 0),
                     "pending_verification_excluded": c.get("pending_verification", ZERO)})
    company = {key: sum((r[key] for r in rows), ZERO if key != "new_paid_admissions" else 0)
               for key in ("verified_collections", "gross_verified", "reversals", "refunds", "net", "dues_recovery",
                           "new_paid_admissions", "pending_verification_excluded")}
    return {"branches": rows, "company": company}


def funnel(start: date, end: date, filters: dict) -> dict:
    data = reports_repo.funnel(start, end, filters, _scope(filters))
    total = data["total"]
    return {"total_leads": total, "stages": [
        {"stage": stage, "leads": count, "pct_of_total": round(100 * count / total, 1) if total else None}
        for stage, count in data["counts"].items()]}


def performance(by: str, start: date, end: date, filters: dict) -> list[dict]:
    rows = reports_repo.performance(by, start, end, filters, _scope(filters))
    model = {"course": Course, "source": LeadSource, "staff": User}[by]
    for row in rows:
        record = db.session.get(model, row["key"]) if row["key"] else None
        row["label"] = (record.course_title if by == "course" else record.label if by == "source" else record.full_name) \
            if record else ("No course" if by == "course" else "Unassigned")
    return sorted(rows, key=lambda r: (-r["paid_admissions"], -r["leads"], r["label"]))


def sla(start: date, end: date, filters: dict) -> dict:
    branch_ids = _scope(filters)
    return {"follow_ups": reports_repo.task_sla(start, end, branch_ids, filters.get("branch_id")),
            "responses": reports_repo.response_sla(start, end, branch_ids, filters.get("branch_id"))}


def run(name: str, start: date, end: date, filters: dict):
    if name == "management":
        return management(start, end, filters)
    if name == "funnel":
        return funnel(start, end, filters)
    if name == "performance":
        return performance(filters.get("by", "course"), start, end, filters)
    return sla(start, end, filters)


def _table(name: str, data) -> list[dict]:
    """Flatten a report into rows for CSV."""
    if name == "management":
        return [{"branch": r["branch"]["branch_code"], **{k: v for k, v in r.items() if k != "branch"}}
                for r in data["branches"]] + [{"branch": "Company", **data["company"]}]
    if name == "funnel":
        return data["stages"]
    if name == "performance":
        return [{k: v for k, v in r.items() if k != "key"} for r in data]
    return data["follow_ups"]


def export(name: str, period: str, start: date, end: date, filters: dict, fmt: str) -> tuple[str, ReportRun]:
    if fmt != "CSV":
        raise BusinessRule(f"{fmt} export isn't available yet; use CSV")
    start, end = period_range(period, start, end)
    rows = _table(name, run(name, start, end, filters))
    buffer = io.StringIO()
    if rows:
        writer = csv.DictWriter(buffer, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    cutoff_at, completeness, notes = cutoff(end)
    report_run = ReportRun(report_name=name, branch_id=filters.get("branch_id"), period_start=start, period_end=end,
                           cutoff_at=cutoff_at, completeness=completeness, completeness_notes=notes, format="CSV",
                           generated_by=current_user().user_id if current_user() else None)
    db.session.add(report_run)
    db.session.flush()
    return buffer.getvalue(), report_run


# ---------------------------------------------------------------- scheduled reports

def list_scheduled() -> list[ScheduledReport]:
    return list(db.session.execute(select(ScheduledReport).order_by(ScheduledReport.report_name)).scalars())


def save_scheduled(report_id: int | None, data: dict) -> ScheduledReport:
    report = ScheduledReport(created_by=current_user().user_id) if report_id is None else db.session.get(ScheduledReport, report_id)
    if report is None:
        raise NotFound("Scheduled report not found")
    for field, value in data.items():
        setattr(report, field, value)
    day, frequency = report.schedule_day, report.frequency
    if (frequency == "Daily" and day is not None) or (frequency == "Weekly" and not (day and 1 <= day <= 7)) or (
            frequency == "Monthly" and not (day and 1 <= day <= 28)):
        raise ValidationError("Daily reports have no schedule day; weekly need 1–7 (Mon–Sun); monthly 1–28",
                              {"schedule_day": ["Doesn't fit the frequency"]})
    db.session.add(report)
    db.session.flush()  # the DB checks recipients
    audit.record("SCHEDULED_REPORT_SAVED", "scheduled_report", report.scheduled_report_id, new=report.to_dict())
    return report


# ---------------------------------------------------------------- targets

def _lines(version_id: int) -> list[dict]:
    rows = db.session.execute(select(target_lines).where(target_lines.c.target_version_id == version_id)
                              .order_by(target_lines.c.branch_id.nulls_first())).mappings()
    return [{"branch_id": r["branch_id"], "scope": "Company" if r["branch_id"] is None else r["branch_id"],
             "verified_collections_target": r["verified_collections_target"],
             "paid_admissions_target": r["paid_admissions_target"]} for r in rows]


def get_target(version_id: int) -> dict:
    version = db.session.get(TargetVersion, version_id)
    if version is None:
        raise NotFound("Target version not found")
    return version.to_dict(_lines(version_id))


def list_targets(status: str | None) -> list[dict]:
    stmt = select(TargetVersion).order_by(TargetVersion.period_start.desc(), TargetVersion.target_version_id.desc())
    if status:
        stmt = stmt.where(TargetVersion.status == status)
    return [v.to_dict(_lines(v.target_version_id)) for v in db.session.execute(stmt).scalars()]


def create_target(data: dict) -> dict:
    """A Draft version with one line per branch plus Company (branch_id null); a missing measure = Not Set."""
    branch_ids = [line.get("branch_id") for line in data["lines"]]
    if len(branch_ids) != len(set(branch_ids)):
        raise ValidationError("One line per branch (and one Company line)", {"lines": ["Duplicate branch"]})
    version = TargetVersion(period_start=data["period_start"], period_end=data["period_end"], notes=data.get("notes"),
                            created_by=current_user().user_id)
    db.session.add(version)
    db.session.flush()
    db.session.refresh(version)  # version code from trigger
    for line in data["lines"]:
        db.session.execute(insert(target_lines).values(target_version_id=version.target_version_id, **line))
    audit.record("TARGET_VERSION_CREATED", "target_version", version.target_version_id,
                 new={"version_code": version.version_code, "lines": data["lines"]})
    return get_target(version.target_version_id)


def approve_target(version_id: int) -> dict:
    version = db.session.get(TargetVersion, version_id)
    if version is None:
        raise NotFound("Target version not found")
    if version.status != "Draft":
        raise BusinessRule(f"Target version {version.version_code} is {version.status}")
    if not _lines(version_id):
        raise BusinessRule("Add target lines before approving")
    version.status = "Approved"
    version.approved_by = current_user().user_id
    db.session.flush()  # approval supersedes any overlapping approved version
    db.session.refresh(version)
    audit.record("TARGET_VERSION_APPROVED", "target_version", version_id, new={"version_code": version.version_code})
    return get_target(version_id)


def achievement(on_date: date | None, branch_id: int | None) -> list[TargetAchievement]:
    stmt = select(TargetAchievement).order_by(TargetAchievement.period_start.desc(), TargetAchievement.branch_id.nulls_first())
    if on_date:
        stmt = stmt.where(TargetAchievement.period_start <= on_date, TargetAchievement.period_end >= on_date)
    branch_ids = current_user().branch_ids()
    if branch_id:
        stmt = stmt.where(TargetAchievement.branch_id == branch_id)
    elif branch_ids is not None:
        stmt = stmt.where(TargetAchievement.branch_id.in_(branch_ids))
    return list(db.session.execute(stmt).scalars())
