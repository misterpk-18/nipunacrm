"""CRM AI sales playbook v2.0 (db 031): first-response clock, quick outcomes, contact rules, objections, next-action
card, reply drafts, knowledge, course paths, AI controls, My work today, handover, course suggestions, recovery lists,
measures and the first-attempt job."""
from sqlalchemy import select

from config.database import db
from models import AiAction, Course, CourseBranch, LeadResponseClock, Notification, Task
from tests.helpers import API, admitted, call, create_deal, create_lead, error_of, future, past
from tests.test_lms_pull import fake_pull, lms_owned  # noqa: F401


def outcome(client, headers, lead_id, expected=201, **body):
    body.setdefault("channel", "Call")
    return call(client, "post", f"/leads/{lead_id}/outcome", headers, expected, json=body)


def workbench(client, headers, lead_id):
    return call(client, "get", f"/leads/{lead_id}/workbench", headers)


def approved_template(client, people, situation="Syllabus request", body=None, **extra):
    item = call(client, "post", "/sales-knowledge", people["bm"]["h"], 201, json={
        "kind": "Reply template", "title": situation, "situation": situation, "branch_id": 1,
        "body": body or "Here is the approved {course} syllabus: {approved_link}. Which topics matter to you?", **extra})
    return call(client, "post", f"/sales-knowledge/{item['knowledge_id']}/approve", people["bm"]["h"])


# ---------------------------------------------------------------- response clock and outcomes

def test_new_lead_gets_first_attempt_clock_and_card(client, people, course):
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    assert lead["first_attempt_due_at"] is not None and lead["first_staff_attempt_at"] is None
    wb = workbench(client, people["sravani"]["h"], lead["lead_id"])
    assert wb["next_action"]["action_code"] == "first_attempt"
    assert wb["response_clock"]["is_eligible"] is True
    assert wb["contact_policy"]["never_reached"] is True

    # an inbound learner message recorded by staff does not stop the clock; a staff call does
    call(client, "post", f"/leads/{lead['lead_id']}/activities", people["sravani"]["h"], 201,
         json={"activity_type": "WhatsApp", "direction": "Inbound", "summary": "Is the course online?"})
    assert workbench(client, people["sravani"]["h"], lead["lead_id"])["response_clock"]["attempted_at"] is None
    outcome(client, people["sravani"]["h"], lead["lead_id"], outcome="Connected", next_action="Share syllabus",
            next_action_at=future(4), need={"learner_goal": "Reporting dashboards at work"})
    wb = workbench(client, people["sravani"]["h"], lead["lead_id"])
    assert wb["response_clock"]["attempted_at"] is not None
    assert wb["brief"]["need"]["learner_goal"] == "Reporting dashboards at work"
    assert wb["next_action"]["action_code"] != "first_attempt"


def test_outcome_rules_tasks_and_states(client, people, course):
    h = people["sravani"]["h"]
    lead = create_lead(client, h, course_id=course)
    lid = lead["lead_id"]

    assert error_of(client.post(f"{API}/leads/{lid}/outcome", headers=h, json={
        "channel": "Call", "outcome": "Callback requested"})) ["details"]["next_action_at"]
    r = client.post(f"{API}/leads/{lid}/outcome", headers=h, json={"channel": "Call", "outcome": "Demo booked"})
    assert r.status_code == 422 and "Book the demo first" in error_of(r)["message"]

    first = outcome(client, h, lid, outcome="Callback requested", next_action_at=future(2),
                    next_action="Discuss evening batch")
    assert first["task"]["title"].startswith("Callback promised") and first["lead"]["contact_state"] is None

    # the next contact fulfils the promise; no dated action -> flagged, never silently lost
    second = outcome(client, h, lid, outcome="Connected", note="Talked about timings")
    assert second["task"] is None and second["lead"]["contact_state"] == "Next action missing"
    promise = db.session.get(Task, first["task"]["task_id"])
    db.session.refresh(promise)
    assert promise.status == "Completed"

    third = outcome(client, h, lid, outcome="Not interested", next_action_at=future(5))
    assert third["lead"]["contact_state"] == "Not interested" and third["lead"]["next_follow_up_at"] is None
    assert third["lead"]["stage"] == "New Enquiry"  # not interested is a state, not an automatic Lost

    r = client.post(f"{API}/leads/{lid}/outcome", headers=h, json={"channel": "Call", "outcome": "Later",
                                                                   "next_action_at": past(1)})
    assert r.status_code == 400

    # another counsellor can't record; Front Office cover can, without taking ownership
    other = client.post(f"{API}/leads/{lid}/outcome", headers=people["mounika"]["h"],
                        json={"channel": "Call", "outcome": "Connected"})
    assert other.status_code == 404
    cover = outcome(client, people["nikhil"]["h"], lid, outcome="Connected", next_action_at=future(3))
    assert cover["lead"]["owner"]["user_id"] == people["sravani"]["id"]


