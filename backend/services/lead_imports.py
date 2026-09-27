"""CSV lead import: upload → every row validated (never merged) → import Ready and Duplicate Review rows.

Columns: full_name, mobile, email, course, branch, source. Course is matched by code or title, branch by
code / name / city, source by code or label (all case-insensitive).
"""
import csv
import io
import re
from datetime import datetime, timezone

from sqlalchemy import func, select

from config.database import db
from models import Branch, ContactChannel, Course, EntryMethod, Enquiry, LeadImport, LeadImportRow, LeadSource
from repositories import leads as leads_repo
from services import audit
from services import leads as leads_service
from services import persons as persons_service
from services.persons import normalise_phone
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

REQUIRED_COLUMNS = ("full_name", "mobile")
KNOWN_COLUMNS = ("full_name", "mobile", "email", "course", "branch", "source")
MAX_ROWS = 1000
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------------------------------------------------------------- upload + validate

def upload(file_name: str, content: str) -> LeadImport:
    reader = csv.DictReader(io.StringIO(content))
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    missing = [c for c in REQUIRED_COLUMNS if c not in headers]
    if missing:
        raise ValidationError("The CSV is missing required columns", {"content": [f"Missing column: {c}" for c in missing]})

    raw_rows = [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items() if k} for row in reader]
    raw_rows = [row for row in raw_rows if any(row.values())]
    if not raw_rows:
        raise ValidationError("The CSV has no data rows", {"content": ["No rows"]})
    if len(raw_rows) > MAX_ROWS:
        raise ValidationError(f"At most {MAX_ROWS} rows per import", {"content": ["Too many rows"]})

    lookups = _Lookups()
    seen_phones: dict[str, int] = {}
    batch = LeadImport(file_name=file_name, status="Validated", uploaded_by=current_user().user_id)
    for row_no, raw in enumerate(raw_rows, start=1):
        row = _validate_row(row_no, raw, lookups, seen_phones)
        batch.rows.append(row)

    batch.total_rows = len(batch.rows)
    batch.ready_rows = sum(r.result == "Ready" for r in batch.rows)
    batch.duplicate_rows = sum(r.result == "Duplicate Review" for r in batch.rows)
    batch.invalid_rows = sum(r.result == "Invalid" for r in batch.rows)
    db.session.add(batch)
    db.session.flush()
    db.session.refresh(batch)  # import_code comes from a trigger
    audit.record("LEAD_IMPORT_UPLOADED", "lead_import", batch.import_id,
                 new={"file_name": file_name, "rows": batch.total_rows, "invalid": batch.invalid_rows})
    return batch


class _Lookups:
    """Course / branch / source lookups, loaded once per upload."""

    def __init__(self):
        self.courses = list(db.session.execute(select(Course).where(Course.status == "Active")).scalars())
        self.branches = list(db.session.execute(select(Branch).where(Branch.is_active)).scalars())
        self.sources = list(db.session.execute(select(LeadSource).where(LeadSource.is_active)).scalars())

    def course(self, value: str) -> Course | None:
        value = value.lower()
        return next((c for c in self.courses if value in (c.course_code.lower(), c.course_title.lower())), None)

    def branch(self, value: str) -> Branch | None:
        value = value.lower()
        return next((b for b in self.branches if value in (b.branch_code.lower(), b.branch_name.lower(), b.city.lower(),
                                                            b.receipt_prefix.lower())), None)

    def source(self, value: str) -> LeadSource | None:
        value = value.lower()
        return next((s for s in self.sources if value in (s.code.lower(), s.label.lower())), None)


