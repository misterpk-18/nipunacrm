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
    AI_MODEL = os.getenv("AI_MODEL", "claude-opus-5")


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


class ProductionConfig(BaseConfig):
    DEBUG = False