def test_unanswered_ceiling_is_shared_by_calls_and_messages(client, people, course, run_sql):
    h = people["sravani"]["h"]
    lid = create_lead(client, h, course_id=course)["lead_id"]
    for _ in range(5):
        outcome(client, h, lid, outcome="No answer")
    r = client.post(f"{API}/leads/{lid}/outcome", headers=h, json={"channel": "Call", "outcome": "No answer"})
    assert r.status_code == 422 and "ceiling" in error_of(r)["message"]
    # an inbound call can always be recorded, and once reached the ceiling no longer applies
    outcome(client, h, lid, outcome="Connected", direction="Inbound", next_action_at=future(2))
    outcome(client, h, lid, outcome="No answer")

    lid2 = create_lead(client, h, course_id=course, person={"full_name": "Kiran", "phone": "9000000002"})["lead_id"]
    for _ in range(3):
        call(client, "post", f"/leads/{lid2}/messages", h, 201, json={"channel": "WhatsApp", "text": "Hello Kiran"})
    r = client.post(f"{API}/leads/{lid2}/messages", headers=h, json={"channel": "WhatsApp", "text": "Hello again"})
    assert r.status_code == 422 and "WhatsApp" in error_of(r)["message"]
    row = workbench(client, h, lid2)["contact_policy"]
    assert row["whatsapp"] == {"used": 3, "limit": 3} and row["blocked"]["WhatsApp"]


def test_stop_contact_suppresses_outreach_until_a_manager_clears_it(client, people, course):
    h = people["sravani"]["h"]
    lid = create_lead(client, h, course_id=course)["lead_id"]
    planned = outcome(client, h, lid, outcome="Callback requested", next_action_at=future(3))
    stopped = outcome(client, h, lid, outcome="Stop contact", note="Please don't call again")
    assert stopped["lead"]["contact_state"] == "Stop contact"
    assert stopped["lead"]["person"]["stop_contact"]["reason"] == "Please don't call again"
    task = db.session.get(Task, planned["task"]["task_id"])
    db.session.refresh(task)
    assert task.status in ("Completed", "Cancelled")

    r = client.post(f"{API}/leads/{lid}/outcome", headers=h, json={"channel": "Call", "outcome": "Connected"})
    assert r.status_code == 422 and "Stop contact" in error_of(r)["message"]
    assert workbench(client, h, lid)["next_action"]["action_code"] == "stop_contact"
    outcome(client, h, lid, outcome="Connected", direction="Inbound", note="Learner called us")

    person_id = stopped["lead"]["person"]["person_id"]
    assert client.post(f"{API}/persons/{person_id}/stop-contact/clear", headers=h,
                       json={"reason": "x"}).status_code == 403
    cleared = call(client, "post", f"/persons/{person_id}/stop-contact/clear", people["bm"]["h"],
                   json={"reason": "Learner asked us to call back about a new batch"})
    assert cleared["stop_contact"] is None
    outcome(client, h, lid, outcome="Connected", next_action_at=future(2))


# ---------------------------------------------------------------- objections and the next-action card

