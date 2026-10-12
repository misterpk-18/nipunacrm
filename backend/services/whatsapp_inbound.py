"""Callbacks from the WhatsApp provider (db 033/034): delivery status of the messages the CRM sent, and the learner's
replies. POST /webhooks/whatsapp is public and guarded by WHATSAPP_WEBHOOK_TOKEN (header X-Webhook-Token, or ?token=).

The body is read in Meta's Cloud API shape (`entry[].changes[].value.statuses[]` / `.messages[]`), also when the
provider flattens it to `{"statuses": [...], "messages": [...]}`. Every body is kept in whatsapp_webhook_log for 30 days,
so the provider's real format can be checked against what the CRM understood. The endpoint always answers 200 for an
authorised call, so the provider never retries a body the CRM can't use.

Status: Delivered / Read move the message forward and never back; Failed is ignored once a message was delivered (out of
order or repeated callbacks change nothing). A callback for a message the CRM doesn't know is logged and ignored.

Replies: recorded in the communications inbox (channel WhatsApp, Inbound, needs a response). Never matched on their own:
one person with that number is "Match Review". When exactly one person and one open lead match, the reply also lands on
the lead's timeline (so the unanswered-lead counters see it) and these keywords act:

| Reply                                         | What happens                                                          |
|-----------------------------------------------|-----------------------------------------------------------------------|
| STOP / UNSUBSCRIBE                            | WhatsApp marketing consent -> Withdrawn (utility messages continue)    |
| DETAILS / INTERESTED / BROCHURE / CALLBACK /  | A follow-up task for the lead's owner (or the branch's Sales team),    |
| BATCH / DEMO                                  | linked to the reply, due in the response time                          |
| YES                                           | the person's latest delivery plan sent for confirmation (and still     |
|                                               | open) is accepted, method whatsapp; nothing to confirm = just recorded |
"""
import hmac
import logging
import re
from datetime import datetime, timezone

from flask import current_app
from sqlalchemy import select

from config.database import db
from models import Communication, ContactChannel, Lead, LeadActivity, Person, WhatsappOutbox, WhatsappWebhookLog
from repositories import leads as leads_repo
from repositories import settings as settings_repo
from services import communications as communications_service
from services import sla, tasks

logger = logging.getLogger(__name__)

STOP_WORDS = ("STOP", "UNSUBSCRIBE")
CONFIRM_WORDS = ("YES",)
REPLY_TASKS = {
    "DETAILS": "send the details they asked for",
    "INTERESTED": "they are interested: call to explain the syllabus, fees and batches",
    "BROCHURE": "send the course brochure",
    "CALLBACK": "call them back",
    "BATCH": "share the upcoming batch details",
    "DEMO": "ask them about an available demo session",
}


def authorised(supplied: str | None) -> bool:
    expected = current_app.config.get("WHATSAPP_WEBHOOK_TOKEN")
    return bool(expected and supplied and hmac.compare_digest(supplied, expected))


def verification(mode: str | None, token: str | None, challenge: str | None) -> str | None:
    """Meta's subscribe handshake: answer the challenge when the token is right."""
    if mode == "subscribe" and authorised(token):
        return challenge or ""
    return None


# ---------------------------------------------------------------- reading the body

def extract(payload) -> tuple[list[dict], list[dict], dict]:
    """(statuses, messages, {wa_id: profile name}) from whichever shape the provider used."""
    statuses, messages, names = [], [], {}

    def walk(node) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        for key in ("entry", "changes"):
            if key in node:
                walk(node[key])
        value = node.get("value", node)
        if isinstance(value, dict):
            statuses.extend(s for s in value.get("statuses") or [] if isinstance(s, dict))
            messages.extend(m for m in value.get("messages") or [] if isinstance(m, dict))
            for contact in value.get("contacts") or []:
                if isinstance(contact, dict):
                    names[str(contact.get("wa_id"))] = (contact.get("profile") or {}).get("name")

    walk(payload)
    return statuses, messages, names


def _at(value) -> datetime:
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return datetime.now(timezone.utc)


def message_text(message: dict) -> str:
    kind = message.get("type") or "message"
    if isinstance(message.get("text"), dict):
        return message["text"].get("body") or ""
    if isinstance(message.get("button"), dict):
        return message["button"].get("text") or message["button"].get("payload") or ""
    interactive = message.get("interactive")
    if isinstance(interactive, dict):
        reply = interactive.get("button_reply") or interactive.get("list_reply") or {}
        return reply.get("title") or reply.get("id") or ""
    if isinstance(message.get("body"), str):
        return message["body"]
    return f"[{kind} message]"


def keyword(text: str) -> str | None:
    words = re.findall(r"[A-Za-z]+", text or "")
    first = words[0].upper() if words else ""
    return first if first in STOP_WORDS or first in CONFIRM_WORDS or first in REPLY_TASKS else None


# ---------------------------------------------------------------- delivery status

def _error_text(item: dict) -> str:
    errors = item.get("errors") or []
    parts = [f"{e.get('title') or e.get('message') or 'error'} ({e.get('code')})" for e in errors if isinstance(e, dict)]
    return "; ".join(parts) or "The provider reported the message as failed"


