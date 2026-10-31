"""CSV lead import: upload (kept in S3) → every row checked → import Ready and Duplicate Review rows.

Mandatory columns / values: full_name, mobile, email, branch, source. Optional: course. Course is matched by code or
title, branch by code / name / city, source by code or label (all case-insensitive). Each problem is reported as
"<column>: <what is wrong>".

A row whose mobile or email matches an existing person is a Duplicate Review row: importing it merges into that person
(fills fields they have empty, never overwrites) and adds a new lead for them, instead of creating a second person.
"""
import csv
import io
import re
from datetime import datetime, timezone

from sqlalchemy import func, select

from config.database import db
from models import Branch, ContactChannel, Course, EntryMethod, Enquiry, LeadImport, LeadImportRow, LeadSource
from repositories import leads as leads_repo
from services import audit, lms_sync, storage
from services import leads as leads_service
from services import persons as persons_service
from services.persons import normalise_phone
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

REQUIRED_COLUMNS = ("full_name", "mobile", "email", "branch", "source")
OPTIONAL_COLUMNS = ("course",)
KNOWN_COLUMNS = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
COLUMN_TYPES = {"full_name": "Text (2–150 characters)", "mobile": "Phone (10 digits, optional +91)", "email": "Email address",
                "branch": "Branch code, name or city", "source": "Lead source code or label", "course": "Course code or title"}
MAX_ROWS = 1000
SAMPLE_ROWS = 5
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------------------------------------------------------------- upload + validate

def upload(file_name: str, content: str) -> LeadImport:
    if not file_name.lower().endswith(".csv"):
        raise ValidationError("Only .csv files can be imported", {"file": ["Choose a .csv file"]})
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
    seen: dict[str, dict] = {}
    batch = LeadImport(file_name=file_name, status="Validated", uploaded_by=current_user().user_id)
    for row_no, raw in enumerate(raw_rows, start=1):
        batch.rows.append(_validate_row(row_no, raw, lookups, seen))

    batch.total_rows = len(batch.rows)
    batch.ready_rows = sum(r.result == "Ready" for r in batch.rows)
    batch.duplicate_rows = sum(r.result == "Duplicate Review" for r in batch.rows)
    batch.invalid_rows = sum(r.result == "Invalid" for r in batch.rows)
    db.session.add(batch)
    db.session.flush()
    db.session.refresh(batch)  # import_code comes from a trigger

    # Keep the original file under the import code. If it cannot be stored the request fails and nothing is saved.
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", file_name)[-100:] or "import.csv"
    batch.storage_path = storage.save_import_file(f"lead-imports/{batch.import_code}/{safe_name}", content.encode("utf-8"))
    audit.record("LEAD_IMPORT_UPLOADED", "lead_import", batch.import_id,
                 new={"file_name": file_name, "rows": batch.total_rows, "invalid": batch.invalid_rows,
                      "stored_at": batch.storage_path})
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


def _validate_row(row_no: int, raw: dict, lookups: _Lookups, seen: dict[str, dict]) -> LeadImportRow:
    """Mandatory values, data types and lookups for one row. `seen` holds earlier rows of the same file by mobile."""
    issues: list[str] = []

    name = raw.get("full_name", "")
    if not name:
        issues.append("full_name: required")
    elif not 2 <= len(name) <= 150:
        issues.append("full_name: must be 2–150 characters")
    elif not re.search(r"[^\W\d_]", name):
        issues.append("full_name: must contain letters")

    phone = None
    if not raw.get("mobile"):
        issues.append("mobile: required")
    else:
        phone = normalise_phone(raw["mobile"])
        if phone is None:
            issues.append("mobile: not a valid phone number (10 digits, optional +91)")

    email = raw.get("email", "").lower() or None
    if email is None:
        issues.append("email: required")
    elif len(email) > 255 or not _EMAIL.match(email):
        issues.append("email: not a valid email address")

    branch = None
    if not raw.get("branch"):
        issues.append("branch: required")
    else:
        branch = lookups.branch(raw["branch"])
        if branch is None:
            issues.append("branch: not found")
        elif not current_user().can_access_branch(branch.branch_id):
            issues.append("branch: outside your branch scope")

    course = None
    if raw.get("course"):
        course = lookups.course(raw["course"])
        if course is None:
            issues.append("course: not in Course Master")
        elif branch is not None and not any(link.branch_code == branch.branch_code for link in course.branch_links):
            issues.append(f"course: not offered at {branch.branch_code}")

    source = None
    if not raw.get("source"):
        issues.append("source: required")
    else:
        source = lookups.source(raw["source"])
        if source is None:
            issues.append("source: not recognised")

    matched_lead_id = matched_person_id = None
    result = "Ready"
    if not issues:
        persons = leads_repo.persons_matching(phone, email)
        key = (course.course_id if course else None, branch.branch_id)
        earlier = seen.get(phone)
        if len({p.person_id for p in persons}) > 1:
            issues.append("mobile: the mobile and the email belong to different existing people; fix one of them")
        elif persons:
            matched_person_id = persons[0].person_id
            open_leads = leads_repo.open_leads_for_persons([matched_person_id])
            matched_lead_id = open_leads[0].lead_id if open_leads else None
            same = leads_repo.find_open_lead(matched_person_id, key[0], key[1])
            if same is not None:
                issues.append(f"lead: {persons[0].full_name} already has the open lead {same.lead_code} for this course here")
            else:
                result = "Duplicate Review"  # merged into the existing person on import
        elif earlier is not None:
            if key in earlier["keys"]:
                issues.append(f"lead: same mobile, course and branch as row {earlier['row_no']} of this file")
            else:
                result = "Duplicate Review"  # same person as an earlier row: merged into the person that row creates
        if not issues:
            seen.setdefault(phone, {"row_no": row_no, "keys": set()})["keys"].add(key)
    if issues:
        result = "Invalid"

    return LeadImportRow(
        row_no=row_no, raw_data=raw, full_name=name or None, phone=phone, email=email,
        course_id=course.course_id if course else None, branch_id=branch.branch_id if branch else None,
        lead_source_id=source.lead_source_id if source else None, issues=issues, result=result,
        matched_lead_id=matched_lead_id, matched_person_id=matched_person_id,
    )