def test_objections_drive_the_card_and_keep_the_learners_words(client, people, course):
    h = people["sravani"]["h"]
    lid = create_lead(client, h, course_id=course)["lead_id"]
    saved = outcome(client, h, lid, outcome="Interested", next_action_at=future(4),
                    objection={"learner_words": "The fee is too much for me right now", "category": "Fee is high"})
    oid = saved["objection"]["objection_id"]
    card = workbench(client, h, lid)["next_action"]
    assert card["action_code"] == "objection" and "instalment" in card["suggestion"]

    assert client.patch(f"{API}/objections/{oid}", headers=h, json={"status": "Resolved"}).status_code == 400
    done = call(client, "patch", f"/objections/{oid}", h, json={"status": "Resolved",
                                                              "resolution": "Shared the two-instalment plan"})
    assert done["status"] == "Resolved" and done["resolved_by"]["user_id"] == people["sravani"]["id"]
    assert client.patch(f"{API}/objections/{oid}", headers=h, json={"status": "Open"}).status_code == 422
    assert workbench(client, h, lid)["next_action"]["action_code"] != "objection"
    assert len(call(client, "get", "/objections/guide", h)) == 9


def test_ignoring_a_suggestion_persists_and_never_cancels_a_promise(client, people, course):
    h = people["sravani"]["h"]
    lid = create_lead(client, h, course_id=course)["lead_id"]
    planned = outcome(client, h, lid, outcome="Connected", next_action_at=future(48))
    card = workbench(client, h, lid)["next_action"]
    assert card["hidden"] is False

    r = client.post(f"{API}/leads/{lid}/next-action/disposition", headers=h,
                    json={"action_code": "something-else", "status": "Ignored"})
    assert r.status_code == 409
    assert client.post(f"{API}/leads/{lid}/next-action/disposition", headers=h,
                       json={"action_code": card["action_code"], "status": "Snoozed"}).status_code == 400
    ignored = call(client, "post", f"/leads/{lid}/next-action/disposition", h, 201,
                   json={"action_code": card["action_code"], "status": "Ignored", "note": "Learner prefers email"})
    assert ignored["status"] == "Ignored" and ignored["evidence"]
    again = workbench(client, h, lid)["next_action"]
    assert again["hidden"] is True and again["disposition"]["status"] == "Ignored"
    task = db.session.get(Task, planned["task"]["task_id"])
    db.session.refresh(task)
    assert task.status == "Open"


# ---------------------------------------------------------------- reply drafts

def test_reply_draft_uses_only_approved_facts_and_records_manually(client, people, course, run_sql):
    h = people["sravani"]["h"]
    lid = create_lead(client, h, course_id=course)["lead_id"]
    r = client.post(f"{API}/leads/{lid}/reply-draft", headers=h, json={"situation": "Syllabus request"})
    assert r.status_code == 422 and "no approved reply template" in error_of(r)["message"]

    approved_template(client, people)
    draft = call(client, "post", f"/leads/{lid}/reply-draft", h, 201, json={"situation": "Syllabus request"})
    assert draft["missing"] == ["approved_link"] and draft["can_send"] is False
    assert "{approved_link}" in draft["text"] and "Data Science" in draft["text"]
    r = client.post(f"{API}/leads/{lid}/messages", headers=h,
                    json={"channel": "WhatsApp", "text": draft["text"], "ai_action_id": draft["draft"]["ai_action_id"]})
    assert r.status_code == 422 and "unfilled" in error_of(r)["message"]

    link = call(client, "post", "/sales-knowledge", people["admin"]["h"], 201, json={
        "kind": "Syllabus", "title": "DS syllabus", "course_id": course, "body": "Syllabus 2026",
        "link_url": "https://nipuna.example/ds.pdf"})
    call(client, "post", f"/sales-knowledge/{link['knowledge_id']}/approve", people["admin"]["h"])
    draft = call(client, "post", f"/leads/{lid}/reply-draft", h, 201, json={"situation": "Syllabus request"})
    assert draft["can_send"] is True and "https://nipuna.example/ds.pdf" in draft["text"]
    sent = call(client, "post", f"/leads/{lid}/messages", h, 201, json={
        "channel": "WhatsApp", "text": draft["text"] + " Thanks!", "ai_action_id": draft["draft"]["ai_action_id"]})
    assert sent["activity"]["outcome"] == "Manually recorded" and sent["draft"]["status"] == "Edited"
    assert client.post(f"{API}/leads/{lid}/messages", headers=h, json={
        "channel": "WhatsApp", "text": "x", "ai_action_id": draft["draft"]["ai_action_id"]}).status_code == 409

    # Observe mode: suggestions only; paused: no card and no drafts, manual work continues
    call(client, "patch", "/ai/controls/1", people["bm"]["h"], json={"execution_profile": "Observe"})
    r = client.post(f"{API}/leads/{lid}/reply-draft", headers=h, json={"situation": "Syllabus request"})
    assert r.status_code == 422 and "Observe" in error_of(r)["message"]
    call(client, "patch", "/ai/controls/1", people["bm"]["h"],
         json={"execution_profile": "Assist", "is_paused": True, "pause_reason": "Wrong fee in a template"})
    wb = workbench(client, h, lid)
    assert wb["next_action"] is None and wb["assistance"]["is_paused"] is True
    assert client.post(f"{API}/leads/{lid}/ai/counselling-brief", headers=h, json={}).status_code == 422
    outcome(client, h, lid, outcome="Connected", next_action_at=future(2))


