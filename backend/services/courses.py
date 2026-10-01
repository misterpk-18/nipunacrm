"""Course Master: courses, the branches offering them, and combo components."""
from sqlalchemy import select

from config.database import db
from models import Branch, ComboCourse, Course, CourseBranch
from repositories import courses as courses_repo
from repositories.common import paginate
from services import audit, lms_sync
from services.errors import BusinessRule, NotFound, ValidationError


def list_courses(filters: dict, page: int, per_page: int):
    return paginate(courses_repo.list_stmt(filters), page, per_page)


def get_course(course_id: int) -> Course:
    course = db.session.get(Course, course_id)
    if course is None:
        raise NotFound("Course not found")
    return course


def create_course(data: dict) -> Course:
    branch_ids = data.pop("branch_ids", None)
    course = Course(**data)
    db.session.add(course)
    db.session.flush()  # course_code is unique
    if branch_ids is not None:
        _set_branches(course, branch_ids)
    audit.record("COURSE_CREATED", "course", course.course_id, new=course.to_dict())
    lms_sync.course_changed(course.course_id)
    return course


def update_course(course_id: int, data: dict) -> Course:
    course = get_course(course_id)
    old = course.to_dict()
    for field, value in data.items():
        setattr(course, field, value)
    db.session.flush()
    # A fee change only affects new fee discussions; saved versions keep their own standard fee
    audit.record("COURSE_UPDATED", "course", course_id, old=old, new=course.to_dict())
    lms_sync.course_changed(course_id)
    return course


def set_branches(course_id: int, branch_ids: list[int]) -> Course:
    course = get_course(course_id)
    old = course.to_dict()["branches"]
    _set_branches(course, branch_ids)
    audit.record("COURSE_BRANCHES_SET", "course", course_id, old={"branches": old}, new={"branches": course.to_dict()["branches"]})
    return course


def _set_branches(course: Course, branch_ids: list[int]) -> None:
    branches = db.session.execute(select(Branch).where(Branch.branch_id.in_(branch_ids))).scalars().all()
    missing = set(branch_ids) - {b.branch_id for b in branches}
    if missing:
        raise ValidationError("Unknown branch", {"branch_ids": [f"Not found: {sorted(missing)}"]})
    course.branch_links = [CourseBranch(branch_code=b.branch_code) for b in branches]
    db.session.flush()


def set_components(course_id: int, components: list[dict]) -> Course:
    combo = get_course(course_id)
    if not combo.is_combo:
        raise BusinessRule("Only combo courses have components")

    component_ids = [c["course_id"] for c in components]
    if len(component_ids) != len(set(component_ids)):
        raise ValidationError("A course can appear only once", {"components": ["Duplicate course_id"]})
    if course_id in component_ids:
        raise ValidationError("A combo can't contain itself", {"components": ["Contains the combo itself"]})

    found = {c.course_id: c for c in db.session.execute(select(Course).where(Course.course_id.in_(component_ids))).scalars()}
    missing = set(component_ids) - set(found)
    if missing:
        raise ValidationError("Unknown course", {"components": [f"Not found: {sorted(missing)}"]})
    nested = [found[i].course_code for i in component_ids if found[i].is_combo]
    if nested:
        raise ValidationError("Combos can only contain standalone courses", {"components": [f"Combos: {nested}"]})

    old = [c["course_id"] for c in combo.to_dict()["components"]]
    combo.component_links = [
        ComboCourse(component_course_id=c["course_id"], is_bonus=c["is_bonus"], sort_order=c.get("sort_order", index))
        for index, c in enumerate(components)
    ]
    db.session.flush()
    db.session.refresh(combo)
    audit.record("COMBO_COMPONENTS_SET", "course", course_id, old={"components": old}, new={"components": component_ids})
    lms_sync.course_changed(course_id)
    return combo
