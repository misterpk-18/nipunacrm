"""Health check: is the app up and can it reach the database?"""
import logging

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from config.database import db

logger = logging.getLogger(__name__)


def get_status() -> dict:
    try:
        db.session.execute(text("SELECT 1"))
        database = "ok"
    except SQLAlchemyError:
        logger.exception("Database health check failed")
        db.session.rollback()
        database = "unavailable"

    return {"status": "ok" if database == "ok" else "degraded", "database": database}