def test_counselling_brief_rule_fallback_keeps_to_offered_courses(client, people, course):
    h = people["sravani"]["h"]
    lid = create_lead(client, h, course_id=course)["lead_id"]
    brief = call(client, "post", f"/leads/{lid}/ai/counselling-brief", h, 201, json={})
    assert brief["action_type"] == "Counselling brief" and brief["model"] == "rules-fallback"
    assert brief["payload"]["useful_question"] and brief["requires_human_review"] is True
    assert [o["course_id"] for o in brief["payload"]["course_options"]] == [course]


# ---------------------------------------------------------------- knowledge, paths, controls

def test_knowledge_permissions_and_versioning(client, people, course):
    body = {"kind": "FAQ answer", "title": "Weekend batches", "body": "Saturday and Sunday batches run 10-1."}
    assert client.post(f"{API}/sales-knowledge", headers=people["sravani"]["h"], json=body).status_code == 403
    assert client.post(f"{API}/sales-knowledge", headers=people["bm"]["h"], json=body).status_code == 403  # company-wide
    item = call(client, "post", "/sales-knowledge", people["bm"]["h"], 201, json={**body, "branch_id": 1})
    assert client.post(f"{API}/sales-knowledge", headers=people["bm"]["h"],
                       json={**body, "kind": "Syllabus", "branch_id": 1}).status_code == 400
    assert item["status"] == "Draft"
    assert all(k["knowledge_id"] != item["knowledge_id"]
               for k in call(client, "get", "/sales-knowledge", people["sravani"]["h"]))
    assert client.post(f"{API}/sales-knowledge/{item['knowledge_id']}/approve",
                       headers=people["bm_vij"]["h"]).status_code == 404
    approved = call(client, "post", f"/sales-knowledge/{item['knowledge_id']}/approve", people["bm"]["h"])
    assert approved["status"] == "Approved" and approved["approved_by"]["user_id"] == people["bm"]["id"]
    assert any(k["knowledge_id"] == item["knowledge_id"]
               for k in call(client, "get", "/sales-knowledge", people["sravani"]["h"]))
    edited = call(client, "patch", f"/sales-knowledge/{item['knowledge_id']}", people["bm"]["h"],
                  json={"body": "Saturday batches only."})
    assert edited["status"] == "Draft" and edited["version"] == 2
    retired = call(client, "post", f"/sales-knowledge/{item['knowledge_id']}/retire", people["bm"]["h"])
    assert retired["status"] == "Retired"
    assert client.post(f"{API}/sales-knowledge/{item['knowledge_id']}/approve",
                       headers=people["bm"]["h"]).status_code == 422


