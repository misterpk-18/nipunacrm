"""Steps 16–18: reports, exports, scheduled reports, targets, dashboards, admin / settings."""
import io
from datetime import date, timedelta


from config.database import db
from models import DocumentType, ReportRun
from services import reports as reports_service
from tests.helpers import API, admitted, call, create_lead, lookup_id


def test_period_presets(app):
    from unittest.mock import patch
    from datetime import datetime
    from zoneinfo import ZoneInfo

    fixed = datetime(2026, 9, 26, 12, 0, tzinfo=ZoneInfo("Asia/Kolkata"))  # Saturday
    with patch.object(reports_service, "business_now", return_value=fixed):
        assert reports_service.period_range("Today") == (date(2026, 9, 26), date(2026, 9, 26))
        assert reports_service.period_range("This Week") == (date(2026, 9, 21), date(2026, 9, 27))
        assert reports_service.period_range("Last Week") == (date(2026, 9, 14), date(2026, 9, 20))
        assert reports_service.period_range("This Month") == (date(2026, 9, 1), date(2026, 9, 30))
        assert reports_service.period_range("Last Month") == (date(2026, 8, 1), date(2026, 8, 31))


def test_management_funnel_performance_sla(client, people, course):
    admitted(client, people, course, amount="12000")
    create_lead(client, people["sravani"]["h"], person={"full_name": "Second", "phone": "9000000555"})
    bm = people["bm"]["h"]

    report = call(client, "get", "/reports/management?period=Today", bm)
    assert report["completeness"] in ("Complete", "Partial") and report["cutoff_at"]
    guntur = report["data"]["branches"][0]
    assert guntur["verified_collections"] == "12000.00" and guntur["new_paid_admissions"] == 1
    assert report["data"]["company"]["net"] == "12000.00"
    assert [b["branch"]["branch_id"] for b in report["data"]["branches"]] == [1]

    funnel = call(client, "get", "/reports/funnel?period=Today", bm)["data"]
    stages = {s["stage"]: s["leads"] for s in funnel["stages"]}
    assert funnel["total_leads"] == 2 and stages["New Enquiry"] == 2 and stages["Admitted"] == 1

    by_course = call(client, "get", "/reports/performance?period=Today&by=course", bm)["data"]
    assert by_course[0]["label"] == "Data Science" and by_course[0]["paid_admissions"] == 1
    by_staff = call(client, "get", "/reports/performance?period=Today&by=staff", bm)["data"]
    assert by_staff[0]["label"] == "Sravani" and by_staff[0]["conversion_pct"] == 50.0
    sla = call(client, "get", "/reports/sla?period=Today", bm)["data"]
    assert set(sla["responses"]) == {"Within SLA", "At Risk", "Breached", "Met", "Met Late"}

    assert client.get(f"{API}/reports/management?period=Custom", headers=bm).status_code == 400
    assert client.get(f"{API}/reports/management", headers=people["sravani"]["h"]).status_code == 403
    assert call(client, "get", "/reports/management?period=Today", people["bm_vij"]["h"])["data"]["company"]["net"] == "0.00"


def test_export_writes_report_run(client, people, course):
    admitted(client, people, course)
    response = client.get(f"{API}/reports/management/export?period=Today&format=csv", headers=people["admin"]["h"])
    assert response.status_code == 200 and response.mimetype == "text/csv"
    lines = response.get_data(as_text=True).strip().splitlines()
    assert lines[0].startswith("branch,verified_collections") and lines[-1].startswith("Company,")
    run = db.session.get(ReportRun, int(response.headers["X-Report-Run-Id"]))
    assert run.report_name == "management" and run.format == "CSV"
    assert client.get(f"{API}/reports/funnel/export?format=pdf", headers=people["admin"]["h"]).status_code == 422