def _validate_row(row_no: int, raw: dict, lookups: _Lookups, seen_phones: dict[str, int]) -> LeadImportRow:
    issues: list[str] = []
    name = raw.get("full_name", "")
    if not name:
        issues.append("Name is required")
    phone = normalise_phone(raw.get("mobile", "")) if raw.get("mobile") else None
    if phone is None:
        issues.append("Mobile number is not valid")
    email = raw.get("email", "").lower() or None
    if email and not _EMAIL.match(email):
        issues.append("Invalid email")

    branch = lookups.branch(raw.get("branch", "")) if raw.get("branch") else None
    if branch is None:
        issues.append("Branch not found")
    elif not current_user().can_access_branch(branch.branch_id):
        issues.append("Outside your branch scope")

    course = None
    if raw.get("course"):
        course = lookups.course(raw["course"])
        if course is None:
            issues.append("Course not in Course Master")
        elif branch is not None and not any(link.branch_code == branch.branch_code for link in course.branch_links):
            issues.append(f"Course not offered at {branch.branch_code}")

    source = lookups.source(raw.get("source", "")) if raw.get("source") else None
    if source is None:
        issues.append("Source not recognised" if raw.get("source") else "Source is required")

    matched_lead_id = None
    result = "Ready"
    if issues:
        result = "Invalid"
    else:
        persons = leads_repo.persons_matching(phone, email)
        if persons:
            open_leads = leads_repo.open_leads_for_persons([p.person_id for p in persons])
            matched_lead_id = open_leads[0].lead_id if open_leads else None
            result = "Duplicate Review"
        elif phone in seen_phones:
            result = "Duplicate Review"  # same number twice in this file
        seen_phones.setdefault(phone, row_no)

    return LeadImportRow(
        row_no=row_no, raw_data=raw, full_name=name or None, phone=phone, email=email,
        course_id=course.course_id if course else None, branch_id=branch.branch_id if branch else None,
        lead_source_id=source.lead_source_id if source else None, issues=issues, result=result,
        matched_lead_id=matched_lead_id,
    )


# ---------------------------------------------------------------- read / import

def get_import(import_id: int) -> LeadImport:
    batch = db.session.get(LeadImport, import_id)
    user = current_user()
    if batch is None:
        raise NotFound("Import not found")
    branches = {row.branch_id for row in batch.rows if row.branch_id}
    if batch.uploaded_by != user.user_id and not (user.is_admin or any(user.is_manager_of(b) for b in branches)):
        raise NotFound("Import not found")
    return batch


def run_import(import_id: int) -> LeadImport:
    """Create person + enquiry + lead for each Ready / Duplicate Review row (entry method CSV import).

    Duplicate Review rows become new people whose lead stays in Duplicate Review — nothing is merged.
    Importing alone doesn't count as contact, so the lead SLA is untouched.
    """
    batch = get_import(import_id)
    if batch.status != "Validated":
        raise BusinessRule(f"Import is {batch.status}")

    entry_method_id = _lookup_id(EntryMethod, "CSV_IMPORT")
    channel_id = _lookup_id(ContactChannel, "WEB_FORM")
    user = current_user()
    for row in batch.rows:
        if row.result not in ("Ready", "Duplicate Review"):
            continue
        if not user.can_access_branch(row.branch_id):
            raise Forbidden(f"Row {row.row_no} is outside your branch scope")
        intake = "Duplicate Review" if row.result == "Duplicate Review" else "New"
        person = persons_service.create_person({"full_name": row.full_name, "phone": row.phone, "email": row.email,
                                                "registered_branch_id": row.branch_id})
        enquiry = Enquiry(branch_id=row.branch_id, course_id=row.course_id, person_id=person.person_id,
                          lead_source_id=row.lead_source_id, contact_channel_id=channel_id,
                          entry_method_id=entry_method_id, intake_status="New", raw_name=row.full_name,
                          raw_phone=row.phone, raw_email=row.email, message=f"CSV import {batch.import_code} row {row.row_no}",
                          created_by=user.user_id)
        db.session.add(enquiry)
        db.session.flush()
        lead = leads_service.create_from_enquiry(enquiry, person, {"course_id": row.course_id, "intake_status": intake})
        row.lead_id, row.enquiry_id, row.result = lead.lead_id, enquiry.enquiry_id, "Imported"

    batch.status = "Imported"
    batch.imported_by = user.user_id
    batch.imported_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("LEAD_IMPORT_RUN", "lead_import", batch.import_id,
                 new={"imported": sum(r.result == "Imported" for r in batch.rows)})
    return batch


def _lookup_id(model, code: str) -> int:
    row = db.session.execute(select(model).where(func.upper(model.code) == code)).scalar_one_or_none()
    if row is None:
        raise BusinessRule(f"Lookup value {code} is missing; ask an admin to restore it")
    return row.id