def _second_course(code="NIT-CRS-019", title="Power BI"):
    other = Course(course_code=code, course_title=title, category="Data & Analytics", standard_fee=15000,
                   branch_links=[CourseBranch(branch_code="NIT-GNT")])
    db.session.add(other)
    db.session.commit()
    return other.course_id


def test_course_paths_need_branch_manager_approval(client, people, course):
    other = _second_course()
    body = {"from_course_id": course, "to_course_id": other, "learner_benefit": "Dashboards on top of analysis"}
    assert client.post(f"{API}/course-paths", headers=people["accounts"]["h"], json=body).status_code == 403
    assert client.post(f"{API}/course-paths", headers=people["sravani"]["h"], json=body).status_code == 403
    path = call(client, "post", "/course-paths", people["bm"]["h"], 201, json=body)
    assert path["status"] == "Draft"
    assert client.post(f"{API}/course-paths", headers=people["bm"]["h"], json=body).status_code == 422
    assert all(p["course_path_id"] != path["course_path_id"]
               for p in call(client, "get", "/course-paths", people["sravani"]["h"]))
    approved = call(client, "post", f"/course-paths/{path['course_path_id']}/approve", people["bm"]["h"])
    assert approved["status"] == "Approved"


def test_ai_controls(client, people):
    r = client.patch(f"{API}/ai/controls/1", headers=people["bm"]["h"], json={"execution_profile": "Approved automatic"})
    assert r.status_code == 422 and "live WhatsApp" in error_of(r)["message"]
    assert client.patch(f"{API}/ai/controls/1", headers=people["bm"]["h"], json={"is_paused": True}).status_code == 400
    assert client.patch(f"{API}/ai/controls/1", headers=people["bm_vij"]["h"], json={"is_paused": False}).status_code == 404
    assert client.patch(f"{API}/ai/controls/1", headers=people["sravani"]["h"], json={"is_paused": False}).status_code == 403
    rows = call(client, "get", "/ai/controls", people["admin"]["h"])
    assert {r["execution_profile"] for r in rows} == {"Assist"}


# ---------------------------------------------------------------- queue and handover

def test_my_work_today_orders_by_service_urgency(client, people, course):
    h = people["sravani"]["h"]
    fresh = create_lead(client, h, course_id=course)
    later = create_lead(client, h, course_id=course, person={"full_name": "Later Lead", "phone": "9000000003"})
    # a few minutes ahead, so the follow-up is still due today when the suite runs late in the evening (IST)
    outcome(client, h, later["lead_id"], outcome="Later", next_action_at=future(0.1), next_action="After exams")
    data = call(client, "get", "/my-work/today", h)
    kinds = {i["lead"]["lead_id"]: (i["tier"], i["kind"]) for i in data["items"] if i["lead"]}
    assert kinds[fresh["lead_id"]] == (1, "first_attempt")
    assert kinds[later["lead_id"]][0] == 4
    tiers = [i["tier"] for i in data["items"]]
    assert tiers == sorted(tiers) and len(data["tiers"]) == 4
    # another branch's counsellor sees none of these
    other = call(client, "get", "/my-work/today", people["mounika"]["h"])
    assert all(i["lead"]["lead_id"] not in kinds for i in other["items"] if i["lead"])


def test_handover_list_and_cover_task(client, people, course):
    h = people["sravani"]["h"]
    lead = create_lead(client, h, course_id=course)
    rows = call(client, "get", "/my-work/handover", h)
    assert any(r["lead"]["lead_id"] == lead["lead_id"] and r["first_attempt_pending"] for r in rows)
    note = call(client, "post", f"/leads/{lead['lead_id']}/handover-note", h, 201,
                json={"note": "Wants evening batch; call after 6pm", "cover_user_id": people["nikhil"]["id"]})
    assert note["task"]["owner"]["user_id"] == people["nikhil"]["id"]
    assert call(client, "get", f"/leads/{lead['lead_id']}", h)["owner"]["user_id"] == people["sravani"]["id"]


