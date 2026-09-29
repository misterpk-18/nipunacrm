"""Steps 13–15: tasks, communications, notifications, placement & alumni."""
from datetime import date, datetime, timedelta

from sqlalchemy import select

from config.database import db
from models import ContactChannel, LeadActivity, NotificationRule, TaskType
from tests.helpers import API, admitted, call, create_lead, future, lookup_id, past, priced_lead


def task_type(code):
    return lookup_id(TaskType, code)


def channel(code):
    return lookup_id(ContactChannel, code)


# ---------------------------------------------------------------- tasks

def test_manual_task_workflow(client, people):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    lead = create_lead(client, sravani)
    task = call(client, "post", "/tasks", bm, 201, json={
        "task_type_id": task_type("FOLLOW_UP"), "title": "Call parents", "branch_id": 1,
        "owner_user_id": people["sravani"]["id"], "due_at": future(4), "link": {"lead_id": lead["lead_id"]}})
    assert task["source"] == "Manual" and task["linked"] == {"lead_id": lead["lead_id"]}

    mine = call(client, "get", "/tasks?view=my", sravani)
    assert task["task_id"] in [t["task_id"] for t in mine]
    assert mine[0]["linked_record"] is not None
    assert client.post(f"{API}/tasks", headers=bm, json={
        "task_type_id": task_type("GENERAL"), "title": "x", "branch_id": 1, "due_at": future(),
        "link": {"lead_id": lead["lead_id"], "admission_id": 1}}).status_code == 400
    assert client.post(f"{API}/tasks", headers=bm, json={
        "task_type_id": task_type("GENERAL"), "title": "x", "branch_id": 1, "due_at": future(),
        "owner_user_id": people["mounika"]["id"]}).status_code == 400

    tid = task["task_id"]
    assert client.post(f"{API}/tasks/{tid}/start", headers=people["mounika"]["h"]).status_code == 404
    assert call(client, "post", f"/tasks/{tid}/start", sravani)["status"] == "In Progress"
    assert client.post(f"{API}/tasks/{tid}/block", json={}, headers=sravani).status_code == 400
    blocked = call(client, "post", f"/tasks/{tid}/block", sravani, json={"reason": "Parents travelling"})
    assert blocked["status"] == "Waiting/Blocked" and blocked["blocked_reason"] == "Parents travelling"
    revised = call(client, "post", f"/tasks/{tid}/revise-deadline", sravani, json={"due_at": future(48), "reason": "Back Monday"})
    assert revised["revised_due_at"]
    assert datetime.fromisoformat(revised["original_due_at"]) == datetime.fromisoformat(task["original_due_at"])
    done = call(client, "post", f"/tasks/{tid}/complete", sravani, json={})
    assert done["status"] == "Completed" and done["completed_by"] == people["sravani"]["id"]
    assert client.post(f"{API}/tasks/{tid}/start", headers=sravani).status_code == 422

    reassigned = call(client, "post", "/tasks", bm, 201, json={
        "task_type_id": task_type("GENERAL"), "title": "Unowned", "branch_id": 1, "due_at": past(2)})
    team = call(client, "get", "/tasks?view=team&overdue=true", bm)
    assert [t["task_id"] for t in team] == [reassigned["task_id"]] and team[0]["is_unassigned"]
    patched = call(client, "patch", f"/tasks/{reassigned['task_id']}", bm, json={"owner_user_id": people["nikhil"]["id"]})
    assert patched["owner"]["full_name"] == "Nikhil"
    cancelled = call(client, "post", f"/tasks/{reassigned['task_id']}/cancel", bm, json={"reason": "Duplicate"})
    assert cancelled["status"] == "Cancelled"
    assert call(client, "get", f"/leads/{lead['lead_id']}", sravani)["owner"]["full_name"] == "Sravani"


def test_system_tasks_show_on_team_board(client, people, course):
    priced_lead(client, people, course, extra_concession="500")
    lead = create_lead(client, people["bm"]["h"], person={"full_name": "Unassigned", "phone": "9000000999"})
    board = call(client, "get", "/tasks?view=team&open=true&type=general", people["bm"]["h"])
    assert any(t["linked"].get("lead_id") == lead["lead_id"] for t in board)
    assert client.get(f"{API}/tasks", headers=people["sravani"]["h"]).status_code == 200


