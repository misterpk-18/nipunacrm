"""AI Copilot: before-call briefs, priority explanations, suggested WhatsApp messages (English / Telugu),
next best actions, Ask Nipuna and management briefs.

Every output is advisory, stored (ai_insights / ai_queries) and marked as needing human review. The model only
sees facts pulled from the CRM for the user's scope and is told to use nothing else. With ANTHROPIC_API_KEY set,
Claude writes the text as schema-validated JSON; otherwise (or if the call fails) a rule-based writer is used.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from flask import current_app
from sqlalchemy import select

from config.database import db
from models import AiFeedback, AiInsight, AiQuery, Demo, FeeDiscussion, Lead
from repositories import leads as leads_repo
from services import leads as leads_service
from services import reports as reports_service
from services.context import current_user
from services.errors import BusinessRule, NotFound

logger = logging.getLogger(__name__)
RULES_MODEL = "rules-fallback"

SYSTEM = (
    "You are Nipuna Copilot, an assistant for the sales and management staff of Nipuna, a training institute in "
    "Andhra Pradesh, India. You receive CRM facts as JSON. Use only those facts: never invent numbers, dates, "
    "names, offers or promises, and never promise placements or discounts. If something needed isn't in the facts, "
    "say it's missing. Staff review everything you write before using it."
)


# ---------------------------------------------------------------- model call

def _claude(task: str, facts: dict, schema: dict) -> tuple[dict | None, str]:
    """Structured JSON from Claude, or (None, reason) when AI isn't configured or the call fails."""
    api_key = current_app.config.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None, RULES_MODEL
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)
        response = client.beta.messages.create(
            model=current_app.config["AI_MODEL"],
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM,
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": f"{task}\n\nCRM facts:\n{json.dumps(facts, default=str, sort_keys=True)}"}],
        )
        if response.stop_reason in ("refusal", "max_tokens"):
            logger.warning("AI call ended with %s; using the rule-based fallback", response.stop_reason)
            return None, RULES_MODEL
        text = next(block.text for block in response.content if block.type == "text")
        return json.loads(text), response.model
    except Exception:  # advisory feature: any API / parsing failure falls back to rules
        logger.exception("AI call failed; using the rule-based fallback")
        return None, RULES_MODEL


def _schema(**fields: str) -> dict:
    return {"type": "object", "properties": {name: {"type": kind} for name, kind in fields.items()},
            "required": list(fields), "additionalProperties": False}


def _store(insight_type: str, content: str, *, model: str, lead: Lead | None = None, **fields) -> AiInsight:
    insight = AiInsight(insight_type=insight_type, content=content, model=model, requires_human_review=True,
                        lead_id=lead.lead_id if lead else None, person_id=lead.person_id if lead else None,
                        branch_id=lead.branch_id if lead else fields.pop("branch_id", None),
                        for_user_id=current_user().user_id, evidence_as_of=datetime.now(timezone.utc), **fields)
    db.session.add(insight)
    return insight


# ---------------------------------------------------------------- lead facts

def lead_facts(lead: Lead) -> dict:
    now = datetime.now(timezone.utc)
    demos = list(db.session.execute(select(Demo).where(Demo.lead_id == lead.lead_id).order_by(Demo.scheduled_at)).scalars())
    fee = db.session.execute(select(FeeDiscussion).where(FeeDiscussion.lead_id == lead.lead_id)
                             .order_by(FeeDiscussion.fee_discussion_id.desc())).scalars().first()
    activities = db.session.execute(leads_repo.activities_stmt(lead.lead_id).limit(8)).scalars()
    return {
        "lead_code": lead.lead_code, "name": lead.person.full_name, "preferred_language": lead.person.preferred_language,
        "course": lead.course.course_title if lead.course else None, "branch": lead.branch.branch_name,
        "stage": lead.stage, "priority": lead.ai_priority, "score": lead.ai_score, "source": lead.source.label,
        "campaign": lead.campaign, "remarks": lead.remarks, "owner": lead.owner.full_name if lead.owner else None,
        "age_days": (now - lead.created_at).days,
        "days_since_contact": (now - lead.last_contacted_at).days if lead.last_contacted_at else None,
        "next_follow_up_at": lead.next_follow_up_at,
        "follow_up_overdue": bool(lead.next_follow_up_at and lead.next_follow_up_at < now),
        "demos": [{"code": d.demo_code, "status": d.status, "at": d.scheduled_at, "outcome": d.outcome,
                   "student_feedback": d.student_feedback} for d in demos],
        "fee": {"milestone": fee.milestone, "final_payable": fee.current_version.final_payable if fee.current_version else None,
                "version_status": fee.current_version.status if fee.current_version else None} if fee else None,
        "recent_activity": [{"type": a.activity_type, "at": a.occurred_at, "purpose": a.purpose, "outcome": a.outcome,
                             "summary": a.summary} for a in activities],
    }


