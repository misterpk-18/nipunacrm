"""flask --app app seed-dev: load staging data into the dev replica (nipunacrm-dev).

Everything after the staff accounts and courses goes through the real API (Flask test client), so every
trigger and business rule runs exactly as it does for the frontend. The only direct SQL moves demos and
instalments into the past, which the API (correctly) refuses to do.

Run on a freshly rebuilt database: `flask --app app create-dev-db --yes && flask --app app seed-dev`.
All people, phones and emails are fictional (example.test).
"""
from datetime import date, datetime, timedelta, timezone

import click
from flask import current_app
from flask.cli import with_appcontext
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from config.database import db
from models import (
    ContactChannel, Course, CourseBranch, EntryMethod, LeadSource, LostReason, PaymentMode, Role,
    SupportCaseType, TaskType, User, UserRoleScope,
)
from services.security import hash_password

API = "/api/v1"
IST = timezone(timedelta(hours=5, minutes=30))
STAGING_PASSWORD = "Nipuna-staging-1"
GNT, VIJ = 1, 2

# key: (full name, email, [(role, branch_id)])
STAFF = {
    "founder": ("Founder / CEO", "founder@nipuna.test", [("FOUNDER_CEO", None)]),
    "admin": ("Super Admin", "admin@nipuna.test", [("SUPER_ADMIN", None)]),
    "bm_gnt": ("Branch Manager (GNT)", "bm.gnt@nipuna.test", [("BRANCH_MANAGER", GNT)]),
    "sales_gnt": ("Counsellor A (GNT)", "sales.gnt@nipuna.test", [("SALES", GNT)]),
    "fo_gnt": ("Front Office B (GNT)", "fo.gnt@nipuna.test", [("FRONT_OFFICE", GNT)]),
    "accounts_gnt": ("Accounts (GNT)", "accounts.gnt@nipuna.test", [("ACCOUNTS", GNT)]),
    "coord_gnt": ("Academic Coordinator (GNT)", "coordinator.gnt@nipuna.test", [("ACADEMIC_COORDINATOR", GNT)]),
    "trainer_g1": ("Trainer G1", "trainer.g1@nipuna.test", [("TRAINER", GNT)]),
    "trainer_g2": ("Trainer G2", "trainer.g2@nipuna.test", [("TRAINER", GNT)]),
    "placement_gnt": ("Placement Team (GNT)", "placement.gnt@nipuna.test", [("PLACEMENT", GNT)]),
    "hr_gnt": ("HR (GNT)", "hr.gnt@nipuna.test", [("HR", GNT)]),
    "bm_vij": ("Branch Manager (VIJ)", "bm.vij@nipuna.test", [("BRANCH_MANAGER", VIJ)]),
    "sales_vij": ("Counsellor C (VIJ)", "sales.vij@nipuna.test", [("SALES", VIJ)]),
    "fo_vij": ("Front Office D (VIJ)", "fo.vij@nipuna.test", [("FRONT_OFFICE", VIJ)]),
    "accounts_vij": ("Accounts (VIJ)", "accounts.vij@nipuna.test", [("ACCOUNTS", VIJ)]),
    "coord_vij": ("Academic Coordinator (VIJ)", "coordinator.vij@nipuna.test", [("ACADEMIC_COORDINATOR", VIJ)]),
    "trainer_v1": ("Trainer V1", "trainer.v1@nipuna.test", [("TRAINER", VIJ)]),
    "trainer_v2": ("Trainer V2", "trainer.v2@nipuna.test", [("TRAINER", VIJ)]),
    "placement_vij": ("Placement Team (VIJ)", "placement.vij@nipuna.test", [("PLACEMENT", VIJ)]),
    "hr_vij": ("HR (VIJ)", "hr.vij@nipuna.test", [("HR", VIJ)]),
}

