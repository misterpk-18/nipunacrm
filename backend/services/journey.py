"""Next-step journey of one lead / course deal: capture → qualify → convert → demo → fee → delivery plan → invoice →
payment → verification → admission → batch, and what happens after the admission (LMS login, batch).

Everything is derived from records that already exist (lead, qualification, demos, fee discussion and approval, delivery
plan, invoice line and verified money, admission and the LMS state the pull mirrors); nothing is stored here. The one
`next` step carries the plain-words reason when it is blocked, the fix to do first, who must act and whether the
current user may — using the same permission rules as the services that perform the step.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import or_, select

from config.database import db
from models import (
    Admission, BatchAllocation, Demo, FeeDiscussion, InvoiceLine, InvoiceLineBalance, Payment,
    PaymentAllocation,
)
from repositories import fees as fees_repo
from repositories import invoices as invoices_repo
from services import delivery_plans as plans_service
from services import demos as demos_service
from services import fees as fees_service
from services import invoices as invoices_service
from services import leads as leads_service
from services import payments as payments_service
from services import qualification as qualification_service
from services.context import ADMIN_ROLES, current_user
from services.lms_pull import lms_owns_academics

IST = timezone(timedelta(hours=5, minutes=30))

# (key, short label shown in the stepper) — the order of the learner journey
STEPS = (("capture", "Capture"), ("qualify", "Qualify"), ("convert", "Convert"), ("demo", "Demo"), ("fee", "Fee"),
         ("plan", "Plan"), ("invoice", "Invoice"), ("payment", "Payment"), ("verify", "Verify"),
         ("admission", "Admission"), ("batch", "Batch"))

# Who acts, in words (shown when the current user can't)
SALES = "Sales or Branch Manager"
OWNER = "Lead owner or Branch Manager"
PLANNERS = "Sales or Branch Manager"
CASHIERS = "Sales, Accounts or Branch Manager"
ACCOUNTS = "Accounts"
BRANCH_MANAGER = "Branch Manager"
APPROVER = "Branch Manager"
ADMINS = "Founder / CEO or Super Admin"


def inr(value) -> str:
    amount = Decimal(value or 0)
    return f"₹{amount:,.0f}" if amount == amount.to_integral_value() else f"₹{amount:,.2f}"


def when(value: datetime | None) -> str:
    if value is None:
        return ""
    local = value.astimezone(IST)
    hour = local.hour % 12 or 12
    return f"{local.day} {local:%b}, {hour}:{local:%M} {'am' if local.hour < 12 else 'pm'}"


def _step(action: str, label: str, step: str, *, detail: str | None = None, role: str | None = None,
          can_act: bool = True, blocked: bool = False, reason: str | None = None, fix_action: str | None = None,
          fix_label: str | None = None, ref: dict | None = None, alternatives: list[dict] | None = None) -> tuple[str, dict]:
    """(the stepper key the action belongs to, the `next` payload)."""
    return step, {"action": action, "label": label, "detail": detail, "role": role, "can_act": can_act,
                  "blocked": blocked, "reason": reason, "fix_action": fix_action, "fix_label": fix_label,
                  "ref": ref or {}, "alternatives": alternatives or []}


# ---------------------------------------------------------------- the facts

class Facts:
    """Everything the journey reads about one deal, gathered once."""

    def __init__(self, lead):
        self.lead = lead
        lead_id = lead.lead_id
        self.demos = list(db.session.execute(select(Demo).where(Demo.lead_id == lead_id)
                                             .order_by(Demo.scheduled_at)).scalars())
        discussions = fees_repo.discussions_for_lead(lead_id)
        live = [d for d in discussions if d.milestone not in FeeDiscussion.CLOSED_MILESTONES]
        self.discussion = live[-1] if live else None
        self.version = self.discussion.current_version if self.discussion else None
        self.plan = plans_service.plan_for(lead_id)
        self.admission = self._admission()
        self.invoice = plans_service.live_invoice_for(lead_id) or (self.admission.invoice if self.admission else None)
        self.line = self.balance = self.token = None
        self.pending: list[tuple[Payment, Decimal]] = []
        if self.invoice is not None:
            self.line = db.session.execute(select(InvoiceLine).where(
                InvoiceLine.invoice_id == self.invoice.invoice_id, InvoiceLine.lead_id == lead_id)).scalars().first()
        if self.line is not None:
            self.balance = db.session.get(InvoiceLineBalance, self.line.invoice_line_id, populate_existing=True)
            self.token = invoices_repo.line_token_status(self.line.invoice_line_id)
            rows = db.session.execute(
                select(Payment, PaymentAllocation.amount)
                .join(PaymentAllocation, PaymentAllocation.payment_id == Payment.payment_id)
                .where(PaymentAllocation.invoice_line_id == self.line.invoice_line_id,
                       Payment.verification_status == "Pending Verification")
                .order_by(Payment.payment_id)).all()
            self.pending = [(payment, amount) for payment, amount in rows]

    def _admission(self) -> Admission | None:
        line_ids = select(InvoiceLine.invoice_line_id).where(InvoiceLine.lead_id == self.lead.lead_id)
        rows = db.session.execute(select(Admission).where(
            or_(Admission.lead_id == self.lead.lead_id, Admission.invoice_line_id.in_(line_ids)),
            Admission.complimentary_of_admission_id.is_(None)).order_by(Admission.admission_id.desc())).scalars().all()
        return next((a for a in rows if a.enrolment_status != "Cancelled"), rows[0] if rows else None)

    # demos
    @property
    def attended_demo(self) -> Demo | None:
        return next((d for d in self.demos if d.status == "Attended"), None)

    @property
    def open_demo(self) -> Demo | None:
        return next((d for d in self.demos if d.is_open), None)

    @property
    def demo_skipped(self) -> bool:
        """A fee discussion (or anything after it) started without an attended demo."""
        return (self.attended_demo is None and self.open_demo is None
                and (self.discussion is not None or self.invoice is not None or self.admission is not None))

    # fee
    @property
    def fee_approved(self) -> bool:
        return self.admission is not None or self.invoice is not None or (
            self.version is not None and self.version.status == "Approved")

    @property
    def plan_accepted(self) -> bool:
        return self.admission is not None or self.invoice is not None or (
            self.plan is not None and self.plan.accepted_at is not None)

    # money on this course
    @property
    def verified(self) -> Decimal:
        return self.token["verified_total"] if self.token else Decimal("0")

    @property
    def pending_total(self) -> Decimal:
        return sum((amount for _, amount in self.pending), Decimal("0"))

    @property
    def token_needed(self) -> Decimal:
        return self.token["token"] if self.token else Decimal("0")

    @property
    def token_reached(self) -> bool:
        return bool(self.token) and (self.token["payment_id"] is not None or self.token["token"] == 0)

    @property
    def more_to_admit(self) -> Decimal:
        return max(Decimal("0"), self.token_needed - self.verified)

    @property
    def payment_recorded(self) -> bool:
        return self.admission is not None or self.token_reached or (
            self.line is not None and self.verified + self.pending_total > 0)


# ---------------------------------------------------------------- permissions (the services' own rules)

class Can:
    def __init__(self, lead, facts: Facts):
        user = current_user()
        branch = lead.branch_id
        self.work = leads_service.can_work(lead)
        self.sales_side = fees_service._sales_side(branch)
        self.book_demo = demos_service._is_sales_side(branch)
        self.demo_outcome = self.book_demo or user.has_role("TRAINER", branch_id=branch)
        self.plan = plans_service._can_plan(lead)
        self.invoice = invoices_service._can_issue(branch)
        collecting = facts.invoice.collecting_branch_id if facts.invoice is not None else branch
        self.collect = payments_service._can_collect(collecting)
        self.accounts = payments_service._is_accounts(collecting)
        self.admins = user.has_role(*ADMIN_ROLES)
        self.user_id = user.user_id


# ---------------------------------------------------------------- the next step

def _next_before_admission(lead, f: Facts, can: Can) -> tuple[str, dict] | None:
    if not lead.is_open:
        return None

    if lead.qualified_at is None:
        if lead.first_staff_attempt_at is None and lead.last_contacted_at is None:
            return _step("save_outcome", "Contact the lead and save the outcome", "qualify",
                         detail="Call or message them, then record what happened and the agreed next step.",
                         role=OWNER, can_act=can.work)
        done = len(qualification_service._reviews(lead.lead_id))
        return _step("qualify", "Review the six qualification checks", "qualify",
                     detail=f"{done} of 6 checks reviewed. A deal starts only after Mark Qualified.", role=OWNER,
                     can_act=can.work)
    if lead.converted_at is None:
        return _step("convert", "Convert to a deal", "convert",
                     detail="Pick the course(s), branch, owner and expected close date.", role=OWNER, can_act=can.work)

    # demo (optional: a fee discussion can start without one)
    demo = f.open_demo
    if demo is not None:
        detail = (f"{demo.demo_code} {'was' if demo.scheduled_at <= datetime.now(timezone.utc) else 'is'} on "
                  f"{when(demo.scheduled_at)}. Record attendance and the next follow-up afterwards.")
        return _step("record_demo_outcome", "Record the demo outcome", "demo", detail=detail,
                     role=f"{SALES} or the trainer", can_act=can.demo_outcome,
                     ref={"demo_id": demo.demo_id, "scheduled_at": demo.scheduled_at})
    if f.attended_demo is None and not f.demo_skipped:
        last = f.demos[-1] if f.demos else None
        detail = ("The last demo was a no-show; book another."
                  if last is not None and last.status == "No Show" else "Book a demo class with the slot picker.")
        return _step("book_demo", "Book a demo", "demo", detail=detail, role=SALES, can_act=can.book_demo,
                     alternatives=[{"action": "fee_discussion", "label": "Skip the demo: discuss fees"}])

    # fee
    if not f.fee_approved:
        return _next_fee(lead, f, can)

    # delivery plan
    if not f.plan_accepted:
        detail = ("The student's acceptance is captured with the plan." if f.plan is None else
                  f"{f.plan.plan_code} is saved; tick the student's acceptance to fix it.")
        return _step("accept_plan", "Accept the delivery plan", "plan", detail=detail, role=PLANNERS, can_act=can.plan)

    # invoice
    if f.invoice is None:
        reasons = invoices_service.course_option(lead)["reasons"]
        if reasons:
            fix = ("accept_plan", "Accept the delivery plan") if any("plan" in r for r in reasons) else (
                ("fee_discussion", "Get the fee approved") if any("fee" in r for r in reasons) else (None, None))
            return _step("create_invoice", "Create the invoice", "invoice", role=CASHIERS, can_act=can.invoice,
                         blocked=True, reason="Invoice needs " + "; ".join(r[0].lower() + r[1:] for r in reasons),
                         fix_action=fix[0], fix_label=fix[1])
        price = f.version.final_payable if f.version is not None else None
        return _step("create_invoice", "Create the invoice", "invoice",
                     detail=f"Approved fee {inr(price)} with an accepted plan; choose 1 to 3 instalments."
                     if price is not None else None, role=CASHIERS, can_act=can.invoice)

    # payment and verification
    return _next_payment(lead, f, can)


def _next_fee(lead, f: Facts, can: Can) -> tuple[str, dict]:
    if lead.course_id is None and f.discussion is None:
        return _step("fee_discussion", "Start the fee discussion", "fee", role=SALES, can_act=can.sales_side,
                     blocked=True, reason="The lead has no course yet; choose the course being priced first.")
    d, v = f.discussion, f.version
    if d is None:
        return _step("fee_discussion", "Start the fee discussion", "fee",
                     detail="Standard fee, any offer and concession, then approve the price.", role=SALES,
                     can_act=can.sales_side)
    ref = {"fee_discussion_id": d.fee_discussion_id}
    if v is None:
        return _step("fee_discussion", "Build the fee", "fee", detail=f"{d.discussion_code} has no fee version yet.",
                     role=SALES, can_act=can.sales_side, ref=ref)
    if v.status == "Pending Approval":
        scr = next((s for s in reversed(v.special_closing_requests) if s.status == "Pending"), None)
        below = v.is_below_floor
        who = ADMINS if below else APPROVER
        decide = scr is not None and fees_service._can_decide(scr, can.user_id)
        extra = f"{inr(scr.requested_extra)} extra concession" if scr else "a special closing request"
        return _step("request_approval", "Special closing approval", "fee",
                     detail=f"{scr.scr_code if scr else 'A request'} asks for {extra}"
                     f"{' (below the 70% floor: needs a second approver)' if below else ''}.",
                     role=who, can_act=decide, reason=f"Waiting for the {who} to decide.",
                     ref={**ref, "scr_id": scr.scr_id if scr else None})
    if v.status in ("Discussion Saved", "Counteroffered") and v.needs_special_closing:
        counter = next((s for s in reversed(v.special_closing_requests) if s.status == "Counteroffered"), None)
        detail = (f"The approver counter-offered {inr(counter.counter_extra)} extra; revise the fee or ask again."
                  if counter and v.status == "Counteroffered" else
                  f"v{v.version_no} has {inr(v.extra_concession)} extra concession"
                  f"{' and is below the 70% floor' if v.is_below_floor else ''}; it needs approval.")
        return _step("request_approval", "Ask for approval of the concession", "fee", detail=detail, role=SALES,
                     can_act=can.sales_side, ref={**ref, "version_id": v.version_id})
    if v.status in ("Discussion Saved", "Counteroffered"):
        return _step("fee_discussion", "Approve the fee", "fee",
                     detail=f"v{v.version_no} at {inr(v.final_payable)} has no extra concession; approve it to share "
                     "and invoice.", role=SALES, can_act=can.sales_side, ref={**ref, "version_id": v.version_id})
    reason = {"Rejected": "The special closing request was rejected", "Expired": "The fee version expired",
              "Superseded": "The fee was replaced"}.get(v.status, f"The fee version is {v.status}")
    return _step("fee_discussion", "Revise the fee", "fee", detail=f"{reason}; build a new version.", role=SALES,
                 can_act=can.sales_side, ref=ref)


def _next_payment(lead, f: Facts, can: Can) -> tuple[str, dict] | None:
    invoice = f.invoice
    ref = {"invoice_id": invoice.invoice_id}
    if f.pending:
        payment = f.pending[0][0]
        txns = ", ".join(p.transaction_number for p, _ in f.pending)
        more = f" Then {inr(f.more_to_admit - f.pending_total)} more is needed to admit." \
            if f.more_to_admit > f.pending_total else ""
        return _step("verify_payment", "Verify the payment", "verify",
                     detail=f"{inr(f.pending_total)} is waiting for Accounts to verify ({txns}). Nothing counts as paid "
                     f"until then.{more}", role=ACCOUNTS, can_act=can.accounts,
                     reason=f"Waiting for Accounts to verify {txns}.",
                     ref={**ref, "payment_id": payment.payment_id, "transaction_number": payment.transaction_number})
    if not f.token_reached:
        owed = f.more_to_admit
        return _step("record_payment", "Record the payment", "payment",
                     detail=f"{inr(owed)} more verified is needed to admit "
                     f"(admission token {inr(f.token_needed)}); the learner can pay any amount up to "
                     f"{inr(f.balance.outstanding)}.", role=CASHIERS, can_act=can.collect, ref=ref)
    # the token is reached but there is no admission: it is made on verification, or blocked
    if f.admission is None:
        reason = ("Admission wasn't created automatically (an offer already used, or the deal isn't open). "
                  "A Branch Manager has a task; it can also be created from New Admission.")
        return _step("none", "Admission is being created", "admission", role=f"{ACCOUNTS} or Branch Manager",
                     can_act=False, blocked=True, reason=reason, ref=ref)
    return None


def _after_admission(lead, f: Facts):
    """The trail after the admission, and what is left to do."""
    a = f.admission
    cancelled = a.enrolment_status == "Cancelled"
    allocation = db.session.execute(select(BatchAllocation).where(
        BatchAllocation.admission_id == a.admission_id, BatchAllocation.status == "Active")
        .order_by(BatchAllocation.allocated_at.desc())).scalars().first()
    person = a.person

    login = a.lms_status != "Not Created"
    batch = allocation.batch if allocation else None
    batch_detail = None
    if batch is not None:
        timing = " ".join(x for x in (
            batch.schedule_days,
            f"{batch.start_time:%H:%M}–{batch.end_time:%H:%M}" if batch.start_time and batch.end_time else None) if x)
        batch_detail = " · ".join(x for x in (
            batch.lms_course_id or batch.batch_code, timing or "Timing not confirmed",
            f"starts {batch.start_date:%d %b %Y}" if batch.start_date else None,
            f"joined {allocation.joining_date:%d %b %Y}" if allocation.joining_date else None) if x)

    flags = [("admitted", "Admitted", True, a.created_at, a.admission_code + (" · cancelled" if cancelled else "")),
             ("lms_login", "LMS login created", login, person.lms_provisioned_at if login else None,
              a.lms_status if login else "Created by the LMS after the admission arrives"),
             ("batch_allocated", "Batch allocated", allocation is not None,
              allocation.allocated_at if allocation else None,
              batch_detail or ("Allocated in the Nipuna LMS" if lms_owns_academics() else "Allocated by the Branch Manager"))]
    trail, current = [], None
    for key, label, done, at, detail in flags:
        status = "done" if done else ("current" if current is None else "todo")
        if status == "current":
            current = key
        trail.append({"key": key, "label": label, "status": status, "at": at, "detail": detail})
    payload = {"admission_id": a.admission_id, "admission_code": a.admission_code, "trail": trail}
    ref = {"admission_id": a.admission_id}

    if cancelled:
        return payload, None, allocation
    if current == "lms_login":
        nxt = _step("wait_batch", "Waiting for the LMS login", "batch", role="Nipuna LMS", can_act=False,
                    detail="The LMS creates the learner's login after the admission reaches it.", ref=ref)
    elif current == "batch_allocated":
        nxt = _step("wait_batch", "Waiting for a batch", "batch", role=BRANCH_MANAGER, can_act=False,
                    detail="The batch is allocated in the Nipuna LMS and shows here within a minute."
                    if lms_owns_academics() else "The Branch Manager allocates a batch.", ref=ref)
    else:
        nxt = _step("none", "All set", "", detail=batch_detail, can_act=False, ref=ref)
    return payload, nxt, allocation


# ---------------------------------------------------------------- assemble

def journey(lead_id: int) -> dict:
    lead = leads_service.get_lead(lead_id)  # 404 outside the user's branches
    f = Facts(lead)
    can = Can(lead, f)

    after, nxt, allocation = (None, None, None)
    if f.admission is not None:
        after, nxt, allocation = _after_admission(lead, f)
    else:
        nxt = _next_before_admission(lead, f, can)

    done = {
        "capture": True,
        "qualify": lead.qualified_at is not None,
        "convert": lead.converted_at is not None,
        "demo": f.attended_demo is not None,
        "fee": f.fee_approved,
        "plan": f.plan_accepted,
        "invoice": f.invoice is not None,
        "payment": f.payment_recorded,
        "verify": f.admission is not None or (f.token_reached and f.line is not None),
        "admission": f.admission is not None,
        "batch": allocation is not None,
    }
    current_key, next_payload = nxt if nxt else (None, None)
    if next_payload is not None:
        if next_payload["can_act"] and not next_payload["blocked"]:
            next_payload["reason"] = None
        elif not next_payload["can_act"] and not next_payload["reason"] and next_payload["role"]:
            next_payload["reason"] = f"Waiting for: {next_payload['role']}."
    steps = []
    for key, label in STEPS:
        if key == current_key:
            status = "blocked" if next_payload["blocked"] else "current"
        elif done[key]:
            status = "done"
        elif key == "demo" and f.demo_skipped:
            status = "skipped"
        else:
            status = "todo"
        steps.append({"key": key, "label": label, "status": status, "at": _at(key, lead, f, allocation),
                      "detail": _detail(key, lead, f, allocation, status)})

    money = None
    if f.invoice is not None and f.line is not None:
        money = {"invoice_id": f.invoice.invoice_id, "invoice_code": f.invoice.invoice_number,
                 "total": f.line.billed_amount, "verified": f.verified, "balance": f.balance.outstanding,
                 "pending": f.pending_total, "token_needed": f.token_needed, "more_to_admit": f.more_to_admit}
    return {"lead_id": lead.lead_id, "person_id": lead.person_id, "course_id": lead.course_id,
            "course_title": lead.course.course_title if lead.course else None,
            "pipeline_entry_id": lead.pipeline_entry_id, "steps": steps, "next": next_payload, "money": money,
            "after_admission": after}


def _at(key: str, lead, f: Facts, allocation) -> datetime | None:
    if key == "capture":
        return lead.created_at
    if key == "qualify":
        return lead.qualified_at
    if key == "convert":
        return lead.converted_at
    if key == "demo":
        return f.attended_demo.scheduled_at if f.attended_demo else None
    if key == "fee":
        return f.version.updated_at if f.version is not None and f.version.status == "Approved" else None
    if key == "plan":
        return f.plan.accepted_at if f.plan is not None else None
    if key == "invoice":
        return f.invoice.created_at if f.invoice is not None else None
    if key == "admission":
        return f.admission.created_at if f.admission else None
    if key == "verify":
        return f.admission.first_verified_payment_at if f.admission else None
    if key == "batch":
        return allocation.allocated_at if allocation else None
    return None


def _detail(key: str, lead, f: Facts, allocation, status: str) -> str | None:
    if key == "capture":
        return lead.lead_code
    if key == "demo":
        if f.attended_demo:
            return f.attended_demo.demo_code
        if f.open_demo:
            return f"{f.open_demo.demo_code} on {when(f.open_demo.scheduled_at)}"
        return "Skipped" if f.demo_skipped else None
    if key == "fee" and f.version is not None:
        return f"v{f.version.version_no} {inr(f.version.final_payable)} · {f.version.status}"
    if key == "plan" and f.plan is not None:
        return f"{f.plan.plan_code} · {f.plan.delivery_mode}, {f.plan.seat_type}"
    if key == "invoice" and f.invoice is not None:
        return f"{f.invoice.invoice_number} · {inr(f.line.billed_amount if f.line else f.invoice.billed_amount)}"
    if key == "payment" and f.line is not None:
        return f"{inr(f.verified + f.pending_total)} recorded" if f.verified + f.pending_total else None
    if key == "verify" and f.line is not None:
        return f"{inr(f.verified)} verified of {inr(f.token_needed)} token"
    if key == "admission" and f.admission is not None:
        return f.admission.admission_code
    if key == "batch" and allocation is not None:
        return allocation.batch.lms_course_id or allocation.batch.batch_code
    return None