def apply_status(item: dict) -> str:
    wamid, status = item.get("id"), str(item.get("status") or "").lower()
    row = db.session.execute(select(WhatsappOutbox).where(
        WhatsappOutbox.provider_message_id == wamid)).scalar_one_or_none() if wamid else None
    if row is None:
        return "unknown message"
    at = _at(item.get("timestamp"))
    if status == "delivered":
        if row.status in ("Delivered", "Read"):
            return "already delivered"
        row.status, row.delivered_at = "Delivered", at
    elif status == "read":
        if row.status == "Read":
            return "already read"
        row.status, row.read_at = "Read", at
        row.delivered_at = row.delivered_at or at
    elif status == "failed":
        if row.status in ("Delivered", "Read"):
            return "ignored: already delivered"
        row.status, row.last_error = "Failed", _error_text(item)
    else:
        return f"ignored ({status or 'no status'})"
    db.session.flush()
    return row.status.lower()


# ---------------------------------------------------------------- replies

def _default_branch_id() -> int:
    from models import Branch

    return db.session.execute(select(Branch.branch_id).where(Branch.is_active).order_by(Branch.branch_id).limit(1)).scalar_one()


def _withdraw_consent(person: Person) -> None:
    if person.whatsapp_consent != "Withdrawn":
        person.whatsapp_consent, person.whatsapp_consent_by = "Withdrawn", None
        person.whatsapp_consent_at, person.whatsapp_consent_source = datetime.now(timezone.utc), "Reply STOP"


def apply_message(message: dict, names: dict) -> str:
    wamid = message.get("id")
    if wamid and db.session.execute(select(Communication.communication_id).where(
            Communication.external_message_id == wamid)).first():
        return "already recorded"
    number = re.sub(r"\D", "", str(message.get("from") or ""))
    if not number:
        return "ignored: no sender"
    text = message_text(message)
    candidates = leads_repo.persons_matching(f"+{number}", None)
    person = candidates[0] if len(candidates) == 1 else None
    leads = leads_repo.open_leads_for_persons([person.person_id]) if person else []
    lead = leads[-1] if leads else None  # the newest open lead
    branch_id = lead.branch_id if lead else person.registered_branch_id if person else _default_branch_id()
    channel = db.session.execute(select(ContactChannel).where(ContactChannel.code == "WHATSAPP")).scalar_one()
    now = _at(message.get("timestamp"))
    minutes = settings_repo.get_int("communication_response_staffed_minutes", communications_service.DEFAULT_RESPONSE_MINUTES)

    comm = Communication(
        branch_id=branch_id, contact_channel_id=channel.contact_channel_id, direction="Inbound",
        from_address=f"+{number}", subject=names.get(number), body=text, delivery_status="Received", is_manual=False,
        external_message_id=wamid, needs_response=True, response_due_at=sla.staffed_deadline(branch_id, now, minutes),
        occurred_at=now,
    )
    db.session.add(comm)
    communications_service._match(comm, None, None)  # one person = Match Review; never matched on its own
    db.session.flush()
    word = keyword(text)
    if lead is not None:
        db.session.add(LeadActivity(
            lead_id=lead.lead_id, activity_type="WhatsApp", direction="Inbound", summary=text,
            contact_channel_id=channel.contact_channel_id, communication_id=comm.communication_id,
            occurred_at=now, outcome="Received"))
        lead.last_contacted_at = max(filter(None, (lead.last_contacted_at, now)))
    if word in STOP_WORDS and person is not None:
        _withdraw_consent(person)
        comm.needs_response, comm.response_due_at = False, None
        return "recorded; marketing consent withdrawn"
    if word in CONFIRM_WORDS and person is not None:
        from services import delivery_plans  # imported here: delivery_plans queues WhatsApp messages

        plan = delivery_plans.accept_by_whatsapp(person.person_id, now, comm.communication_id)
        if plan is not None:
            comm.needs_response, comm.response_due_at = False, None
            return f"recorded; delivery plan {plan.plan_code} accepted"
        return "recorded; no delivery plan awaiting confirmation"
    if word in REPLY_TASKS and person is not None:
        tasks.create_system_task(
            "FOLLOW_UP", f"WhatsApp reply '{word}' from {person.full_name}: {REPLY_TASKS[word]}", branch_id,
            comm.response_due_at or now, owner_user_id=lead.assigned_to if lead else None,
            team_role_code=None if lead and lead.assigned_to else "SALES", dedupe_key=f"whatsapp-reply:{wamid or comm.communication_id}",
            communication_id=comm.communication_id)
        return f"recorded; follow-up task for {word}"
    return "recorded" + ("" if person else "; no matching person")


# ---------------------------------------------------------------- entry point

def handle(payload) -> dict:
    statuses, messages, names = extract(payload)
    results = []
    for item in statuses:
        results.append(f"status {item.get('status')}: {apply_status(item)}")
    for message in messages:
        results.append(f"message: {apply_message(message, names)}")
    kind = "status" if statuses and not messages else "message" if messages else "unknown"
    summary = "; ".join(results) or "nothing recognised"
    db.session.add(WhatsappWebhookLog(kind=kind, payload=payload if isinstance(payload, (dict, list)) else {"raw": str(payload)},
                                      result=summary[:300]))
    db.session.flush()
    return {"statuses": len(statuses), "messages": len(messages), "result": summary}


def prune_log(days: int = 30) -> int:
    from sqlalchemy import delete, func

    return db.session.execute(delete(WhatsappWebhookLog).where(
        WhatsappWebhookLog.received_at < func.now() - func.make_interval(0, 0, 0, days))).rowcount