# ---------------------------------------------------------------- communications

def test_inbox_match_reply_and_sla(client, people):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani)

    inbound = call(client, "post", "/communications", sravani, 201, json={
        "branch_id": 1, "contact_channel_id": channel("WHATSAPP"), "direction": "Inbound", "delivery_status": "Received",
        "from_address": "98765 43210", "body": "Is there a weekend batch?"})
    assert inbound["match_status"] == "Match Review" and inbound["person_id"] == lead["person"]["person_id"]
    assert inbound["needs_response"] and inbound["response_due_at"]
    queue = call(client, "get", "/communications?queue=Match Review", sravani)
    assert [c["communication_id"] for c in queue] == [inbound["communication_id"]]

    matched = call(client, "post", f"/communications/{inbound['communication_id']}/match", sravani,
                   json={"person_id": lead["person"]["person_id"], "lead_id": lead["lead_id"]})
    assert matched["match_status"] == "Matched" and matched["lead_id"] == lead["lead_id"]
    awaiting = call(client, "get", "/communications?queue=Awaiting Reply", sravani)
    assert awaiting[0]["sla_state"] == "Within SLA"

    reply = call(client, "post", f"/communications/{inbound['communication_id']}/reply", sravani, 201,
                 json={"body": "Yes — Saturdays 10am"})
    assert reply["direction"] == "Outbound" and reply["lead_id"] == lead["lead_id"]
    answered = call(client, "get", "/communications?sla_state=Met", sravani)
    assert [c["communication_id"] for c in answered] == [inbound["communication_id"]]
    activities = db.session.execute(select(LeadActivity).where(LeadActivity.lead_id == lead["lead_id"],
                                                               LeadActivity.communication_id.is_not(None))).scalars().all()
    assert {a.activity_type for a in activities} == {"WhatsApp"}


def test_failed_retry_and_missed_calls(client, people):
    sravani = people["sravani"]["h"]
    assert client.post(f"{API}/communications", headers=sravani, json={
        "branch_id": 1, "contact_channel_id": channel("EMAIL"), "direction": "Outbound",
        "delivery_status": "Failed"}).status_code == 422  # failure reason required
    failed = call(client, "post", "/communications", sravani, 201, json={
        "branch_id": 1, "contact_channel_id": channel("EMAIL"), "direction": "Outbound", "delivery_status": "Failed",
        "failure_reason": "Mailbox full", "to_address": "x@example.test"})
    retried = call(client, "post", f"/communications/{failed['communication_id']}/retry", sravani, 201, json={})
    assert retried["retry_of_id"] == failed["communication_id"]
    assert client.post(f"{API}/communications/{retried['communication_id']}/retry", json={}, headers=sravani).status_code == 422
    missed = call(client, "post", "/communications", sravani, 201, json={
        "branch_id": 1, "contact_channel_id": channel("PHONE_CALL"), "direction": "Inbound", "delivery_status": "Missed",
        "from_address": "9111111111"})
    assert [c["communication_id"] for c in call(client, "get", "/communications?queue=Missed Calls", sravani)] == [missed["communication_id"]]
    assert client.post(f"{API}/communications", headers=people["mounika"]["h"], json={
        "branch_id": 1, "contact_channel_id": channel("EMAIL"), "direction": "Inbound", "delivery_status": "Received"}).status_code == 403


def test_branch_channels_admin_only(client, people):
    body = {"branch_id": 1, "contact_channel_id": channel("WHATSAPP"), "address": "+919000011111"}
    assert client.post(f"{API}/branch-channels", json=body, headers=people["bm"]["h"]).status_code == 403
    created = call(client, "post", "/branch-channels", people["admin"]["h"], 201, json=body)
    assert created["mode"] == "Manual"
    assert client.post(f"{API}/branch-channels", json=body, headers=people["admin"]["h"]).status_code == 409
    updated = call(client, "patch", f"/branch-channels/{created['branch_channel_id']}", people["admin"]["h"], json={"mode": "API"})
    assert updated["mode"] == "API"


