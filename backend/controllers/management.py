"""Reports, exports, scheduled reports, Target Master, dashboards."""
from flask import Response, request

from controllers.common import Validator, created, json_body, ok, require_changes
from models.enums import REPORT_FORMATS, REPORT_FREQUENCIES, TARGET_STATUSES
from services import dashboard as dashboard_service
from services import reports as reports_service


def _report_filters(extra=None) -> tuple[str, dict]:
    v = Validator(request.args.to_dict())
    v.choice("period", reports_service.PERIODS, default="This Month")
    v.date("from")
    v.date("to")
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    v.integer("source_id", min_value=1)
    v.integer("staff_id", min_value=1)
    if extra:
        extra(v)
    filters = v.validate()
    return filters.pop("period"), filters


def _period(period: str, filters: dict):
    return reports_service.period_range(period, filters.pop("from", None), filters.pop("to", None))


def _envelope(name: str, period: str, start, end, data):
    cutoff_at, completeness, notes = reports_service.cutoff(end)
    return ok({"report": name, "period": period, "from": start, "to": end, "cutoff_at": cutoff_at,
               "completeness": completeness, "completeness_notes": notes, "data": data})


def management_report():
    period, filters = _report_filters()
    start, end = _period(period, filters)
    return _envelope("management", period, start, end, reports_service.management(start, end, filters))


def funnel_report():
    period, filters = _report_filters()
    start, end = _period(period, filters)
    return _envelope("funnel", period, start, end, reports_service.funnel(start, end, filters))


def performance_report():
    period, filters = _report_filters(lambda v: v.choice("by", ("course", "source", "staff"), default="course"))
    start, end = _period(period, filters)
    by = filters.pop("by")
    return _envelope(f"performance by {by}", period, start, end, reports_service.performance(by, start, end, filters))


def sla_report():
    period, filters = _report_filters()
    start, end = _period(period, filters)
    return _envelope("sla", period, start, end, reports_service.sla(start, end, filters))


def export_report(name: str):
    period, filters = _report_filters(lambda v: (v.choice("format", tuple(f.lower() for f in REPORT_FORMATS), default="csv"),
                                                 v.choice("by", ("course", "source", "staff"), default="course")))
    fmt = {"excel": "Excel", "csv": "CSV", "pdf": "PDF"}[filters.pop("format")]
    content, run = reports_service.export(name, period, filters.pop("from", None), filters.pop("to", None), filters, fmt)
    return Response(content, mimetype="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{name}-{run.period_start}-{run.period_end}.csv"',
        "X-Report-Run-Id": str(run.report_run_id), "X-Report-Completeness": run.completeness})


# ---------------------------------------------------------------- scheduled reports

def _scheduled_rules(v: Validator, creating: bool) -> None:
    v.choice("report_name", reports_service.REPORTS, required=creating)
    v.choice("frequency", REPORT_FREQUENCIES, required=creating)
    v.integer("schedule_day", nullable=True, min_value=1)
    v.time("send_time", required=creating)
    v.choice("period", reports_service.PERIODS[:-1], required=creating)
    v.integer("branch_id", nullable=True, min_value=1)
    v.choice("format", REPORT_FORMATS)
    v.boolean("is_active")


def list_scheduled():
    return ok([r.to_dict() for r in reports_service.list_scheduled()])


def save_scheduled(report_id: int | None = None):
    body = json_body()
    v = Validator(body)
    _scheduled_rules(v, report_id is None)
    recipients = body.get("recipients")
    data = v.validate()
    if recipients is not None or report_id is None:
        rv = Validator({"recipients": [{"email": r} for r in recipients] if isinstance(recipients, list) else recipients})
        rv.list_of("recipients", lambda item: item.email("email", required=True), required=True, min_items=1)
        data["recipients"] = [r["email"] for r in rv.validate()["recipients"]]
    report = reports_service.save_scheduled(report_id, data if report_id is None else require_changes(data))
    return created(report.to_dict()) if report_id is None else ok(report.to_dict())


# ---------------------------------------------------------------- targets

def _line_rules(v: Validator) -> None:
    v.integer("branch_id", nullable=True, min_value=1, default=None)
    v.decimal("verified_collections_target", nullable=True, min_value=0)
    v.integer("paid_admissions_target", nullable=True, min_value=0)


def list_targets():
    v = Validator(request.args.to_dict())
    v.choice("status", TARGET_STATUSES)
    return ok(reports_service.list_targets(v.validate().get("status")))


def create_target():
    v = Validator(json_body())
    v.date("period_start", required=True)
    v.date("period_end", required=True)
    v.string("notes", nullable=True)
    v.list_of("lines", _line_rules, required=True, min_items=1)
    return created(reports_service.create_target(v.validate()))


def get_target(version_id: int):
    return ok(reports_service.get_target(version_id))


def approve_target(version_id: int):
    return ok(reports_service.approve_target(version_id))


def target_achievement():
    v = Validator(request.args.to_dict())
    v.date("date")
    v.integer("branch_id", min_value=1)
    data = v.validate()
    return ok([r.to_dict() for r in reports_service.achievement(data.get("date"), data.get("branch_id"))])


# ---------------------------------------------------------------- dashboards

def dashboard():
    v = Validator(request.args.to_dict())
    v.choice("period", reports_service.PERIODS, default="This Month")
    v.date("from")
    v.date("to")
    v.integer("branch_id", min_value=1)
    return ok(dashboard_service.dashboard(v.validate()))


def counsellor_dashboard():
    data = dashboard_service.counsellor()
    return ok({**data, "demos_today": [d.to_row() for d in data["demos_today"]]})


def dashboard_overview():
    v = Validator(request.args.to_dict())
    v.choice("period", reports_service.PERIODS, default="This Month")
    v.date("from")
    v.date("to")
    v.integer("branch_id", min_value=1)
    return ok(dashboard_service.overview(v.validate()))
