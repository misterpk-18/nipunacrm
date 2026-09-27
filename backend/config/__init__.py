"""Pick the config class for an environment (APP_ENV: development / test / production)."""
import os

from config.settings import BaseConfig, DevelopmentConfig, ProductionConfig, TestingConfig

CONFIGS: dict[str, type[BaseConfig]] = {
    "development": DevelopmentConfig,
    "test": TestingConfig,
    "production": ProductionConfig,
}


def get_config(env: str | None = None) -> type[BaseConfig]:
    env = env or os.getenv("APP_ENV", "development")
    if env not in CONFIGS:
        raise ValueError(f"Unknown APP_ENV '{env}'; expected one of {', '.join(CONFIGS)}")

    config = CONFIGS[env]
    if not config.SQLALCHEMY_DATABASE_URI:
        raise RuntimeError("DATABASE_URL is not set (see backend/.env.example)")
    if env == "production" and config.SECRET_KEY == "change-me":
        raise RuntimeError("Set a real SECRET_KEY for production")
    return config