def _sources(lead: Lead) -> list[dict]:
    return [{"type": "lead", "id": lead.lead_id, "code": lead.lead_code}, {"type": "lead_activities", "lead_id": lead.lead_id},
            {"type": "demos", "lead_id": lead.lead_id}, {"type": "fee_discussions", "lead_id": lead.lead_id}]


# ---------------------------------------------------------------- rule-based writer

def _rules_brief(f: dict) -> dict:
    parts = [f"{f['name']} · {f['course'] or 'course not chosen'} · {f['stage']}."]
    parts.append(f"Last contact {f['days_since_contact']} day(s) ago." if f["days_since_contact"] is not None
                 else "Not contacted yet.")
    attended = [d for d in f["demos"] if d["status"] == "Attended"]
    if f["demos"]:
        parts.append(f"{len(attended)} of {len(f['demos'])} demo(s) attended" +
                     (f" (latest outcome: {attended[-1]['outcome']})." if attended and attended[-1]["outcome"] else "."))
    if f["fee"]:
        parts.append(f"Fee discussion: {f['fee']['milestone']}, final payable ₹{f['fee']['final_payable']}.")
    if f["follow_up_overdue"]:
        parts.append("The follow-up is overdue.")
    if f["recent_activity"]:
        last = f["recent_activity"][0]
        parts.append(f"Last activity: {last['type']}{' · ' + last['summary'] if last['summary'] else ''}.")

    reasons = []
    if f["priority"]:
        reasons.append(f"Marked {f['priority']}" + (f" · {f['score']}" if f["score"] is not None else ""))
    if f["stage"] in ("Demo Attended", "Fee Discussion / Payment Awaited"):
        reasons.append(f"late in the pipeline ({f['stage']})")
    if f["days_since_contact"] is not None and f["days_since_contact"] <= 2:
        reasons.append("contacted recently")
    if f["follow_up_overdue"]:
        reasons.append("follow-up overdue")
    next_step = {"New Enquiry": "Call to understand goals and book counselling.",
                 "Counselling": "Offer a demo slot.", "Demo Scheduled": "Confirm the demo time.",
                 "Demo Attended": "Discuss fees and plan within 2 staffed hours of the demo.",
                 "Fee Discussion / Payment Awaited": "Resolve fee questions and share the invoice.",
                 "Payment Pending Verification": "Wait for Accounts to verify the payment; no chasing needed."}
    parts.append("Suggested next step: " + next_step.get(f["stage"], "Review the record before calling."))
    return {"brief": " ".join(parts),
            "priority_explanation": ("; ".join(reasons).capitalize() + ".") if reasons else "No strong priority signals recorded."}


def _rules_message(f: dict, language: str, sender: str) -> str:
    course = f["course"] or "our courses"
    if language == "Telugu":
        return (f"నమస్కారం {f['name']} గారు, నిపుణ నుండి {sender}. {course} కోర్సు గురించి మాట్లాడటానికి "
                "ఈరోజు మీకు ఎప్పుడు వీలవుతుంది?")
    return f"Hi {f['name']}, this is {sender} from Nipuna. When would be a good time today to talk about {course}?"


# ---------------------------------------------------------------- lead brief

def lead_brief(lead_id: int, language: str | None) -> list[AiInsight]:
    lead = leads_service.get_lead(lead_id)
    facts = lead_facts(lead)
    language = language or facts["preferred_language"]
    sender = current_user().full_name
    task = (f"Write a before-call brief for {sender}: who this is, where they are, what happened last and the next "
            f"step (under 120 words). Explain in one or two sentences why the lead has its current priority. Then "
            f"draft a short, friendly WhatsApp message from {sender} in {language}"
            + (" (Telugu script)" if language == "Telugu" else "") + " asking for a good time to talk.")
    data, model = _claude(task, facts, _schema(brief="string", priority_explanation="string", whatsapp_message="string"))
    if data is None:
        data = {**_rules_brief(facts), "whatsapp_message": _rules_message(facts, language, sender)}
    sources = _sources(lead)
    brief = _store("Before-Call Brief", data["brief"], model=model, lead=lead, suggested_message=data["whatsapp_message"],
                   language=language, score=lead.ai_score, priority=lead.ai_priority, sources=sources)
    why = _store("Priority Explanation", data["priority_explanation"], model=model, lead=lead, language=language,
                 score=lead.ai_score, priority=lead.ai_priority, sources=sources)
    db.session.flush()
    return [brief, why]