# ---------------------------------------------------------------- course suggestions

def test_course_suggestion_checks_entitlement_and_never_creates_a_deal(client, people, course):
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]
    other = _second_course()
    path = call(client, "post", "/course-paths", people["bm"]["h"], 201, json={
        "from_course_id": course, "to_course_id": other, "learner_benefit": "Dashboards for reporting",
        "prerequisites": "Basic spreadsheets"})
    h = people["sravani"]["h"]
    assert call(client, "get", f"/persons/{person_id}/course-suggestions", h)["suggestions"] == []  # Draft path
    call(client, "post", f"/course-paths/{path['course_path_id']}/approve", people["bm"]["h"])
    result = call(client, "get", f"/persons/{person_id}/course-suggestions", h)
    [card] = result["suggestions"]
    assert card["course"]["course_id"] == other and "Check prerequisites: Basic spreadsheets" in card["missing_checks"]

    # the reverse path is for a course they already own: skipped with the reason
    back = call(client, "post", "/course-paths", people["bm"]["h"], 201, json={
        "from_course_id": other, "to_course_id": course, "learner_benefit": "x"})
    call(client, "post", f"/course-paths/{back['course_path_id']}/approve", people["bm"]["h"])

    leads_before = db.session.execute(select(AiAction)).scalars().all()
    ignored = call(client, "post", f"/persons/{person_id}/course-suggestions/disposition", h, 201,
                   json={"course_id": other, "status": "Ignored", "note": "Not relevant now"})
    assert ignored["status"] == "Ignored" and len(leads_before) == 0
    after = call(client, "get", f"/persons/{person_id}/course-suggestions", h)
    assert after["suggestions"] == [] and after["hidden"][0]["course"]["course_id"] == other
    assert client.post(f"{API}/persons/{person_id}/course-suggestions/disposition", headers=h,
                       json={"course_id": course, "status": "Used"}).status_code == 422
    assert after["note"]


# ---------------------------------------------------------------- recovery and measures

def test_recovery_lists_and_manager_tasks(client, people, course):
    h = people["sravani"]["h"]
    lead = create_lead(client, h, course_id=course)
    counts = {c["list"]: c["count"] for c in call(client, "get", "/recovery-lists", h)}
    assert counts["no_first_attempt"] >= 1
    listing = call(client, "get", "/recovery-lists/no_first_attempt", people["bm"]["h"])
    assert any(r["lead"]["lead_id"] == lead["lead_id"] for r in listing["rows"])
    assert client.get(f"{API}/recovery-lists/everyone", headers=h).status_code == 400

    body = {"list": "no_first_attempt", "lead_ids": [lead["lead_id"]]}
    assert client.post(f"{API}/recovery-lists/tasks", headers=h, json=body).status_code == 403
    made = call(client, "post", "/recovery-lists/tasks", people["bm"]["h"], 201, json=body)
    assert len(made["created"]) == 1
    again = call(client, "post", "/recovery-lists/tasks", people["bm"]["h"], 201, json=body)
    assert again["created"][0]["task_id"] == made["created"][0]["task_id"]  # deduplicated per day
    assert call(client, "post", "/recovery-lists/tasks", people["bm_vij"]["h"], 201, json=body)["created"] == []


def test_measures_shape(client, people, course):
    deal = create_deal(client, people["sravani"]["h"], course_id=course)
    data = call(client, "get", "/reports/sales-playbook", people["bm"]["h"])
    assert data["qualified_to_paid"]["qualified"] >= 1 and data["qualified_to_paid"]["paid"] == 0
    assert data["first_attempt"]["eligible"] >= 1
    assert {"callbacks", "demos", "recovery", "cross_course", "sources", "assistance"} <= set(data)
    assert client.get(f"{API}/reports/sales-playbook", headers=people["sravani"]["h"]).status_code == 403
    assert deal["converted_at"]


# ---------------------------------------------------------------- first-attempt job