# ---------------------------------------------------------------- notifications

def test_notification_centre_tabs_and_states(client, people, course):
    lead, discussion, ver = priced_lead(client, people, course, extra_concession="500")
    call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests", people["sravani"]["h"], 201,
         json={"request_reason": "x"})
    bm = people["bm"]["h"]
    body = client.get(f"{API}/notifications?tab=Action Required", headers=bm).get_json()
    assert body["meta"]["unread"] == 1 and len(body["data"]) == 1
    note = body["data"][0]
    assert note["title"].startswith("Approve special closing SCR-")

    acked = call(client, "post", f"/notifications/{note['notification_id']}/acknowledge", bm)
    assert acked["acknowledged_at"] and acked["read_at"]
    assert call(client, "get", "/notifications?tab=Unread", bm) == []
    done = call(client, "post", f"/notifications/{note['notification_id']}/complete", bm)
    assert done["action_completed_at"]
    assert len(call(client, "get", "/notifications?tab=Completed", bm)) == 1
    assert client.post(f"{API}/notifications/{note['notification_id']}/read", headers=people["sravani"]["h"]).status_code == 404


def test_notification_rules(client, people):
    rule_id = db.session.execute(select(NotificationRule.rule_id).where(NotificationRule.rule_code == "SCR_PENDING")).scalar()
    admin = people["admin"]["h"]
    rules = call(client, "get", "/notification-rules", admin)
    assert {r["rule_code"] for r in rules} == {"SCR_PENDING", "PAYMENT_PENDING_VERIFICATION", "INSTALMENT_DUE_SOON",
                                               "PAYMENT_GAP_LONG"}
    bad = client.patch(f"{API}/notification-rules/{rule_id}", json={"warn_after_minutes": 10}, headers=admin)
    assert bad.status_code == 422  # escalate (5) must be after warn
    ok = call(client, "patch", f"/notification-rules/{rule_id}", admin, json={"warn_after_minutes": 3, "escalate_to_role": "super_admin"})
    assert ok["warn_after_minutes"] == 3 and ok["escalate_to_role"] == "SUPER_ADMIN"
    assert client.get(f"{API}/notification-rules", headers=people["bm"]["h"]).status_code == 403


# ---------------------------------------------------------------- placement

def test_job_openings_profile_consent_and_applications(client, people, course):
    placement = people["placement"]["h"]
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]

    company = call(client, "post", "/companies", placement, 201, json={"company_name": "Sample Employer A", "city": "Guntur"})
    assert client.post(f"{API}/companies", json={"company_name": "sample employer a"}, headers=placement).status_code == 409
    job = call(client, "post", "/job-openings", placement, 201, json={
        "company_id": company["company_id"], "job_title": "Junior Data Analyst", "work_mode": "Hybrid", "salary_ctc": "Not Disclosed"})
    assert job["job_code"] == "JOB-00001" and job["status"] == "Review Required"

    assert call(client, "get", f"/persons/{person_id}/placement-profile", placement) is None
    profile = call(client, "put", f"/persons/{person_id}/placement-profile", placement,
                   json={"readiness": "Ready", "skills": "SQL, Power BI", "cv_file_path": "cv/v1.pdf"})
    assert profile["cv_version"] == 1 and profile["cv_review_status"] == "Review Pending"

    no_consent = client.post(f"{API}/job-applications", headers=placement,
                             json={"profile_id": profile["profile_id"], "job_opening_id": job["job_opening_id"]})
    assert no_consent.status_code == 422 and "consent" in no_consent.get_json()["error"]["message"]
    call(client, "post", f"/placement-profiles/{profile['profile_id']}/consent", placement, json={"consent_status": "Explicit Consent"})
    not_open = client.post(f"{API}/job-applications", headers=placement,
                           json={"profile_id": profile["profile_id"], "job_opening_id": job["job_opening_id"]})
    assert not_open.status_code == 422 and "not Open" in not_open.get_json()["error"]["message"]
    opened = call(client, "patch", f"/job-openings/{job['job_opening_id']}", placement, json={"status": "Open"})
    assert opened["last_verified_at"]

    application = call(client, "post", "/job-applications", placement, 201,
                       json={"profile_id": profile["profile_id"], "job_opening_id": job["job_opening_id"]})
    assert client.post(f"{API}/job-applications", headers=placement,
                       json={"profile_id": profile["profile_id"], "job_opening_id": job["job_opening_id"]}).status_code == 409
    aid = application["application_id"]
    call(client, "post", f"/job-applications/{aid}/stage", placement, json={"stage": "Shortlisted"})
    event = call(client, "post", f"/job-applications/{aid}/events", placement, 201,
                 json={"event_type": "Interview Scheduled", "interview_at": future(72)})
    assert event["interview_at"]
    no_show = call(client, "post", f"/job-applications/{aid}/events", placement, 201, json={"event_type": "Interview No-show"})
    assert no_show["stage"] == "Shortlisted"  # a no-show is an event, not a closure
    assert client.post(f"{API}/job-applications/{aid}/stage", json={"stage": "Joined"}, headers=placement).status_code == 422
    joined = call(client, "post", f"/job-applications/{aid}/stage", placement,
                  json={"stage": "Joined", "joined_date": date.today().isoformat()})
    assert [e["event_type"] for e in joined["events"]].count("Stage Change") == 2

    tab = call(client, "get", f"/students/{person_id}/placement", people["bm"]["h"])
    assert tab["profile"]["profile_id"] == profile["profile_id"] and len(tab["applications"]) == 1
    assert client.get(f"{API}/companies", headers=people["sravani"]["h"]).status_code == 403