def lead_insights(lead_id: int) -> list[AiInsight]:
    leads_service.get_lead(lead_id)
    return list(db.session.execute(select(AiInsight).where(AiInsight.lead_id == lead_id)
                                   .order_by(AiInsight.created_at.desc(), AiInsight.insight_id.desc())).scalars())


# ---------------------------------------------------------------- next best action

def next_best_actions(limit: int) -> list[AiInsight]:
    """For the counsellor's own queue, most urgent first (the workspace order)."""
    leads = list(db.session.execute(leads_repo.workspace_stmt(current_user().user_id).limit(limit)).scalars())
    if not leads:
        return []
    facts = {"leads": [lead_facts(lead) for lead in leads]}
    schema = {"type": "object", "additionalProperties": False, "required": ["actions"], "properties": {"actions": {
        "type": "array", "items": _schema(lead_code="string", action="string")}}}
    data, model = _claude("For each lead, give the single next best action for today in one sentence.", facts, schema)
    by_code = {a["lead_code"]: a["action"] for a in (data or {}).get("actions", [])}
    insights = []
    for lead, f in zip(leads, facts["leads"]):
        action = by_code.get(lead.lead_code) or _rules_brief(f)["brief"].split("Suggested next step: ")[-1]
        insights.append(_store("Next Best Action", action, model=model if lead.lead_code in by_code else RULES_MODEL,
                               lead=lead, score=lead.ai_score, priority=lead.ai_priority, sources=_sources(lead)))
    db.session.flush()
    return insights


# ---------------------------------------------------------------- Ask Nipuna / management brief

def _management_facts(filters: dict) -> tuple[dict, dict]:
    start, end = reports_service.period_range(filters.get("period", "This Month"), filters.get("from"), filters.get("to"))
    scope = {k: filters[k] for k in ("branch_id",) if filters.get(k)}
    cutoff_at, completeness, notes = reports_service.cutoff(end)
    facts = {"period": {"from": start, "to": end}, "management": reports_service.management(start, end, scope),
             "funnel": reports_service.funnel(start, end, scope), "completeness": completeness,
             "completeness_notes": notes, "report_cutoff_at": cutoff_at}
    meta = {"start": start, "end": end, "cutoff_at": cutoff_at, "completeness": completeness, "notes": notes}
    return facts, meta


def _recorded_facts(facts: dict) -> str:
    company = facts["management"]["company"]
    stages = {s["stage"]: s["leads"] for s in facts["funnel"]["stages"]}
    return "\n".join([
        f"Verified collections ₹{company['verified_collections']} (net of reversals); refunds ₹{company['refunds']}; "
        f"net ₹{company['net']}.",
        f"New paid admissions: {company['new_paid_admissions']}.",
        f"Pending verification (not counted): ₹{company['pending_verification_excluded']}.",
        f"Leads created: {facts['funnel']['total_leads']}; reached demo attended: {stages.get('Demo Attended', 0)}; "
        f"admitted: {stages.get('Admitted', 0)}; lost: {stages.get('Lost - closed', 0)}.",
    ] + [f"{b['branch']['branch_code']}: collections ₹{b['verified_collections']}, paid admissions {b['new_paid_admissions']}."
         for b in facts["management"]["branches"]])


