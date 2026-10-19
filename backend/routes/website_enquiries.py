"""The nipunatechnologies.com enquiry form: its server posts here with X-Service-Key (WEBSITE_INTAKE_KEY). No login."""
from flask import Blueprint

from controllers import website_enquiries as website_controller
from routes.decorators import website_service_key

website_enquiries_bp = Blueprint("website_enquiries", __name__)


@website_enquiries_bp.post("/integrations/website/enquiries")
@website_service_key
def submit_enquiry():
    return website_controller.submit_enquiry()