def test_alumni_and_support_extension(client, people, course, run_sql):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    assert client.post(f"{API}/admissions/{aid}/support-extensions", headers=people["admin"]["h"],
                       json={"extended_until": (date.today() + timedelta(days=400)).isoformat(), "reason": "x"}).status_code == 422
    run_sql("UPDATE admissions SET enrolment_status = 'In Progress' WHERE admission_id = :a", a=aid)
    call(client, "post", f"/admissions/{aid}/complete", people["coordinator"]["h"])

    alumni = call(client, "get", "/alumni", people["placement"]["h"])
    assert [a["person_id"] for a in alumni] == [flow["admission"]["person"]["person_id"]] and alumni[0]["support_active"]
    support_until = call(client, "get", f"/admissions/{aid}", people["bm"]["h"])["support_until"]
    later = (date.fromisoformat(support_until) + timedelta(days=90)).isoformat()
    assert client.post(f"{API}/admissions/{aid}/support-extensions", headers=people["bm"]["h"],
                       json={"extended_until": later, "reason": "Job search support"}).status_code == 403
    assert client.post(f"{API}/admissions/{aid}/support-extensions", headers=people["admin"]["h"],
                       json={"extended_until": support_until, "reason": "x"}).status_code == 400
    extension = call(client, "post", f"/admissions/{aid}/support-extensions", people["admin"]["h"], 201,
                     json={"extended_until": later, "reason": "Job search support"})
    assert extension["previous_until"] == support_until
    assert call(client, "get", f"/admissions/{aid}", people["bm"]["h"])["support_until"] == later


def test_task_board_filters_by_linked_record(client, people):
    from tests.helpers import create_lead, future

    bm, sravani = people["bm"]["h"], people["sravani"]["h"]
    lead = create_lead(client, sravani)
    other = create_lead(client, sravani, person={"full_name": "Other", "phone": "91234 56789"})
    type_id = client.get(f"{API}/lookups", headers=bm).get_json()["data"]["task_types"][0]["id"]
    for target in (lead, other):
        call(client, "post", "/tasks", bm, 201, json={"task_type_id": type_id, "title": f"Call {target['lead_code']}",
                                                      "branch_id": 1, "due_at": future(4), "link": {"lead_id": target["lead_id"]}})
    rows = call(client, "get", f"/tasks?view=team&lead_id={lead['lead_id']}", bm)
    assert [r["title"] for r in rows] == [f"Call {lead['lead_code']}"]
    assert client.get(f"{API}/tasks?lead_id=x", headers=bm).status_code == 400
