"""Flask CLI commands (run from backend/: flask --app app <command>)."""
from flask import Flask

from cli.database import create_dev_db_command, create_test_db_command
from cli.jobs import jobs_cli
from cli.lms import lms_cli
from cli.seed import seed_dev_command
from cli.users import create_admin_command


def register_cli(app: Flask) -> None:
    app.cli.add_command(create_test_db_command)
    app.cli.add_command(create_dev_db_command)
    app.cli.add_command(seed_dev_command)
    app.cli.add_command(create_admin_command)
    app.cli.add_command(jobs_cli)
    app.cli.add_command(lms_cli)