def preview(batch: LeadImport) -> dict:
    """What the review screen shows first: per-column checks, the sample records, columns that will be ignored."""
    rows = batch.rows
    headers: list[str] = []
    for row in rows:
        headers += [h for h in row.raw_data if h not in headers]
    problems: dict[str, int] = {}
    for row in rows:
        for column in {issue.split(":", 1)[0] for issue in row.issues if ":" in issue}:
            problems[column] = problems.get(column, 0) + 1
    columns = [{"column": c, "type": COLUMN_TYPES[c], "required": c in REQUIRED_COLUMNS,
                "filled": sum(bool(r.raw_data.get(c)) for r in rows), "invalid": problems.get(c, 0)} for c in KNOWN_COLUMNS]
    return {"columns": columns, "ignored_columns": [h for h in headers if h not in KNOWN_COLUMNS],
            "sample_rows": [r.to_dict() for r in rows[:SAMPLE_ROWS]]}


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
    """Create enquiry + lead for each Ready / Duplicate Review row (entry method CSV import).

    A row whose mobile or email matches an existing person is merged into them: empty fields are filled (never
    overwritten) and the lead is added to that person. Otherwise a new person is created. Importing alone doesn't
    count as contact, so the lead SLA is untouched.
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

        # Look again: an earlier row of this file, or another user, may have created the person since validation.
        matches = {p.person_id: p for p in leads_repo.persons_matching(row.phone, row.email)}
        person = next(iter(matches.values()), None)
        problem = None
        if len(matches) > 1:
            problem = "mobile: the mobile and the email belong to different existing people; fix one of them"
        elif person is not None and (same := leads_repo.find_open_lead(person.person_id, row.course_id, row.branch_id)):
            problem = f"lead: {person.full_name} already has the open lead {same.lead_code} for this course here"
        if problem:
            _reject(batch, row, problem)
            continue

        merged = person is not None
        if merged:
            _fill_empty_fields(person, row)
        else:
            person = persons_service.create_person({"full_name": row.full_name, "phone": row.phone, "email": row.email,
                                                    "registered_branch_id": row.branch_id})
        note = f"CSV import {batch.import_code} row {row.row_no}" + (f" (merged into {person.person_code})" if merged else "")
        enquiry = Enquiry(branch_id=row.branch_id, course_id=row.course_id, person_id=person.person_id,
                          lead_source_id=row.lead_source_id, contact_channel_id=channel_id,
                          entry_method_id=entry_method_id, intake_status="New", raw_name=row.full_name,
                          raw_phone=row.phone, raw_email=row.email, message=note, created_by=user.user_id)
        db.session.add(enquiry)
        db.session.flush()
        lead = leads_service.create_from_enquiry(enquiry, person, {"course_id": row.course_id, "intake_status": "New", "imported": True})
        row.lead_id, row.enquiry_id, row.result = lead.lead_id, enquiry.enquiry_id, "Imported"
        row.matched_person_id, row.merged = (person.person_id if merged else row.matched_person_id), merged

    batch.status = "Imported"
    batch.imported_by = user.user_id
    batch.imported_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("LEAD_IMPORT_RUN", "lead_import", batch.import_id,
                 new={"imported": sum(r.result == "Imported" for r in batch.rows), "merged": sum(r.merged for r in batch.rows)})
    return batch


def _reject(batch: LeadImport, row: LeadImportRow, problem: str) -> None:
    """A row that turned out not to be importable when the import ran: it moves to Invalid with the reason."""
    if row.result == "Ready":
        batch.ready_rows -= 1
    else:
        batch.duplicate_rows -= 1
    batch.invalid_rows += 1
    row.result, row.issues = "Invalid", [*(row.issues or []), problem]


def _fill_empty_fields(person, row: LeadImportRow) -> None:
    """Merge: copy the row's values into fields the existing person has empty. Existing values are kept."""
    changed = [f for f, value in (("email", row.email),) if value and not getattr(person, f)]
    for field in changed:
        setattr(person, field, getattr(row, field))
    if changed:
        db.session.flush()
        audit.record("PERSON_MERGED_FROM_IMPORT", "person", person.person_id, new={f: getattr(person, f) for f in changed},
                     branch_id=person.registered_branch_id)
        lms_sync.person_changed(person.person_id, changed)


def _lookup_id(model, code: str) -> int:
    row = db.session.execute(select(model).where(func.upper(model.code) == code)).scalar_one_or_none()
    if row is None:
        raise BusinessRule(f"Lookup value {code} is missing; ask an admin to restore it")
    return row.id

