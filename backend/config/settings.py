"""Configuration classes, read from backend/.env."""
import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.engine import make_url

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _derive_test_database_url(url: str | None) -> str | None:
    """nipunacrm -> nipunacrm_test, unless TEST_DATABASE_URL is set explicitly."""
    if not url:
        return None
    parsed = make_url(url)
    return parsed.set(database=f"{parsed.database}_test").render_as_string(hide_password=False)


class BaseConfig:
    SECRET_KEY = os.getenv("SECRET_KEY", "change-me")
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

    API_PREFIX = "/api/v1"
    PER_PAGE_DEFAULT = 25
    PER_PAGE_MAX = 100

    # SQL migrations are the source of truth for the schema
    MIGRATIONS_DIR = BASE_DIR.parent / "db"

    # Uploaded files (documents, payment proofs, CVs): local disk until production storage is decided
    UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", BASE_DIR / "uploads"))
    MAX_CONTENT_LENGTH = 10 * 1024 * 1024
    ALLOWED_UPLOAD_EXTENSIONS = {"pdf", "png", "jpg", "jpeg", "webp", "doc", "docx"}

    # AI Copilot (step 19): without a key the rule-based fallback is used
    ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
    AI_MODEL = os.getenv("AI_MODEL", "claude-opus-5-5")

    # Nipuna LMS (db 026): admission / course / finance events are posted there by the lms-sync job.
    # Without both values the events stay Pending in lms_outbox.
    LMS_BASE_URL = os.getenv("LMS_BASE_URL")
    LMS_SERVICE_KEY = os.getenv("LMS_SERVICE_KEY")
    # The LMS web app (not its API): "Open in LMS" links on the Waiting for batch screen. Empty = no link shown.
    LMS_WEB_URL = os.getenv("LMS_WEB_URL")
    LMS_TIMEOUT_SECONDS = float(os.getenv("LMS_TIMEOUT_SECONDS", "10"))
    # Round 3: deliver a request's events right after it commits (background thread, short timeout)
    LMS_PUSH_ON_COMMIT = os.getenv("LMS_PUSH_ON_COMMIT", "1") not in ("0", "false", "False")
    LMS_PUSH_TIMEOUT_SECONDS = float(os.getenv("LMS_PUSH_TIMEOUT_SECONDS", "3"))
    # Round 6 (db 045): tell the LMS when a message it sent through POST /lms/whatsapp is Sent / Delivered / Read /
    # Failed / Skipped (WhatsappStatusUpdated events). Off until the LMS has its handler, or every event would fail.
    LMS_WHATSAPP_STATUS_EVENTS = os.getenv("LMS_WHATSAPP_STATUS_EVENTS", "0") in ("1", "true", "True")

    # WhatsApp templates through Pinbot (db 033): queued in whatsapp_outbox, sent by the whatsapp-send job.
    # Nothing is sent unless WHATSAPP_ENABLED is on and both the URL and the key are set. With WHATSAPP_TEST_NUMBERS
    # (comma separated) only those numbers are messaged; every other row is Skipped. Rows older than
    # WHATSAPP_MAX_AGE_HOURS when the sender gets to them are Skipped, so a switched-off period never ends in a flood
    # of stale news.
    WHATSAPP_ENABLED = os.getenv("WHATSAPP_ENABLED", "0") in ("1", "true", "True")
    WHATSAPP_API_URL = os.getenv("WHATSAPP_API_URL")        # https://partnersv1.pinbot.ai/v3/<number id>/messages
    WHATSAPP_API_KEY = os.getenv("WHATSAPP_API_KEY")
    # POST /api/v1/webhooks/whatsapp (delivery status, learners' replies): header X-Webhook-Token or ?token=. Unset = the
    # endpoint answers 401 / 404 and nothing is received.
    WHATSAPP_WEBHOOK_TOKEN = os.getenv("WHATSAPP_WEBHOOK_TOKEN")
    WHATSAPP_TEST_NUMBERS = os.getenv("WHATSAPP_TEST_NUMBERS", "")
    WHATSAPP_TIMEOUT_SECONDS = float(os.getenv("WHATSAPP_TIMEOUT_SECONDS", "10"))
    WHATSAPP_PUSH_ON_COMMIT = os.getenv("WHATSAPP_PUSH_ON_COMMIT", "1") not in ("0", "false", "False")
    WHATSAPP_PUSH_TIMEOUT_SECONDS = float(os.getenv("WHATSAPP_PUSH_TIMEOUT_SECONDS", "3"))
    WHATSAPP_MAX_AGE_HOURS = float(os.getenv("WHATSAPP_MAX_AGE_HOURS", "24"))
    # Invoice-issued wording: "Please review the invoice through <this>" (no learner portal yet)
    WHATSAPP_INVOICE_CHANNEL = os.getenv("WHATSAPP_INVOICE_CHANNEL", "your Nipuna counsellor")


class DevelopmentConfig(BaseConfig):
    DEBUG = True
    # Local development and frontend testing run against the staging replica (nipunacrm-dev)
    SQLALCHEMY_DATABASE_URI = os.getenv("DEV_DATABASE_URL") or os.getenv("DATABASE_URL")
    LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG")


class TestingConfig(BaseConfig):
    TESTING = True
    PASSWORD_HASH_METHOD = "pbkdf2:sha256:1000"  # fast hashing for tests only
    SQLALCHEMY_DATABASE_URI = os.getenv("TEST_DATABASE_URL") or _derive_test_database_url(os.getenv("DATABASE_URL"))
    LOG_LEVEL = "WARNING"
    UPLOAD_DIR = Path(os.getenv("TEST_UPLOAD_DIR", "/tmp/nipuna-test-uploads"))
    ANTHROPIC_API_KEY = None  # tests never call the real API
    LMS_BASE_URL = "http://lms.test"  # tests replace the HTTP call
    LMS_SERVICE_KEY = "test-service-key"
    LMS_WEB_URL = "http://lms-web.test"
    LMS_PUSH_ON_COMMIT = False        # no background threads inside the test transaction
    WHATSAPP_ENABLED = True           # tests replace the HTTP call
    WHATSAPP_API_URL = "http://whatsapp.test/messages"
    WHATSAPP_API_KEY = "test-api-key"
    WHATSAPP_TEST_NUMBERS = ""
    WHATSAPP_WEBHOOK_TOKEN = "test-webhook-token"
    WHATSAPP_PUSH_ON_COMMIT = False


class ProductionConfig(BaseConfig):
    DEBUG = False
