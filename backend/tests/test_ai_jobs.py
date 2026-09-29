"""Steps 19 and 20: AI Copilot (rule-based and Claude paths) and background jobs."""
import json
from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from config.database import db
from models import DemoReminder, Notification, Offer, PaymentPromise, ReportRun, Task, UserSession
from services import jobs
from tests.helpers import (
    API, admitted, backdate_installment, call, create_deal, create_lead, future, issued_invoice, priced_lead, record_payment,
)


# ---------------------------------------------------------------- AI: rule-based fallback (no API key)

def test_brief_without_api_key_uses_rules(client, people, course):
    sravani = people["sravani"]["h"]
    lead = create_lead(client, sravani, course_id=course)
    body = call(client, "post", f"/leads/{lead['lead_id']}/ai/brief", sravani, 201, json={"language": "Telugu"})
    brief, why = body["brief"], body["priority_explanation"]
    assert brief["insight_type"] == "Before-Call Brief" and brief["model"] == "rules-fallback"
    assert brief["requires_human_review"] is True and brief["language"] == "Telugu"
    assert brief["content"].startswith("Ananya Rao · Data Science · New Enquiry.")
    assert "నమస్కారం Ananya Rao గారు" in brief["suggested_message"]
    assert why["insight_type"] == "Priority Explanation" and brief["sources"][0]["code"] == lead["lead_code"]

    insights = call(client, "get", f"/leads/{lead['lead_id']}/ai/insights", sravani)
    assert {i["insight_type"] for i in insights} == {"Before-Call Brief", "Priority Explanation"}
    assert client.post(f"{API}/leads/{lead['lead_id']}/ai/brief", json={}, headers=people["mounika"]["h"]).status_code == 404

    feedback = call(client, "post", "/ai/feedback", sravani, 201, json={"insight_id": brief["insight_id"], "rating": "Helpful"})
    assert feedback["rating"] == "Helpful"
    assert client.post(f"{API}/ai/feedback", json={"insight_id": brief["insight_id"], "rating": "Incorrect"},
                       headers=sravani).status_code == 409
    assert client.post(f"{API}/ai/feedback", json={"rating": "Helpful"}, headers=sravani).status_code == 422