def ask(data: dict) -> AiQuery:
    facts, meta = _management_facts(data)
    schema = _schema(answer="string", recorded_facts="string", possible_explanation="string", missing_evidence="string")
    task = ("Answer the staff member's question from the facts. Separate what is recorded from what might explain it, "
            f"and list any evidence you'd need but don't have. Answer in {data.get('language', 'English')}.\n\n"
            f"Question: {data['question']}")
    answer, model = _claude(task, facts, schema)
    recorded = _recorded_facts(facts)
    if answer is None:
        answer = {"answer": "AI answers aren't available right now; here are the recorded figures for the period.",
                  "recorded_facts": recorded, "possible_explanation": "Not generated (rule-based mode).",
                  "missing_evidence": "Anything beyond collections, admissions and the lead funnel."}
    freshness = f"{meta['completeness']} · cutoff {meta['cutoff_at']:%d %b %Y %H:%M}" + (
        f" · {meta['notes']}" if meta["notes"] else "")
    query = AiQuery(user_id=current_user().user_id, question=data["question"], language=data.get("language", "English"),
                    branch_id=data.get("branch_id"), period_start=meta["start"], period_end=meta["end"],
                    report_cutoff_at=meta["cutoff_at"], answer=answer["answer"], recorded_facts=answer["recorded_facts"],
                    possible_explanation=answer["possible_explanation"], missing_evidence=answer["missing_evidence"],
                    data_freshness=freshness, model=model,
                    sources=[{"type": "report", "name": "management"}, {"type": "report", "name": "funnel"}],
                    supporting_table=json.loads(json.dumps(facts["management"], default=str)))
    db.session.add(query)
    db.session.flush()
    return query


def management_brief(filters: dict) -> AiInsight:
    facts, meta = _management_facts(filters)
    data, model = _claude("Write a short management brief (under 150 words) on collections, admissions and the funnel, "
                          "noting anything that needs attention.", facts, _schema(brief="string"))
    content = data["brief"] if data else _recorded_facts(facts)
    insight = _store("Management Brief", content, model=model, branch_id=filters.get("branch_id"),
                     sources=[{"type": "report", "name": "management", "from": str(meta["start"]), "to": str(meta["end"])}])
    db.session.flush()
    return insight


# ---------------------------------------------------------------- feedback

def feedback(data: dict) -> AiFeedback:
    user = current_user()
    if bool(data.get("insight_id")) == bool(data.get("query_id")):
        raise BusinessRule("Give feedback on one insight or one query")
    if data.get("insight_id"):
        insight = db.session.get(AiInsight, data["insight_id"])
        if insight is None or (insight.branch_id and not user.can_access_branch(insight.branch_id)):
            raise NotFound("Insight not found")
    else:
        query = db.session.get(AiQuery, data["query_id"])
        if query is None or query.user_id != user.user_id:
            raise NotFound("Query not found")
    row = AiFeedback(insight_id=data.get("insight_id"), query_id=data.get("query_id"), user_id=user.user_id,
                     rating=data["rating"], comment=data.get("comment"))
    db.session.add(row)
    db.session.flush()  # one feedback per user per insight / query
    return row


# ---------------------------------------------------------------- counselling brief (playbook page 6)

COUNSELLING_PROMPT_VERSION = "counselling-v1"