def test_scheduled_reports(client, people):
    admin = people["admin"]["h"]
    body = {"report_name": "management", "frequency": "Weekly", "schedule_day": 1, "send_time": "08:00",
            "period": "Last Week", "recipients": ["founder@nipuna.test"]}
    assert client.post(f"{API}/scheduled-reports", json={**body, "recipients": []}, headers=admin).status_code == 400
    assert client.post(f"{API}/scheduled-reports", json={**body, "recipients": ["nope"]}, headers=admin).status_code == 400
    assert client.post(f"{API}/scheduled-reports", json={**body, "schedule_day": None}, headers=admin).status_code == 400
    created = call(client, "post", "/scheduled-reports", admin, 201, json=body)
    assert created["recipients"] == ["founder@nipuna.test"] and created["send_time"] == "08:00"
    updated = call(client, "patch", f"/scheduled-reports/{created['scheduled_report_id']}", admin, json={"is_active": False})
    assert updated["is_active"] is False


def test_targets_approve_supersede_and_achievement(client, people, course):
    admin, founder = people["admin"]["h"], people["founder"]["h"]
    first_day = date.today().replace(day=1)
    last_day = (first_day + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    body = {"period_start": first_day.isoformat(), "period_end": last_day.isoformat(), "lines": [
        {"branch_id": None, "verified_collections_target": "100000", "paid_admissions_target": 10},
        {"branch_id": 1, "verified_collections_target": "60000", "paid_admissions_target": 6},
        {"branch_id": 2}]}
    assert client.post(f"{API}/targets", headers=admin, json={**body, "lines": [{"branch_id": 1}, {"branch_id": 1}]}).status_code == 400
    v1 = call(client, "post", "/targets", admin, 201, json=body)
    assert v1["version_code"] == f"TM-{first_day:%Y-%m}-v1" and v1["status"] == "Draft" and len(v1["lines"]) == 3
    assert client.post(f"{API}/targets/{v1['target_version_id']}/approve", headers=people["bm"]["h"]).status_code == 403
    call(client, "post", f"/targets/{v1['target_version_id']}/approve", founder)
    v2 = call(client, "post", "/targets", admin, 201, json=body)
    call(client, "post", f"/targets/{v2['target_version_id']}/approve", founder)
    assert call(client, "get", f"/targets/{v1['target_version_id']}", admin)["status"] == "Superseded"
    assert client.post(f"{API}/targets/{v1['target_version_id']}/approve", headers=founder).status_code == 422

    admitted(client, people, course, amount="30000")
    rows = {r["scope"]: r for r in call(client, "get", f"/targets/achievement?date={date.today()}", admin)}
    assert rows["NIT-GNT"]["verified_collections"] == "30000.00" and rows["NIT-GNT"]["collections_pct"] == "50.00"
    assert rows["Company"]["paid_admissions"] == 1 and rows["NIT-VIJ"]["paid_admissions_target"] is None
    bm_rows = call(client, "get", "/targets/achievement", people["bm"]["h"])
    assert {r["scope"] for r in bm_rows} == {"NIT-GNT"}


def test_dashboards_are_role_aware(client, people, course):
    admitted(client, people, course, amount="15000")
    company = call(client, "get", "/dashboard?period=Today", people["admin"]["h"])
    assert company["view"] == "company" and company["company"]["verified_collections"] == "15000.00"
    assert len(company["branches"]) == 2

    bm = call(client, "get", "/dashboard?period=Today", people["bm"]["h"])
    assert bm["view"] == "branch_manager" and bm["tiles"]["paid_admissions"] == 1
    assert bm["top_staff"][0]["full_name"] == "Sravani"
    assert set(bm["approval_queues"]) == {"can_approve", "higher_approval", "awaiting_execution"}
    assert bm["funnel"]["total_leads"] == 1

    staff = call(client, "get", "/dashboard", people["accounts"]["h"])
    assert staff["view"] == "staff"
    workspace = call(client, "get", "/dashboard/counsellor", people["sravani"]["h"])
    assert set(workspace["queues"]) >= {"new", "overdue", "hot"} and workspace["tasks"] == {"due_today": 0, "overdue": 0}
    assert client.get(f"{API}/dashboard/counsellor", headers=people["accounts"]["h"]).status_code == 403


def test_marking_a_lead_spam_or_test_updates_genuine_enquiries(client, people, course):
    sravani, bm = people["sravani"]["h"], people["bm"]["h"]
    genuine = lambda: call(client, "get", "/dashboard?period=Today", bm)["tiles"]["genuine_enquiries"]  # noqa: E731
    lead = create_lead(client, sravani, course_id=course)
    assert genuine() == 1

    call(client, "patch", f"/leads/{lead['lead_id']}", sravani, json={"intake_status": "Invalid-Spam"})
    assert genuine() == 0
    call(client, "patch", f"/leads/{lead['lead_id']}", sravani, json={"intake_status": "Test"})
    assert genuine() == 0
    call(client, "patch", f"/leads/{lead['lead_id']}", sravani, json={"intake_status": "New"})
    assert genuine() == 1


# ---------------------------------------------------------------- admin

def test_integrations_incidents_and_audit_log(client, people):
    admin = people["admin"]["h"]
    integrations = call(client, "get", "/integrations", admin)
    assert {i["service_code"] for i in integrations} >= {"WHATSAPP", "LMS", "HDFC"}
    updated = call(client, "patch", "/integrations/lms", admin, json={"state": "Configured", "verification": "Verified"})
    assert updated["state"] == "Configured" and updated["last_successful_test_at"]
    assert client.get(f"{API}/integrations", headers=people["bm"]["h"]).status_code == 403

    incident = call(client, "post", "/incidents", admin, 201, json={"title": "WhatsApp number blocked", "severity": "High"})
    assert incident["incident_code"] == "IR-00001"
    resolved = call(client, "patch", f"/incidents/{incident['incident_id']}", admin,
                    json={"status": "Resolved", "root_cause": "Spam reports"})
    assert resolved["resolved_at"]

    log = call(client, "get", "/audit-log?action=integration_updated", admin)
    assert log[0]["entity_id"] == "LMS"


def test_deletion_requests_need_independent_approval(client, people, course):
    flow = admitted(client, people, course)
    person_id = flow["admission"]["person"]["person_id"]
    document = client.post(f"{API}/persons/{person_id}/documents", headers=people["nikhil"]["h"],
                           content_type="multipart/form-data",
                           data={"document_type_id": str(lookup_id(DocumentType, "PHOTO")),
                                 "file": (io.BytesIO(b"img"), "photo.png")}).get_json()["data"]
    admin, founder = people["admin"]["h"], people["founder"]["h"]
    assert client.post(f"{API}/deletion-requests", json={"entity_type": "payment", "entity_id": 1, "reason": "x"},
                       headers=admin).status_code == 400
    request = call(client, "post", "/deletion-requests", admin, 201,
                   json={"entity_type": "document", "entity_id": document["document_id"], "reason": "Uploaded to wrong person"})
    rid = request["request_id"]
    assert client.post(f"{API}/deletion-requests/{rid}/execute", headers=founder).status_code == 422
    assert client.post(f"{API}/deletion-requests/{rid}/approve", headers=admin).status_code == 403
    call(client, "post", f"/deletion-requests/{rid}/approve", founder)
    executed = call(client, "post", f"/deletion-requests/{rid}/execute", founder)
    assert executed["status"] == "Executed" and executed["executed_at"]
    assert call(client, "get", f"/students/{person_id}/documents", people["bm"]["h"])["documents"] == []


def test_admin_can_force_sign_out(client, people, make_user, login):
    user = make_user(roles=[("SALES", 1)])
    headers = login(user.email)
    sessions = call(client, "get", f"/admin/sessions?user_id={user.user_id}", people["admin"]["h"])
    assert len(sessions) == 1 and sessions[0]["user"]["email"] == user.email
    assert client.delete(f"{API}/admin/sessions/{sessions[0]['session_id']}", headers=people["admin"]["h"]).status_code == 204
    assert client.get(f"{API}/auth/me", headers=headers).status_code == 401