# code, title, category, standard fee (prototype Course Master rows; both branches)
COURSES = [
    ("NIT-CRS-018", "Data Science with Python, SQL, Machine Learning & Applied AI", "Data & Analytics", 30000),
    ("NIT-CRS-047", "Java Full Stack Developer", "Software Development", 25000),
    ("NIT-CRS-052", "Python Full Stack Developer", "Software Development", 24000),
    ("NIT-CRS-007", "AWS with DevOps", "Cloud & DevOps", 22000),
    ("NIT-CRS-019", "Microsoft Power BI Data Analytics & Business Intelligence", "Data & Analytics", 22000),
    ("NIT-CRS-028", "Complete Digital Marketing", "Digital Marketing", 25000),
    ("NIT-CRS-025", "Professional Graphic Design with AI Tools", "Design & Media", 18000),
    ("NIT-CRS-026", "Professional Video Editing with AI Tools", "Design & Media", 22000),
]

# name, course code, branch, owner, source, channel, entry method, intake, where the lead ends up
LEADS = [
    ("Ananya Rao", "NIT-CRS-018", GNT, "sales_gnt", "ORGANIC_SOCIAL", "WHATSAPP", "STAFF_ENTERED", "New", "demo_scheduled"),
    ("Meghana Varma", "NIT-CRS-019", GNT, "sales_gnt", "WALK_IN", "IN_PERSON", "WALK_IN_DESK", "Incomplete", "counselling"),
    ("Harini Chowdary", "NIT-CRS-028", GNT, "fo_gnt", "WEBSITE", "WEB_FORM", "WEBSITE", "New", "new"),
    ("Rohit Kumar", "NIT-CRS-047", GNT, "sales_gnt", "REFERRAL", "PHONE_CALL", "STAFF_ENTERED", "New", "admitted"),
    ("Divya Sree", "NIT-CRS-052", GNT, "sales_gnt", "GOOGLE_ADS", "WEB_FORM", "GOOGLE_ADS_FORM", "New", "admitted_overdue"),
    ("Lokesh Naidu", "NIT-CRS-025", GNT, "fo_gnt", "META_ADS", "WHATSAPP", "STAFF_ENTERED", "New", "payment_pending"),
    ("Pavani Reddy", "NIT-CRS-026", GNT, "sales_gnt", "WEBSITE", "WEB_FORM", "WEBSITE", "New", "fee_discussion"),
    ("Suresh Babu", "NIT-CRS-007", GNT, "sales_gnt", "GOOGLE_ADS", "PHONE_CALL", "GOOGLE_ADS_FORM", "New", "lost"),
    ("Keerthi Priya", "NIT-CRS-018", GNT, "sales_gnt", "REFERRAL", "PHONE_CALL", "STAFF_ENTERED", "New", "demo_attended"),
    ("Naveen Chandra", "NIT-CRS-019", GNT, "fo_gnt", "WALK_IN", "IN_PERSON", "WALK_IN_DESK", "New", "admitted_refund"),
    ("Bhavana Sri", "NIT-CRS-028", GNT, None, "ORGANIC_SOCIAL", "WHATSAPP", "STAFF_ENTERED", "New", "new"),
    ("Karthik Reddy", "NIT-CRS-047", VIJ, "sales_vij", "GOOGLE_ADS", "PHONE_CALL", "GOOGLE_ADS_FORM", "New", "plan_accepted"),
    ("Sai Teja", "NIT-CRS-007", VIJ, "fo_vij", "REFERRAL", "PHONE_CALL", "STAFF_ENTERED", "New", "demo_attended"),
    ("Vamsi Krishna", "NIT-CRS-052", VIJ, "sales_vij", "COLLEGE_DATA", "OUTBOUND_CALL", "BULK_OUTREACH_IMPORT",
     "Outreach Prospect", "payment_pending"),
    ("Lakshmi Prasanna", "NIT-CRS-018", VIJ, "sales_vij", "WEBSITE", "WEB_FORM", "WEBSITE", "New", "admitted"),
    ("Charan Teja", "NIT-CRS-019", VIJ, "sales_vij", "META_ADS", "WHATSAPP", "STAFF_ENTERED", "New", "admitted_three"),
    ("Swathi Kiran", "NIT-CRS-025", VIJ, "fo_vij", "WALK_IN", "IN_PERSON", "WALK_IN_DESK", "New", "counselling"),
    ("Ravi Teja", "NIT-CRS-026", VIJ, "fo_vij", "ORGANIC_SOCIAL", "WHATSAPP", "STAFF_ENTERED", "New", "qualified"),
    ("Mahesh Babu", "NIT-CRS-028", VIJ, "sales_vij", "GOOGLE_ADS", "WEB_FORM", "GOOGLE_ADS_FORM", "New", "demo_scheduled"),
    ("Anusha Devi", "NIT-CRS-047", VIJ, "sales_vij", "REFERRAL", "PHONE_CALL", "STAFF_ENTERED", "New", "lost"),
    # V4 scenarios: two courses on one invoice (one admission each, one person); the ₹22,000 sample claim
    ("Meera Joshi", "NIT-CRS-018", GNT, "sales_gnt", "REFERRAL", "PHONE_CALL", "STAFF_ENTERED", "New", "two_courses"),
    ("Sana Begum", "NIT-CRS-019", VIJ, "sales_vij", "WEBSITE", "WEB_FORM", "WEBSITE", "New", "sample_claim"),
]

