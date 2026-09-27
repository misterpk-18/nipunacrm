"""Entry point. The only module that builds the application; nothing imports from here.

Run from backend/:
    flask --app app run
    python app.py
"""
from flask import Flask

from cli import register_cli
from config import get_config
from config.database import db
from config.json_provider import JSONProvider
from config.logging import configure_logging
from controllers.common import error_response_for
from routes import register_blueprints


def create_app(env: str | None = None) -> Flask:
    config = get_config(env)
    configure_logging(config.LOG_LEVEL)

    app = Flask(__name__)
    app.config.from_object(config)
    app.json = JSONProvider(app)

    db.init_app(app)
    register_transaction_hook(app)
    register_error_handlers(app)
    register_blueprints(app)
    register_cli(app)
    return app


def register_transaction_hook(app: Flask) -> None:
    """One database transaction per request: committed on success (< 400), rolled back otherwise."""

    @app.after_request
    def finish_transaction(response):
        if response.status_code >= 400:
            db.session.rollback()
            return response
        try:
            db.session.commit()
        except Exception as exc:  # a deferred check or trigger can still fail at commit
            db.session.rollback()
            return error_response_for(exc)
        return response


def register_error_handlers(app: Flask) -> None:
    """Every exception becomes the standard {"error": {...}} response."""

    @app.errorhandler(Exception)
    def handle_any(exc: Exception):
        return error_response_for(exc)


if __name__ == "__main__":
    create_app().run()
