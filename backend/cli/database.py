"""Build a throwaway database from the SQL migrations in db/ (tests, `flask create-test-db`, `flask create-dev-db`)."""
from pathlib import Path

import click
import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

from config.settings import DevelopmentConfig, TestingConfig


REBUILDABLE_SUFFIXES = ("_test", "-dev")


def _libpq_url(url) -> str:
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def rebuild_database(database_url: str, migrations_dir: Path) -> None:
    """Drop and recreate the database, then apply db/*.sql in order, each in its own transaction."""
    url = make_url(database_url)
    if not url.database or not url.database.endswith(REBUILDABLE_SUFFIXES):
        raise RuntimeError(f"Refusing to rebuild '{url.database}': only *_test and *-dev databases can be rebuilt")

    with psycopg.connect(_libpq_url(url.set(database="postgres")), autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(url.database)))
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(url.database)))

    with psycopg.connect(_libpq_url(url)) as conn:
        for path in sorted(migrations_dir.glob("*.sql")):
            with conn.transaction():
                conn.execute(path.read_text())


@click.command("create-test-db")
def create_test_db_command() -> None:
    """Rebuild the test database from db/*.sql."""
    rebuild_database(TestingConfig.SQLALCHEMY_DATABASE_URI, TestingConfig.MIGRATIONS_DIR)
    click.echo(f"Rebuilt {make_url(TestingConfig.SQLALCHEMY_DATABASE_URI).database} from {TestingConfig.MIGRATIONS_DIR}")


@click.command("create-dev-db")
@click.confirmation_option(prompt="Drop and rebuild the dev database? All staging data will be lost.")
def create_dev_db_command() -> None:
    """Rebuild the dev replica (DEV_DATABASE_URL) from db/*.sql. Follow with `flask seed-dev`."""
    rebuild_database(DevelopmentConfig.SQLALCHEMY_DATABASE_URI, DevelopmentConfig.MIGRATIONS_DIR)
    click.echo(f"Rebuilt {make_url(DevelopmentConfig.SQLALCHEMY_DATABASE_URI).database} from {DevelopmentConfig.MIGRATIONS_DIR}")
