"""Contact rules shared by staff and agents (playbook pages 9, 16, 20): stop contact, the unanswered-lead ceilings and
college outreach limits. The counters come from the lead_contact_counters view, so a call logged by hand and a
message sent from a draft count against the same limit.

Only outbound contact is limited. A learner who calls or writes in can always be answered and recorded.
"""
from datetime import timedelta

from config.database import db
from models import Lead, LeadContactCounter
from repositories import settings as settings_repo
from services.errors import BusinessRule
from services.reports import business_now

OUTREACH = "Outreach Prospect"
LIMITED_CHANNELS = ("Call", "WhatsApp", "Email", "SMS")


def counters(lead_id: int) -> LeadContactCounter:
    """Fresh from the view (an activity added earlier in this transaction must count)."""
    return db.session.get(LeadContactCounter, lead_id, populate_existing=True)


def limits() -> dict:
    return {"calls": settings_repo.get_int("unanswered_call_limit", 5),
            "whatsapp": settings_repo.get_int("unanswered_whatsapp_limit", 3),
            "window_days": settings_repo.get_int("unanswered_window_days", 7),
            "outreach_attempts": settings_repo.get_int("outreach_attempt_limit", 2),
            "outreach_gap_days": settings_repo.get_int("outreach_follow_up_gap_days", 3)}


def stop_contact_reason(lead: Lead) -> str | None:
    person = lead.person
    if person.stop_contact_at is None:
        return None
    return (f"Stop contact recorded on {person.stop_contact_at:%d %b %Y}: {person.stop_contact_reason}. "
            "No outreach until a Branch Manager clears it")


def check(lead: Lead, channel: str, c: LeadContactCounter | None = None, lim: dict | None = None) -> str | None:
    """Why an outbound contact on this channel is blocked right now, or None when it is allowed."""
    stopped = stop_contact_reason(lead)
    if stopped:
        return stopped
    if channel not in LIMITED_CHANNELS:
        return None
    c = c or counters(lead.lead_id)
    lim = lim or limits()
    if lead.intake_status == OUTREACH:
        if c.outbound_attempts >= lim["outreach_attempts"]:
            return (f"College outreach allows {lim['outreach_attempts']} attempts (one call plus one follow-up) until "
                    "the person shows genuine interest; change the intake status once they do")
        if c.outbound_attempts and c.last_outbound_at:
            next_at = c.last_outbound_at + timedelta(days=lim["outreach_gap_days"])
            if business_now() < next_at:
                return f"College outreach follow-up is due from {next_at.astimezone(business_now().tzinfo):%d %b %Y}"
        return None
    if not c.never_reached:
        return None
    if channel == "Call" and c.outbound_calls >= lim["calls"]:
        return (f"Unanswered-lead ceiling reached: {c.outbound_calls} calls without reaching the learner "
                f"(limit {lim['calls']}). Wait for a reply or record a closing state")
    if channel == "WhatsApp" and c.outbound_whatsapp >= lim["whatsapp"]:
        return (f"Unanswered-lead ceiling reached: {c.outbound_whatsapp} WhatsApp messages without a reply "
                f"(limit {lim['whatsapp']}). Wait for a reply or record a closing state")
    return None


def require(lead: Lead, channel: str) -> None:
    reason = check(lead, channel)
    if reason:
        raise BusinessRule(reason)


def summary(lead: Lead) -> dict:
    c = counters(lead.lead_id)
    lim = limits()
    return {
        "stop_contact": lead.person.to_dict()["stop_contact"],
        "never_reached": c.never_reached,
        "is_outreach": lead.intake_status == OUTREACH,
        "calls": {"used": c.outbound_calls, "limit": lim["calls"]},
        "whatsapp": {"used": c.outbound_whatsapp, "limit": lim["whatsapp"]},
        "outreach_attempts": {"used": c.outbound_attempts, "limit": lim["outreach_attempts"]},
        "last_outbound_at": c.last_outbound_at,
        "last_inbound_at": c.last_inbound_at,
        "blocked": {channel: check(lead, channel, c, lim) for channel in ("Call", "WhatsApp", "Email")},
    }
