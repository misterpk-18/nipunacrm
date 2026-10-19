"""Aggregate queries behind reports and dashboards. Business dates are IST (business_tz()).

Attribution: collections by collecting branch and payment date; paid admissions by original branch and first
verified payment date; refunds by service branch and payout completion date.
"""
from datetime import date

from sqlalchemy import func, select

from config.database import db
from models import Branch
from models.enums import LEAD_STAGES
from repositories.common import text


def local_date(column):
    """ORM expression for the IST date of a column; kept for callers outside this module (services/dashboard.py)."""
    return func.date(func.timezone(func.business_tz(), column))


def _local_date(column: str) -> str:
    """SQL for the IST business date of a timestamptz column (column is a fixed literal)."""
    return f"DATE(timezone(business_tz(), {column}))"


def _scope(column: str, branch_ids, fragments: list[str], params: dict, name: str = "branch_ids") -> None:
    """Branch scoping: add `column = ANY(:name)` only when the user is not unrestricted (branch_ids is None)."""
    if branch_ids is not None:
        fragments.append(f"{column} = ANY(:{name})")
        params[name] = list(branch_ids)


def _run(sql: str, params: dict) -> list:
    return db.session.execute(text(sql), params).all()


def branches(branch_ids: set[int] | None) -> list[Branch]:
    fragments, params = ["branches.is_active"], {}
    _scope("branches.branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT branches.* FROM branches
        WHERE {" AND ".join(fragments)}
        ORDER BY branches.branch_id
    """
    return list(db.session.execute(select(Branch).from_statement(text(sql)), params).scalars())


# ---------------------------------------------------------------- money

def collections_by_branch(start: date, end: date, branch_ids) -> dict[int, dict]:
    fragments, params = ["payments.payment_date BETWEEN :start AND :end"], {"start": start, "end": end}
    _scope("payments.collecting_branch_id", branch_ids, fragments, params)
    params.update({"entry_payment": "Payment", "entry_reversal": "Reversal", "verified": "Verified",
                   "pending": "Pending Verification"})
    sql = f"""
        SELECT payments.collecting_branch_id,
               COALESCE(SUM(payments.amount) FILTER (WHERE payments.entry_type = :entry_payment
                                                      AND payments.verification_status = :verified), 0),
               COALESCE(SUM(payments.amount) FILTER (WHERE payments.entry_type = :entry_reversal), 0),
               COALESCE(SUM(payments.amount) FILTER (WHERE payments.verification_status = :pending
                                                      AND payments.amount > 0), 0)
        FROM payments
        WHERE {" AND ".join(fragments)}
        GROUP BY payments.collecting_branch_id
    """
    return {b: {"gross_verified": g, "reversals": r, "pending_verification": p} for b, g, r, p in _run(sql, params)}


def dues_recovery_by_branch(start: date, end: date, branch_ids) -> dict[int, object]:
    """Verified collections in the period on admitted courses whose first paid date was before the period
    (per course line, db 021)."""
    fragments = ["payments.entry_type = :entry_payment", "payments.verification_status = :verified",
                 "payments.payment_date BETWEEN :start AND :end",
                 f"{_local_date('admissions.first_verified_payment_at')} < :start"]
    params = {"entry_payment": "Payment", "verified": "Verified", "start": start, "end": end}
    _scope("payments.collecting_branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT payments.collecting_branch_id, COALESCE(SUM(payment_allocations.amount), 0)
        FROM payments
        JOIN payment_allocations ON payment_allocations.payment_id = payments.payment_id
        JOIN admissions ON admissions.invoice_line_id = payment_allocations.invoice_line_id
        WHERE {" AND ".join(fragments)}
        GROUP BY payments.collecting_branch_id
    """
    return dict(_run(sql, params))


def refunds_by_branch(start: date, end: date, branch_ids) -> dict[int, object]:
    fragments = ["refund_cases.payout_status = :completed",
                 f"{_local_date('refund_cases.payout_completed_at')} BETWEEN :start AND :end"]
    params = {"completed": "Completed", "start": start, "end": end}
    _scope("admissions.service_branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT admissions.service_branch_id, COALESCE(SUM(refund_cases.payout_amount), 0)
        FROM refund_cases
        JOIN admissions ON admissions.admission_id = refund_cases.admission_id
        WHERE {" AND ".join(fragments)}
        GROUP BY admissions.service_branch_id
    """
    return dict(_run(sql, params))


def paid_admissions_by_branch(start: date, end: date, branch_ids, course_id=None) -> dict[int, int]:
    fragments = [f"{_local_date('admissions.first_verified_payment_at')} BETWEEN :start AND :end"]
    params = {"start": start, "end": end}
    _scope("admissions.original_branch_id", branch_ids, fragments, params)
    if course_id:
        fragments.append("admissions.course_id = :course_id")
        params["course_id"] = course_id
    sql = f"""
        SELECT admissions.original_branch_id, COUNT(*)
        FROM admissions
        WHERE {" AND ".join(fragments)}
        GROUP BY admissions.original_branch_id
    """
    return dict(_run(sql, params))


def overdue_dues(branch_ids) -> dict[int, object]:
    fragments, params = ["installment_dues.due_position = :overdue"], {"overdue": "Overdue"}
    _scope("installment_dues.collecting_branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT installment_dues.collecting_branch_id, COALESCE(SUM(installment_dues.balance), 0)
        FROM installment_dues
        WHERE {" AND ".join(fragments)}
        GROUP BY installment_dues.collecting_branch_id
    """
    return dict(_run(sql, params))


def long_gap_plans(branch_ids) -> dict[int, dict]:
    """Open invoices whose next instalment is due long after the last verified payment (view payment_gaps)."""
    fragments, params = [], {}
    _scope("payment_gaps.collecting_branch_id", branch_ids, fragments, params)
    where = f"WHERE {' AND '.join(fragments)}" if fragments else ""
    sql = f"""
        SELECT payment_gaps.collecting_branch_id, COUNT(*), COALESCE(SUM(payment_gaps.outstanding), 0)
        FROM payment_gaps
        {where}
        GROUP BY payment_gaps.collecting_branch_id
    """
    return {branch: {"count": count, "outstanding": outstanding} for branch, count, outstanding in _run(sql, params)}


# ---------------------------------------------------------------- funnel / performance

# request filter name -> SQL column on leads (fixed allowlist)
_LEAD_FILTER_COLUMNS = {"branch_id": "leads.branch_id", "course_id": "leads.course_id",
                        "source_id": "leads.original_source_id", "staff_id": "leads.assigned_to"}


def _lead_fragments(filters: dict, branch_ids, fragments: list[str], params: dict) -> None:
    _scope("leads.branch_id", branch_ids, fragments, params)
    for field, column in _LEAD_FILTER_COLUMNS.items():
        if filters.get(field):
            fragments.append(f"{column} = :lf_{field}")
            params[f"lf_{field}"] = filters[field]


def funnel(start: date, end: date, filters: dict, branch_ids) -> dict:
    """Leads created in the period, counted cumulatively: a lead counts for every stage up to the furthest one it
    has reached (now or at any point). Lost is counted on its own."""
    fragments = [f"{_local_date('leads.created_at')} BETWEEN :start AND :end"]
    params = {"start": start, "end": end}
    _lead_fragments(filters, branch_ids, fragments, params)
    sql = f"""
        WITH lead_ids AS (
            SELECT leads.lead_id FROM leads WHERE {" AND ".join(fragments)}
        )
        SELECT leads.lead_id, leads.stage FROM leads WHERE leads.lead_id IN (SELECT lead_id FROM lead_ids)
        UNION
        SELECT lead_activities.lead_id, lead_activities.to_stage FROM lead_activities
        WHERE lead_activities.lead_id IN (SELECT lead_id FROM lead_ids) AND lead_activities.to_stage IS NOT NULL
    """
    reached = _run(sql, params)
    progress = [s for s in LEAD_STAGES if s != "Lost - closed"]
    furthest: dict[int, int] = {}
    lost: set[int] = set()
    for lead_id, stage in reached:
        if stage == "Lost - closed":
            lost.add(lead_id)
        else:
            furthest[lead_id] = max(furthest.get(lead_id, 0), progress.index(stage))
    counts = {stage: sum(1 for f in furthest.values() if f >= i) for i, stage in enumerate(progress)}
    counts["Lost - closed"] = len(lost)
    return {"total": len(furthest), "counts": counts}


def performance(by: str, start: date, end: date, filters: dict, branch_ids) -> list[dict]:
    """Enquiries, leads, paid admissions and conversion grouped by course, source or staff."""
    lead_key = {"course": "leads.course_id", "source": "leads.original_source_id", "staff": "leads.assigned_to"}[by]
    enquiry_key = {"course": "enquiries.course_id", "source": "enquiries.lead_source_id",
                   "staff": "enquiries.owner_user_id"}[by]

    enquiry_fragments = [f"{_local_date('enquiries.received_at')} BETWEEN :start AND :end"]
    enquiry_params = {"start": start, "end": end}
    _scope("enquiries.branch_id", branch_ids, enquiry_fragments, enquiry_params)
    if filters.get("branch_id"):
        enquiry_fragments.append("enquiries.branch_id = :filter_branch_id")
        enquiry_params["filter_branch_id"] = filters["branch_id"]
    enquiry_sql = f"""
        SELECT {enquiry_key}, COUNT(*) FROM enquiries
        WHERE {" AND ".join(enquiry_fragments)}
        GROUP BY {enquiry_key}
    """

    lead_fragments = [f"{_local_date('leads.created_at')} BETWEEN :start AND :end"]
    lead_params = {"start": start, "end": end}
    _lead_fragments(filters, branch_ids, lead_fragments, lead_params)
    lead_sql = f"""
        SELECT {lead_key}, COUNT(*) FROM leads
        WHERE {" AND ".join(lead_fragments)}
        GROUP BY {lead_key}
    """

    admission_fragments = [f"{_local_date('admissions.first_verified_payment_at')} BETWEEN :start AND :end"]
    admission_params = {"start": start, "end": end}
    _lead_fragments(filters, branch_ids, admission_fragments, admission_params)
    admission_sql = f"""
        SELECT {lead_key}, COUNT(*) FROM leads
        JOIN admissions ON admissions.lead_id = leads.lead_id
        WHERE {" AND ".join(admission_fragments)}
        GROUP BY {lead_key}
    """

    enquiries = dict(_run(enquiry_sql, enquiry_params))
    leads = dict(_run(lead_sql, lead_params))
    admissions = dict(_run(admission_sql, admission_params))
    keys = [k for k in dict.fromkeys([*enquiries, *leads, *admissions])]
    return [{"key": k, "enquiries": enquiries.get(k, 0), "leads": leads.get(k, 0), "paid_admissions": admissions.get(k, 0),
             "conversion_pct": round(100 * admissions.get(k, 0) / leads[k], 1) if leads.get(k) else None} for k in keys]


# ---------------------------------------------------------------- SLA

def task_sla(start: date, end: date, branch_ids, branch_id=None) -> list[dict]:
    on_time = "task_board.status = :completed AND tasks.completed_at <= task_board.due_at"
    fragments = [f"{_local_date('task_board.due_at')} BETWEEN :start AND :end", "task_board.status <> :cancelled"]
    params = {"start": start, "end": end, "completed": "Completed", "cancelled": "Cancelled",
              "finished": ["Completed", "Cancelled"]}
    _scope("task_board.branch_id", branch_ids, fragments, params)
    if branch_id:
        fragments.append("task_board.branch_id = :branch_id")
        params["branch_id"] = branch_id
    sql = f"""
        SELECT task_board.owner_user_id, COUNT(*),
               COUNT(*) FILTER (WHERE {on_time}),
               COUNT(*) FILTER (WHERE task_board.status = :completed AND NOT ({on_time})),
               COUNT(*) FILTER (WHERE task_board.is_overdue),
               COUNT(*) FILTER (WHERE task_board.status::text <> ALL(:finished) AND NOT task_board.is_overdue)
        FROM task_board
        JOIN tasks ON tasks.task_id = task_board.task_id
        WHERE {" AND ".join(fragments)}
        GROUP BY task_board.owner_user_id
    """
    rows = _run(sql, params)
    names = dict(_run("SELECT users.user_id, users.full_name FROM users WHERE users.user_id = ANY(:user_ids)",
                      {"user_ids": [r[0] for r in rows if r[0]]}))
    return [{"owner_user_id": o, "owner": names.get(o, "Unassigned"), "tasks": t, "completed_on_time": ok,
             "completed_late": late, "overdue_open": overdue, "open": open_,
             "completion_pct": round(100 * (ok + late) / t, 1) if t else None} for o, t, ok, late, overdue, open_ in rows]


def response_sla(start: date, end: date, branch_ids, branch_id=None) -> dict[str, int]:
    fragments = ["communication_inbox.needs_response",
                 f"{_local_date('communication_inbox.occurred_at')} BETWEEN :start AND :end"]
    params = {"start": start, "end": end}
    _scope("communication_inbox.branch_id", branch_ids, fragments, params)
    if branch_id:
        fragments.append("communication_inbox.branch_id = :branch_id")
        params["branch_id"] = branch_id
    sql = f"""
        SELECT communication_inbox.sla_state, COUNT(*) FROM communication_inbox
        WHERE {" AND ".join(fragments)}
        GROUP BY communication_inbox.sla_state
    """
    found = dict(_run(sql, params))
    return {state: found.get(state, 0) for state in ("Within SLA", "At Risk", "Breached", "Met", "Met Late")}


# ---------------------------------------------------------------- dashboard tiles

def genuine_enquiries(start: date, end: date, branch_ids) -> dict[int, int]:
    fragments = [f"{_local_date('enquiries.received_at')} BETWEEN :start AND :end",
                 "(enquiries.is_genuine IS TRUE OR (enquiries.is_genuine IS NULL "
                 "AND enquiries.intake_status::text <> ALL(:not_genuine)))"]
    params = {"start": start, "end": end, "not_genuine": ["Invalid-Spam", "Test"]}
    _scope("enquiries.branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT enquiries.branch_id, COUNT(*) FROM enquiries
        WHERE {" AND ".join(fragments)}
        GROUP BY enquiries.branch_id
    """
    return dict(_run(sql, params))


def overdue_follow_ups(branch_ids) -> dict[int, int]:
    fragments = ["leads.stage::text <> ALL(:closed_stages)", "leads.next_follow_up_at < now()"]
    params = {"closed_stages": ["Admitted", "Lost - closed"]}
    _scope("leads.branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT leads.branch_id, COUNT(*) FROM leads
        WHERE {" AND ".join(fragments)}
        GROUP BY leads.branch_id
    """
    return dict(_run(sql, params))


def sla_at_risk(branch_ids) -> dict[int, int]:
    fragments = ["communication_inbox.sla_state = ANY(:states)"]
    params = {"states": ["At Risk", "Breached"]}
    _scope("communication_inbox.branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT communication_inbox.branch_id, COUNT(*) FROM communication_inbox
        WHERE {" AND ".join(fragments)}
        GROUP BY communication_inbox.branch_id
    """
    return dict(_run(sql, params))


def demo_counts(start: date, end: date, branch_ids) -> dict[int, dict]:
    fragments = [f"{_local_date('demos.scheduled_at')} BETWEEN :start AND :end"]
    params = {"start": start, "end": end, "counted": ["Scheduled", "Confirmed", "Attended", "No Show"],
              "attended": "Attended", "no_show": "No Show"}
    _scope("demos.branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT demos.branch_id,
               COUNT(*) FILTER (WHERE demos.status::text = ANY(:counted)),
               COUNT(*) FILTER (WHERE demos.status = :attended),
               COUNT(*) FILTER (WHERE demos.status = :no_show)
        FROM demos
        WHERE {" AND ".join(fragments)}
        GROUP BY demos.branch_id
    """
    return {b: {"scheduled": s, "attended": a, "no_show": n} for b, s, a, n in _run(sql, params)}


def top_staff(start: date, end: date, branch_ids, limit: int = 5) -> list[dict]:
    fragments = [f"{_local_date('admissions.first_verified_payment_at')} BETWEEN :start AND :end"]
    params = {"start": start, "end": end, "limit": limit}
    _scope("admissions.original_branch_id", branch_ids, fragments, params)
    sql = f"""
        SELECT users.user_id, users.full_name, COUNT(admissions.admission_id) AS paid
        FROM users
        JOIN admissions ON admissions.counsellor_id = users.user_id
        WHERE {" AND ".join(fragments)}
        GROUP BY users.user_id, users.full_name
        ORDER BY COUNT(admissions.admission_id) DESC
        LIMIT :limit
    """
    return [{"user_id": u, "full_name": n, "paid_admissions": p} for u, n, p in _run(sql, params)]
