"""The one place that lists every blueprint."""
from flask import Flask

from routes.admissions import admissions_bp
from routes.ai import ai_bp
from routes.auth import auth_bp
from routes.catalog import catalog_bp
from routes.demos import demos_bp
from routes.fees import fees_bp
from routes.health import health_bp
from routes.leads import leads_bp
from routes.management import management_bp
from routes.masters import masters_bp
from routes.operations import operations_bp
from routes.payments import payments_bp
from routes.pipeline import pipeline_bp
from routes.reference import reference_bp
from routes.students import students_bp
from routes.users import users_bp

BLUEPRINTS = [
    health_bp,
    auth_bp,
    users_bp,
    reference_bp,
    masters_bp,
    catalog_bp,
    leads_bp,
    pipeline_bp,
    demos_bp,
    fees_bp,
    payments_bp,
    admissions_bp,
    students_bp,
    operations_bp,
    management_bp,
    ai_bp,
]


def register_blueprints(app: Flask) -> None:
    prefix = app.config["API_PREFIX"]
    for blueprint in BLUEPRINTS:
        app.register_blueprint(blueprint, url_prefix=prefix + (blueprint.url_prefix or ""))