TRAINER = {GNT: "trainer_g1", VIJ: "trainer_v1"}
ACCOUNTS = {GNT: "accounts_gnt", VIJ: "accounts_vij"}
COORDINATOR = {GNT: "coord_gnt", VIJ: "coord_vij"}
MANAGER = {GNT: "bm_gnt", VIJ: "bm_vij"}


def _id(model, code, column="code"):
    return db.session.execute(select(model).where(getattr(model, column) == code)).scalar_one()


def _future(hours):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _date_in(days):
    return (date.today() + timedelta(days=days)).isoformat()


class Seeder:
    def __init__(self):
        self.client = current_app.test_client()
        self.users: dict[str, int] = {}
        self.headers: dict[str, dict] = {}
        self.courses: dict[str, int] = {}
        self.batches: dict[tuple[int, str], int] = {}
        self.curricula: dict[str, int] = {}
        self.phone = 9876500000

    # ------------------------------------------------------------ plumbing

    def call(self, method, url, who, expected=200, **body):
        response = getattr(self.client, method)(f"{API}{url}", headers=self.headers[who], json=body or {})
        payload = response.get_json(silent=True) or {}
        if response.status_code != expected:
            raise click.ClickException(f"{method.upper()} {url} as {who} → {response.status_code}: {payload}")
        return payload.get("data")

    def sql(self, statement, **params):
        db.session.execute(text(statement), params)
        db.session.commit()

    # ------------------------------------------------------------ setup rows (direct)

    def staff(self):
        for key, (name, email, scopes) in STAFF.items():
            user = User(full_name=name, email=email, password_hash=hash_password(STAGING_PASSWORD))
            db.session.add(user)
            db.session.flush()
            for role_code, branch_id in scopes:
                role_id = db.session.execute(select(Role.role_id).where(Role.role_code == role_code)).scalar_one()
                db.session.add(UserRoleScope(user_id=user.user_id, role_id=role_id, branch_id=branch_id))
            self.users[key] = user.user_id
        db.session.commit()
        for key, (_, email, _) in STAFF.items():
            response = self.client.post(f"{API}/auth/login", json={"email": email, "password": STAGING_PASSWORD})
            self.headers[key] = {"Authorization": f"Bearer {response.get_json()['data']['token']}"}

    def catalog(self):
        for code, title, category, fee in COURSES:
            course = Course(course_code=code, course_title=title, category=category, standard_fee=fee,
                            branch_links=[CourseBranch(branch_code="NIT-GNT"), CourseBranch(branch_code="NIT-VIJ")])
            db.session.add(course)
            db.session.flush()
            self.courses[code] = course.course_id
        db.session.commit()

    # ------------------------------------------------------------ academics

    def academics(self):
        for code, course_id in self.courses.items():
            curriculum = self.call("post", "/curriculum-versions", "coord_gnt", 201,
                                   course_id=course_id, version_label="v2026.1", publish=True)
            self.curricula[code] = curriculum["curriculum_version_id"]
        start = (datetime.now(IST) + timedelta(days=7)).date().isoformat()
        plan = [
            (GNT, "NIT-CRS-047", "Java FS Morning", "09:00", "11:00", "Mon, Tue, Wed, Thu, Fri", "trainer_g1"),
            (GNT, "NIT-CRS-052", "Python FS Evening", "18:00", "20:00", "Mon, Wed, Fri", "trainer_g2"),
            (GNT, "NIT-CRS-019", "Power BI Weekend", "10:00", "13:00", "Sat, Sun", "trainer_g2"),
            (VIJ, "NIT-CRS-018", "Data Science Weekday", "10:00", "12:00", "Mon, Tue, Wed, Thu, Fri", "trainer_v1"),
            (VIJ, "NIT-CRS-019", "Power BI Evening", "18:00", "20:00", "Tue, Thu, Sat", "trainer_v2"),
        ]
        for branch, code, name, start_time, end_time, days, trainer in plan:
            batch = self.call("post", "/batches", COORDINATOR[branch], 201, batch_name=name,
                              course_id=self.courses[code], branch_id=branch, start_date=start, capacity=20,
                              start_time=start_time, end_time=end_time, schedule_days=days,
                              trainer_user_id=self.users[trainer])
            self.call("patch", f"/batches/{batch['batch_id']}", COORDINATOR[branch], status="Open",
                      location="Lab 1" if branch == GNT else "Lab 3")
            self.batches[(branch, code)] = batch["batch_id"]

    # ------------------------------------------------------------ sales flow

    def lead(self, name, code, branch, owner, source, channel, entry, intake):
        self.phone += 1
        who = owner or MANAGER[branch]
        body = {
            "branch_id": branch,
            "person": {"full_name": name, "phone": str(self.phone),
                       "email": f"{name.lower().replace(' ', '.')}@example.test", "city": "Guntur" if branch == GNT else "Vijayawada"},
            "course_id": self.courses[code],
            "lead_source_id": _id(LeadSource, source).id,
            "contact_channel_id": _id(ContactChannel, channel).id,
            "entry_method_id": _id(EntryMethod, entry).id,
            "intake_status": intake,
        }
        if owner:
            body["assigned_to"] = self.users[owner]
        return self.call("post", "/leads", who, 201, **body), who

    def demo(self, lead, branch, who, attended=False):
        demo = self.call("post", f"/leads/{lead['lead_id']}/demos", who, 201, scheduled_at=_future(30),
                         trainer_user_id=self.users[TRAINER[branch]])
        if attended:
            self.sql("UPDATE demos SET scheduled_at = now() - interval '2 hours' WHERE demo_id = :id", id=demo["demo_id"])
            self.call("post", f"/demos/{demo['demo_id']}/outcome", TRAINER[branch], status="Attended",
                      student_feedback="Liked the live projects", trainer_feedback="Good basics", rating=4,
                      outcome="Interested — fee discussion", next_action="Fee discussion", next_follow_up_at=_future(20))
        return demo

    CHECKS = ("Genuine intent confirmed", "Reachable contact confirmed", "Intended course(s) understood",
              "Branch and delivery mode discussed", "Exact next action agreed", "Possible identity match reviewed")

    def qualify(self, lead, who):
        for check in self.CHECKS:
            self.call("put", f"/leads/{lead['lead_id']}/qualification/checks", who, check=check, reviewed=True)
        self.call("post", f"/leads/{lead['lead_id']}/qualify", who)

    def convert(self, lead, who, extra_courses=()):
        """Qualification review + Convert to deal (the only way into the pipeline, db 019)."""
        self.qualify(lead, who)
        course_ids = [lead["course"]["course_id"], *[self.courses[c] for c in extra_courses]]
        return self.call("post", f"/leads/{lead['lead_id']}/convert", who, course_ids=course_ids,
                         expected_close_date=_date_in(10))

    def price(self, lead_id, who):
        discussion = self.call("post", f"/leads/{lead_id}/fee-discussions", who, 201)
        version = self.call("post", f"/fee-discussions/{discussion['fee_discussion_id']}/versions", who, 201)
        self.call("post", f"/fee-discussion-versions/{version['version_id']}/approve", who)
        return version

    def plan(self, lead_id, who):
        self.call("post", f"/leads/{lead_id}/delivery-plan/accept", who, delivery_mode="Classroom",
                  seat_type="Confirmed Seat", capacity_review="Checked", student_accepted=True)

    @staticmethod
    def schedule(total, plan):
        from decimal import Decimal

        total = Decimal(str(total))
        splits = {"FULL": [(0, 100)], "TWO_INSTALMENTS": [(0, 50), (12, 50)],
                  "THREE_INSTALMENTS": [(0, 50), (10, 25), (15, 25)]}[plan]
        rows = [[_date_in(days), (total * pct / 100).quantize(Decimal("1"))] for days, pct in splits]
        rows[-1][1] = total - sum(r[1] for r in rows[:-1])
        return [{"due_date": d, "amount": str(a)} for d, a in rows]

    def invoice(self, lead, who, plan="FULL", installments=None, lead_ids=None):
        """Price (approved), accept the delivery plan and create the invoice with its 1–3 instalments."""
        lead_ids = lead_ids or [lead["lead_id"]]
        total = 0
        for lead_id in lead_ids:
            total += float(self.price(lead_id, who)["final_payable"])
            self.plan(lead_id, who)
        return self.call("post", "/invoices", who, 201, lead_ids=lead_ids,
                         installments=installments or self.schedule(int(total), plan))

    @staticmethod
    def fee(lead) -> int:
        return int(db.session.get(Course, lead["course"]["course_id"]).standard_fee)

    def pay(self, invoice, who, amount, mode="UPI_BANK"):
        reference = None if mode == "CASH" else f"UTR{self.phone}"
        result = self.call("post", "/payments", who, 201, invoice_id=invoice["invoice_id"], amount=str(amount),
                           payment_mode_id=_id(PaymentMode, mode).id, reference=reference)
        return result["payment"]

    def verify(self, payment, branch):
        return self.call("post", f"/payments/{payment['payment_id']}/verify", ACCOUNTS[branch],
                         evidence_reviewed=True, cash_checked=True)["admissions_created"]

    def enrol(self, admission, branch, code):
        self.call("post", f"/admissions/{admission['admission_id']}/curricula", COORDINATOR[branch],
                  curriculum_version_id=self.curricula[code])
        batch = self.batches.get((branch, code))
        if batch:
            self.call("post", f"/admissions/{admission['admission_id']}/allocations", COORDINATOR[branch], 201,
                      batch_id=batch)

    def admit(self, lead, branch, who, plan="FULL", share="1", installments=None, amount=None):
        """Invoice → payment claim → verification, which creates the admission (₹1,000 token reached)."""
        from decimal import Decimal

        invoice = self.invoice(lead, who, plan, installments)
        amount = amount or (Decimal(invoice["billed_amount"]) * Decimal(share)).quantize(Decimal("1"))
        payment = self.pay(invoice, who, amount)
        admission = self.verify(payment, branch)[0]
        self.enrol(admission, branch, lead["course"]["course_code"])
        return invoice, payment, admission

    def sales(self):
        self.admitted = []
        for name, code, branch, owner, source, channel, entry, intake, outcome in LEADS:
            lead, who = self.lead(name, code, branch, owner, source, channel, entry, intake)
            lid = lead["lead_id"]
            if outcome == "new":
                continue
            if outcome == "qualified":  # ready to convert
                self.qualify(lead, who)
                continue
            if outcome == "lost":
                reason = "FEE_TOO_HIGH" if branch == GNT else "JOINED_COMPETITOR"
                self.call("post", f"/leads/{lid}/lost", who, lost_reason_id=_id(LostReason, reason).id,
                          lost_competitor="Other Institute", reactivation_date=(date.today() + timedelta(days=60)).isoformat())
                continue
            converted = self.convert(lead, who, extra_courses=("NIT-CRS-019",) if outcome == "two_courses" else ())
            if outcome == "counselling":
                self.call("post", f"/leads/{lid}/follow-up", who, next_follow_up_at=_future(26),
                          note="Call after college exams")
            elif outcome == "demo_scheduled":
                self.demo(lead, branch, who)
            elif outcome == "demo_attended":
                self.demo(lead, branch, who, attended=True)
            elif outcome == "fee_discussion":  # approved fee, delivery plan still to confirm
                self.demo(lead, branch, who, attended=True)
                self.price(lid, who)
            elif outcome == "plan_accepted":  # approved fee and accepted plan: ready to invoice
                self.demo(lead, branch, who, attended=True)
                self.price(lid, who)
                self.plan(lid, who)
            elif outcome == "payment_pending":
                invoice = self.invoice(lead, who)
                self.pay(invoice, who, invoice["billed_amount"], mode="CASH")
            elif outcome == "sample_claim":  # V4 sample: ₹22,000 invoice, ₹5,000 claim awaiting verification
                invoice = self.invoice(lead, who, "TWO_INSTALMENTS")
                self.pay(invoice, who, 5000, mode="CASH")
            elif outcome == "two_courses":  # one invoice, two courses, one person → two admissions
                lead_ids = [c["lead"]["lead_id"] for c in converted["courses"]]
                invoice = self.invoice(lead, who, "TWO_INSTALMENTS", lead_ids=lead_ids)
                detail = self.call("get", f"/invoices/{invoice['invoice_id']}", who)
                allocations = [{"invoice_line_id": line["invoice_line_id"], "amount": "10000"} for line in detail["lines"]]
                payment = self.call("post", "/payments", who, 201, invoice_id=invoice["invoice_id"],
                                    allocations=allocations, tenders=[
                                        {"amount": "15000", "payment_mode_id": _id(PaymentMode, "UPI_BANK").id,
                                         "reference": f"UTR{self.phone}"},
                                        {"amount": "5000", "payment_mode_id": _id(PaymentMode, "CASH").id}])
                admissions = [a for p in payment["payments"] for a in self.verify(p, branch)]
                for admission, line in zip(admissions, detail["lines"]):
                    self.enrol(admission, branch, line["course"]["course_code"])
            elif outcome == "admitted":
                self.admitted.append((lead, branch, *self.admit(lead, branch, who)))
            elif outcome == "admitted_overdue":
                invoice, payment, admission = self.admit(lead, branch, who, "TWO_INSTALMENTS", "0.5")
                self.sql("ALTER TABLE installments DISABLE TRIGGER trg_installments_guard")
                self.sql("UPDATE installments SET due_date = current_date - 5 - (2 - installment_no) WHERE invoice_id = :i",
                         i=invoice["invoice_id"])
                self.sql("ALTER TABLE installments ENABLE TRIGGER trg_installments_guard")
                self.call("post", f"/invoices/{invoice['invoice_id']}/promises", ACCOUNTS[branch], 201,
                          promised_amount=str(int(float(invoice["billed_amount"]) / 2)),
                          promised_date=(date.today() + timedelta(days=3)).isoformat())
            elif outcome == "admitted_three":
                # ₹1,000 token today, the rest over two instalments 40 and 70 days out: a long payment gap
                fee = self.fee(lead)
                schedule = [{"due_date": _date_in(0), "amount": "1000"},
                            {"due_date": _date_in(40), "amount": str(round((fee - 1000) / 2))},
                            {"due_date": _date_in(70), "amount": str(fee - 1000 - round((fee - 1000) / 2))}]
                self.admitted.append((lead, branch, *self.admit(lead, branch, who, "THREE_INSTALMENTS",
                                                                installments=schedule, amount="1000")))
            elif outcome == "admitted_refund":
                invoice, payment, admission = self.admit(lead, branch, who)
                self.call("post", "/refund-cases", MANAGER[branch], 201, admission_id=admission["admission_id"],
                          request_reason="Relocating to Hyderabad for work", payment_ids=[payment["payment_id"]])

    # ------------------------------------------------------------ operations and management

    def operations(self):
        task_type = lambda code: _id(TaskType, code).id  # noqa: E731
        lead_ids = [r["lead_id"] for r in self.call("get", "/leads?per_page=100&lead_status=All", "admin")]
        self.call("post", "/tasks", "bm_gnt", 201, task_type_id=task_type("FOLLOW_UP"), title="Call parents about fee plan",
                  branch_id=GNT, owner_user_id=self.users["sales_gnt"], due_at=_future(4), link={"lead_id": lead_ids[0]})
        self.call("post", "/tasks", "bm_vij", 201, task_type_id=task_type("GENERAL"), title="Prepare weekend walk-in desk",
                  branch_id=VIJ, owner_user_id=self.users["fo_vij"], due_at=_future(28))
        self.call("post", "/tasks", "bm_gnt", 201, task_type_id=task_type("GENERAL"), title="Update notice board batch list",
                  branch_id=GNT, due_at=_future(6))

        whatsapp = _id(ContactChannel, "WHATSAPP").id
        email = _id(ContactChannel, "EMAIL").id
        self.call("post", "/communications", "sales_gnt", 201, branch_id=GNT, contact_channel_id=whatsapp,
                  direction="Inbound", delivery_status="Received", from_address="9876500001",
                  body="Is there a weekend batch for Data Science?")
        self.call("post", "/communications", "sales_vij", 201, branch_id=VIJ, contact_channel_id=email,
                  direction="Outbound", delivery_status="Failed", failure_reason="Mailbox full",
                  to_address="karthik.reddy@example.test")

        if self.admitted:
            lead = self.admitted[0][0]
            self.call("post", "/support-cases", "fo_gnt", 201, person_id=lead["person"]["person_id"],
                      admission_id=self.admitted[0][4]["admission_id"],
                      support_case_type_id=_id(SupportCaseType, "LMS_TECHNICAL").id, subject="Can't log into LMS")

        company = self.call("post", "/companies", "placement_gnt", 201, company_name="Sample Employer A", city="Guntur")
        job = self.call("post", "/job-openings", "placement_gnt", 201, company_id=company["company_id"],
                        job_title="Junior Data Analyst", work_mode="Hybrid", salary_ctc="Not Disclosed")
        self.call("patch", f"/job-openings/{job['job_opening_id']}", "placement_gnt", status="Open")
        self.call("post", "/companies", "placement_vij", 201, company_name="Sample Employer B", city="Vijayawada")

    def management(self):
        first = date.today().replace(day=1)
        last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        target = self.call("post", "/targets", "admin", 201, period_start=first.isoformat(), period_end=last.isoformat(), lines=[
            {"branch_id": None, "verified_collections_target": "400000", "paid_admissions_target": 16},
            {"branch_id": GNT, "verified_collections_target": "220000", "paid_admissions_target": 9},
            {"branch_id": VIJ, "verified_collections_target": "180000", "paid_admissions_target": 7}])
        self.call("post", f"/targets/{target['target_version_id']}/approve", "founder")
        self.call("post", "/incidents", "admin", 201, title="WhatsApp number awaiting verification", severity="Medium")

    def run(self):
        steps = [("staff", self.staff), ("courses", self.catalog), ("curricula and batches", self.academics),
                 ("leads to admissions", self.sales), ("tasks, inbox, placement", self.operations),
                 ("targets and incidents", self.management)]
        for label, step in steps:
            step()
            click.echo(f"  ✓ {label}")
        for key in self.headers:
            self.client.post(f"{API}/auth/logout", headers=self.headers[key])


@click.command("seed-dev")
@with_appcontext
def seed_dev_command() -> None:
    """Load staging data into the dev database (refuses any database not named *-dev)."""
    database = make_url(current_app.config["SQLALCHEMY_DATABASE_URI"]).database
    if not database or not database.endswith("-dev"):
        raise click.ClickException(f"Refusing to seed '{database}': run with APP_ENV=development against a *-dev database")
    if db.session.execute(select(User.user_id).limit(1)).first():
        raise click.ClickException(f"'{database}' already has users; rebuild it first with `flask --app app create-dev-db`")
    click.echo(f"Seeding {database}")
    Seeder().run()
    click.echo(f"Done. Every staff account (e.g. admin@nipuna.test, sales.gnt@nipuna.test) uses password {STAGING_PASSWORD}")