def counselling_brief(lead_id: int, language: str | None):
    """Understood need, one useful question, up to three suitable course options (only courses this branch offers),
    approved information to share (only Approved knowledge ids) and one next action. Unknown fee, timetable or
    academic claims are flagged for the responsible reviewer, never invented. Stored as an AI action record."""
    from models import AiAction, Course, CourseBranch, LeadObjection
    from services import playbook

    lead = playbook._contactable(lead_id)
    playbook.require_drafts(lead.branch_id)
    language = language or lead.person.preferred_language
    offered = list(db.session.execute(
        select(Course).join(CourseBranch, CourseBranch.course_id == Course.course_id)
        .where(CourseBranch.branch_code == lead.branch.branch_code, Course.status == "Active")
        .order_by(Course.course_title)).scalars())
    content = playbook.approved_content(lead)
    objections = db.session.execute(select(LeadObjection).where(LeadObjection.lead_id == lead.lead_id,
                                                                LeadObjection.status == "Open")).scalars().all()
    facts = {**lead_facts(lead),
             "need": {f: getattr(lead, f) for f in ("learner_goal", "prior_experience", "preferred_timing",
                                                    "joining_window", "open_question")},
             "missing": playbook.missing_need(lead),
             "open_objections": [{"words": o.learner_words, "category": o.category} for o in objections],
             "courses_offered_here": [{"course_code": c.course_code, "title": c.course_title} for c in offered],
             "offerable_batches": [{"batch": b.batch_code, "starts": b.start_date, "timing": b.timing(),
                                    "mode": b.delivery_mode, "seats_left": b.seats_left}
                                   for b in playbook.batches_for(lead.course_id, lead.branch_id) if b.is_offerable],
             "approved_information": [{"id": k.knowledge_id, "kind": k.kind, "title": k.title, "body": k.body,
                                       "link": k.link_url} for k in content]}
    schema = {"type": "object", "additionalProperties": False,
              "required": ["understood_need", "useful_question", "course_options", "info_to_share", "next_action",
                           "missing_checks"],
              "properties": {
                  "understood_need": {"type": "string"}, "useful_question": {"type": "string"},
                  "course_options": {"type": "array", "items": _schema(course_code="string", why="string")},
                  "info_to_share": {"type": "array", "items": {"type": "integer"}},
                  "next_action": {"type": "string"},
                  "missing_checks": {"type": "array", "items": {"type": "string"}}}}
    task = (f"Prepare a counselling brief in {language}" + (" (Telugu script)" if language == "Telugu" else "") +
            " for the staff member about to talk to this learner. Ask only what is missing: give ONE useful question. "
            "Suggest up to three course options only from courses_offered_here and only if they fit the stated goal; "
            "never recommend a course because its fee is higher, and say none fits if none does. info_to_share may only "
            "contain ids from approved_information. If a fee, timetable, batch or academic fact is not in the facts, "
            "add it to missing_checks for the responsible reviewer instead of stating it. Only offerable_batches may be "
            "named, and only with their recorded timing; a batch whose timing is not confirmed is not a match. No invented urgency, "
            "last-seat claims, deadlines, discounts or job guarantees. One next action that ends in a commitment "
            "(a callback time, a demo slot, a syllabus share or an invoice request).")
    data, model = _claude(task, facts, schema)
    codes = {c.course_code: c for c in offered}
    allowed_ids = {k.knowledge_id for k in content}
    if data is None:
        first_missing = facts["missing"][0] if facts["missing"] else None
        card = playbook.recommend(lead)
        data = {"understood_need": lead.learner_goal or f"Interested in {lead.course.course_title if lead.course else 'a course'}"
                                                         f"; goal not recorded yet",
                "useful_question": playbook.NEED_QUESTIONS[first_missing] if first_missing else
                "What do you need to decide? Would a syllabus, counselling call, parent discussion or demo help?",
                "course_options": [{"course_code": lead.course.course_code, "why": "The course they enquired about"}]
                if lead.course else [],
                "info_to_share": [k.knowledge_id for k in content if k.course_id == lead.course_id][:2],
                "next_action": card["suggestion"] if card else "Agree one next step with a date",
                "missing_checks": [] if any(b.is_offerable and b.timing_confirmed for b in
                                            playbook.batches_for(lead.course_id, lead.branch_id))
                else ["No offerable batch with confirmed timing yet: check with the Branch Manager"]}
    options = [o for o in data["course_options"] if o["course_code"] in codes][:3]
    shared = [i for i in data["info_to_share"] if i in allowed_ids]
    dropped = len(data["course_options"]) - len(options) + len(data["info_to_share"]) - len(shared)
    payload = {"understood_need": data["understood_need"], "useful_question": data["useful_question"],
               "course_options": [{**o, "title": codes[o["course_code"]].course_title,
                                   "course_id": codes[o["course_code"]].course_id} for o in options],
               "info_to_share": [k.to_dict() for k in content if k.knowledge_id in shared],
               "missing_checks": data["missing_checks"], "language": language,
               "dropped_unverified_items": dropped}
    action = AiAction(action_type="Counselling brief", action_code="counselling_brief",
                      fingerprint=playbook.fingerprint(facts), lead_id=lead.lead_id, person_id=lead.person_id,
                      branch_id=lead.branch_id, owner_user_id=lead.assigned_to, suggestion=data["next_action"],
                      reason=data["understood_need"], evidence=[s for s in _sources(lead)] +
                      [{"type": "sales_knowledge", "id": k.knowledge_id, "version": k.version} for k in content],
                      payload=json.loads(json.dumps(payload, default=str)), record_version=lead.updated_at,
                      model=model, prompt_version=COUNSELLING_PROMPT_VERSION, policy_version=playbook.POLICY_VERSION,
                      expires_at=datetime.now(timezone.utc) + timedelta(hours=24), created_by=current_user().user_id)
    db.session.add(action)
    db.session.flush()
    return action
