"""WhatsApp messages, consent, marketing sends and the provider's callback (db 033/034)."""
from flask import Blueprint

from controllers import whatsapp as whatsapp_controller
from routes.decorators import lms_service_key, login_required, require_roles
from services.context import FINANCE_ROLES, LEAD_ROLES, MANAGER_ROLES

whatsapp_bp = Blueprint("whatsapp", __name__)
RETRY_ROLES = MANAGER_ROLES + ("ACCOUNTS",)


@whatsapp_bp.get("/whatsapp/messages")
@login_required
@require_roles(*FINANCE_ROLES)
def list_messages():
    return whatsapp_controller.list_messages()


@whatsapp_bp.get("/whatsapp/summary")
@login_required
@require_roles(*FINANCE_ROLES)
def summary():
    return whatsapp_controller.summary()


@whatsapp_bp.post("/whatsapp/messages/<int:outbox_id>/retry")
@login_required
@require_roles(*RETRY_ROLES)
def retry(outbox_id: int):
    return whatsapp_controller.retry(outbox_id)


@whatsapp_bp.get("/whatsapp/marketing-templates")
@login_required
@require_roles(*FINANCE_ROLES)
def marketing_templates():
    return whatsapp_controller.marketing_templates()


@whatsapp_bp.get("/persons/<int:person_id>/whatsapp")
@login_required
@require_roles(*FINANCE_ROLES)
def person_conversation(person_id: int):
    return whatsapp_controller.person_conversation(person_id)


@whatsapp_bp.put("/persons/<int:person_id>/whatsapp-consent")
@login_required
@require_roles(*LEAD_ROLES)
def record_consent(person_id: int):
    return whatsapp_controller.record_consent(person_id)


@whatsapp_bp.put("/persons/<int:person_id>/whatsapp-notifications")
@login_required
@require_roles(*LEAD_ROLES)
def set_notifications(person_id: int):
    return whatsapp_controller.set_notifications(person_id)


@whatsapp_bp.post("/persons/<int:person_id>/whatsapp/send")
@login_required
@require_roles(*LEAD_ROLES)
def send_to_person(person_id: int):
    return whatsapp_controller.send_to_person(person_id)


@whatsapp_bp.post("/leads/<int:lead_id>/whatsapp/marketing")
@login_required
@require_roles(*LEAD_ROLES)
def send_marketing(lead_id: int):
    return whatsapp_controller.send_marketing(lead_id)


@whatsapp_bp.get("/webhooks/whatsapp")
def webhook_verify():
    return whatsapp_controller.webhook_verify()


@whatsapp_bp.post("/webhooks/whatsapp")
def webhook_receive():
    return whatsapp_controller.webhook_receive()


@whatsapp_bp.post("/lms/whatsapp")
@lms_service_key
def lms_send():
    return whatsapp_controller.lms_send()
