"""flask --app app create-admin: create the first Founder / CEO or Super Admin."""
import click
from flask.cli import with_appcontext

from config.database import db
from services import users as users_service
from services.errors import AppError


@click.command("create-admin")
@click.option("--email", prompt=True, help="Login email")
@click.option("--name", "full_name", prompt="Full name", help="Full name")
@click.option("--role", type=click.Choice(["FOUNDER_CEO", "SUPER_ADMIN"]), default="FOUNDER_CEO", show_default=True)
@click.password_option(help="Password (prompted with confirmation if omitted)")
@with_appcontext
def create_admin_command(email: str, full_name: str, role: str, password: str) -> None:
    """Create an admin user with company-wide access."""
    try:
        user = users_service.create_initial_admin(email.strip().lower(), full_name.strip(), role, password)
        db.session.commit()
    except AppError as exc:
        db.session.rollback()
        details = f" {exc.details}" if exc.details else ""
        raise click.ClickException(f"{exc.message}{details}") from exc
    click.echo(f"Created {role} {user.email} (user_id {user.user_id})")