def test_next_best_action_ask_and_management_brief(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    create_lead(client, sravani, course_id=course)
    actions = call(client, "post", "/ai/next-best-action", sravani, 201, json={})
    assert len(actions) == 1 and actions[0]["insight_type"] == "Next Best Action"
    assert actions[0]["content"] == "Call to understand goals and book counselling."

    admitted(client, people, course, amount="9000")
    query = call(client, "post", "/ai/ask", bm, 201, json={"question": "How are collections this month?"})
    assert query["model"] == "rules-fallback" and "Verified collections ₹9000.00" in query["recorded_facts"]
    assert query["data_freshness"].startswith(("Complete", "Partial")) and query["requires_human_review"]
    call(client, "post", "/ai/feedback", bm, 201, json={"query_id": query["query_id"], "rating": "Missing Context"})
    assert client.post(f"{API}/ai/feedback", json={"query_id": query["query_id"], "rating": "Helpful"},
                       headers=sravani).status_code == 404  # someone else's question
    brief = call(client, "get", "/ai/management-brief", bm)
    assert brief["insight_type"] == "Management Brief" and "New paid admissions: 1" in brief["content"]
    assert client.post(f"{API}/ai/ask", json={"question": "x"}, headers=sravani).status_code == 403


# ---------------------------------------------------------------- AI: Claude path (fake SDK client)

class FakeMessages:
    def __init__(self, payload, stop_reason="end_turn"):
        self.payload, self.stop_reason, self.calls = payload, stop_reason, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(stop_reason=self.stop_reason, model=kwargs["model"],
                               content=[SimpleNamespace(type="thinking", thinking=""),
                                        SimpleNamespace(type="text", text=json.dumps(self.payload))])


@pytest.fixture
def fake_claude(app, monkeypatch):
    import anthropic

    app.config["ANTHROPIC_API_KEY"] = "test-key"
    holder = {}

    def install(payload, stop_reason="end_turn"):
        messages = FakeMessages(payload, stop_reason)
        monkeypatch.setattr(anthropic, "Anthropic", lambda api_key: SimpleNamespace(beta=SimpleNamespace(messages=messages)))
        holder["messages"] = messages
        return messages

    yield install
    app.config["ANTHROPIC_API_KEY"] = None


def test_brief_with_claude_uses_structured_output(client, people, course, fake_claude):
    messages = fake_claude({"brief": "Ananya is keen on Data Science.", "priority_explanation": "Recently engaged.",
                            "whatsapp_message": "Hi Ananya!"})
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    body = call(client, "post", f"/leads/{lead['lead_id']}/ai/brief", people["sravani"]["h"], 201, json={})

    assert body["brief"]["content"] == "Ananya is keen on Data Science." and body["brief"]["model"] == "claude-opus-5"
    assert body["brief"]["suggested_message"] == "Hi Ananya!"
    request = messages.calls[0]
    assert request["model"] == "claude-opus-5" and request["fallbacks"] == "default"
    assert request["betas"] == ["server-side-fallback-2026-07-01"]
    schema = request["output_config"]["format"]["schema"]
    assert schema["required"] == ["brief", "priority_explanation", "whatsapp_message"] and not schema["additionalProperties"]
    assert '"lead_code": "LD-00001"' in request["messages"][0]["content"]


def test_refusal_falls_back_to_rules(client, people, course, fake_claude):
    fake_claude({}, stop_reason="refusal")
    lead = create_lead(client, people["sravani"]["h"], course_id=course)
    body = call(client, "post", f"/leads/{lead['lead_id']}/ai/brief", people["sravani"]["h"], 201, json={})
    assert body["brief"]["model"] == "rules-fallback"


# ---------------------------------------------------------------- jobs

def test_escalation_job(app, client, people, course, run_sql):
    lead, discussion, ver = priced_lead(client, people, course, extra_concession="500")
    scr = call(client, "post", f"/fee-discussion-versions/{ver['version_id']}/special-closing-requests",
               people["sravani"]["h"], 201, json={"request_reason": "x"})
    run_sql("UPDATE notifications SET escalate_at = now() - interval '1 minute'")

    assert jobs.escalate_notifications() == 1
    escalation = db.session.execute(select(Notification).where(Notification.escalated_from_id.is_not(None))).scalar_one()
    assert escalation.recipient_user_id == people["founder"]["id"] and escalation.category == "Escalation"
    assert escalation.title.startswith("Escalated: Approve special closing")
    assert jobs.escalate_notifications() == 0  # idempotent
    from models import SpecialClosingRequest
    assert db.session.get(SpecialClosingRequest, scr["scr_id"]).escalated_at is not None


def test_demo_reminder_job_creates_tasks(client, people, course, run_sql):
    lead = create_deal(client, people["sravani"]["h"], course_id=course)
    demo = call(client, "post", f"/leads/{lead['lead_id']}/demos", people["sravani"]["h"], 201,
                json={"scheduled_at": future(48)})
    assert jobs.demo_reminders() == 1  # only the booking confirmation is due
    confirmation = db.session.execute(select(DemoReminder).where(
        DemoReminder.demo_id == demo["demo_id"], DemoReminder.reminder_type == "Booking confirmation")).scalar_one()
    db.session.refresh(confirmation)
    assert confirmation.state == "Sent" and confirmation.sent_at
    task = db.session.execute(select(Task).where(Task.demo_id == demo["demo_id"])).scalar_one()
    assert task.owner_user_id == people["sravani"]["id"] and task.task_type.code == "DEMO"
    assert jobs.demo_reminders() == 0


def test_collections_and_broken_promise_jobs(client, people, course, run_sql):
    flow = admitted(client, people, course, plan="TWO_INSTALMENTS", amount="15000")
    backdate_installment(run_sql, flow["invoice"]["invoice_id"], 2, 7)
    assert jobs.collections_reminders() == 1
    task = db.session.execute(select(Task).where(Task.dedupe_key.like("collections:%:7"))).scalar_one()
    assert task.team_role.role_code == "BRANCH_MANAGER" and task.title.startswith("Collections Day +7")
    jobs.collections_reminders()
    assert len(db.session.execute(select(Task).where(Task.dedupe_key.like("collections:%"))).scalars().all()) == 1

    aid = flow["admission"]["admission_id"]
    call(client, "post", f"/admissions/{aid}/promises", people["accounts"]["h"], 201,
         json={"promised_amount": "5000", "promised_date": date.today().isoformat()})
    run_sql("UPDATE payment_promises SET promised_date = current_date - 1")
    assert jobs.broken_promises() == 1
    assert db.session.execute(select(PaymentPromise)).scalar_one().status == "Broken"


def test_contact_hold_skips_collections(client, people, course, run_sql):
    flow = issued_invoice(client, people, course, plan="TWO_INSTALMENTS")
    backdate_installment(run_sql, flow["invoice"]["invoice_id"], 2, 3)
    record_payment(client, people["sravani"]["h"], flow["invoice"]["invoice_id"], "1000")  # pending → contact hold
    assert jobs.collections_reminders() == 0


def test_scheduled_reports_and_cleanup(client, people, course, run_sql):
    admitted(client, people, course)
    call(client, "post", "/scheduled-reports", people["admin"]["h"], 201, json={
        "report_name": "management", "frequency": "Daily", "send_time": "00:00", "period": "Today",
        "recipients": ["founder@nipuna.test"]})
    assert jobs.scheduled_reports() == 1
    run = db.session.execute(select(ReportRun).where(ReportRun.scheduled_report_id.is_not(None))).scalar_one()
    assert run.report_name == "management" and run.delivery_status == "Not Sent"
    assert jobs.scheduled_reports() == 0  # once per day

    run_sql("""INSERT INTO offers (offer_code, offer_name, status, benefit_type, discount_amount, applies_to_all_courses,
                                   valid_from, valid_to, approved_by)
               VALUES ('OLD', 'Old', 'Active', 'Discount Amount', 500, true, current_date - 30, current_date - 1, :a)""",
            a=people["admin"]["id"])
    lead, discussion, ver = priced_lead(client, people, course)
    run_sql("UPDATE user_sessions SET last_seen_at = now() - interval '2 hours'")
    run_sql("UPDATE fee_discussion_versions SET valid_until = current_date - 1 WHERE version_id = :v", v=ver["version_id"])
    result = jobs.cleanup()
    assert result["sessions_closed"] >= 1 and result["fee_versions_expired"] == 1 and result["offers_expired"] == 1
    assert db.session.execute(select(Offer).where(Offer.offer_code == "OLD")).scalar_one().status == "Expired"
    assert db.session.execute(select(UserSession).where(UserSession.revoked_at.is_(None))).first() is None


def test_jobs_cli_lists_and_runs(app):
    runner = app.test_cli_runner()
    listed = runner.invoke(args=["jobs", "list"])
    assert "escalations" in listed.output and "cleanup" in listed.output
    assert runner.invoke(args=["jobs", "run", "nope"]).exit_code != 0
    result = runner.invoke(args=["jobs", "run", "escalations", "broken-promises"])
    assert result.exit_code == 0, result.output
    assert "escalations: 0" in result.output