def test_first_attempt_job_alerts_by_staffed_time(app, client, people, course, run_sql):
    from services import jobs

    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    run_sql("UPDATE enquiries SET received_at = now() - interval '36 hours' WHERE lead_id = :id", id=lead["lead_id"])
    run_sql("UPDATE leads SET created_at = now() - interval '36 hours', original_enquiry_id = NULL WHERE lead_id = :id",
            id=lead["lead_id"])
    run_sql("UPDATE leads SET original_enquiry_id = (SELECT enquiry_id FROM enquiries WHERE lead_id = :id LIMIT 1) "
            "WHERE lead_id = :id", id=lead["lead_id"])
    clock = db.session.get(LeadResponseClock, lead["lead_id"], populate_existing=True)
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    expected = {rule for column, rule, _ in jobs.FIRST_ATTEMPT_RULES if getattr(clock, column) <= now}
    jobs.first_attempt_alerts()
    jobs.first_attempt_alerts()  # idempotent
    notes = db.session.execute(select(Notification).where(Notification.entity_type == "lead",
                                                          Notification.entity_id == str(lead["lead_id"]))).scalars().all()
    assert {n.event_key.split(":")[1] for n in notes} == expected
    if "FIRST_ATTEMPT_COVER" in expected:
        assert any(n.recipient_user_id == people["nikhil"]["id"] for n in notes)


# ---------------------------------------------------------------- LMS batch timetable and offerability (db 032)

def test_pulled_timetable_seats_and_readiness_drive_what_sales_may_offer(client, people, course, fake_pull, lms_owned):
    from models import Batch
    from services import lms_pull
    from tests.test_lms_pull import batch_entry

    blocked = batch_entry(status="Planned", schedule_days="Mon, Wed, Fri", start_time="18:30", end_time="20:30",
                          location="Guntur Lab 2", seats_left=29, readiness="Blocked",
                          readiness_reason="No lead trainer assigned")
    ready = batch_entry(lms_course_id="NIT-GNT-BAT-2026-000102", start_date="2026-11-02", seats_left=3,
                        readiness="Ready", readiness_reason=None)
    fake_pull({"batches": [blocked, ready]})
    lms_pull.pull()
    row = db.session.execute(select(Batch).where(Batch.lms_course_id == "NIT-GNT-BAT-2026-000101")).scalar_one()
    assert (row.schedule_days, row.start_time.strftime("%H:%M"), row.end_time.strftime("%H:%M"), row.location) == \
        ("Mon, Wed, Fri", "18:30", "20:30", "Guntur Lab 2")
    assert row.lms_seats_left == 29 and row.lms_readiness == "Blocked"

    lid = create_lead(client, people["sravani"]["h"], course_id=course)["lead_id"]
    batches = workbench(client, people["sravani"]["h"], lid)["batches"]
    assert [b["lms_batch_code"] for b in batches] == ["NIT-GNT-BAT-2026-000102", "NIT-GNT-BAT-2026-000101"]
    offer, hold = batches
    assert offer["is_offerable"] and offer["seats_left"] == 3 and not offer["timing_confirmed"]
    assert "not confirmed" in offer["timing"]
    assert not hold["is_offerable"] and hold["not_offerable_reason"] == "Not public yet: No lead trainer assigned"
    assert hold["timing"] == "Mon, Wed, Fri · 18:30–20:30 · Guntur Lab 2" and hold["seats_left"] == 29

    # a clear in the LMS arrives as null and overwrites; a full batch is not offerable
    fake_pull({"batches": [batch_entry(status="Planned", seats_left=29, readiness="Blocked",
                                       readiness_reason="No lead trainer assigned"),
                           {**ready, "seats_left": 0}]})
    lms_pull.pull()
    db.session.refresh(row)
    assert row.schedule_days is None and row.start_time is None and row.location is None
    batches = {b["lms_batch_code"]: b for b in workbench(client, people["sravani"]["h"], lid)["batches"]}
    assert batches["NIT-GNT-BAT-2026-000102"]["not_offerable_reason"] == "Full"
