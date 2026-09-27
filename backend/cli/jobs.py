"""flask --app app jobs run [NAME ...]: run background jobs (all by default). Schedule with cron, e.g. every minute."""
import click
from flask.cli import AppGroup

from config.database import db
from services.jobs import JOBS

jobs_cli = AppGroup("jobs", help="Background jobs: escalations, reminders, collections, reports, clean-up.")


@jobs_cli.command("list")
def list_jobs() -> None:
    """Show the available jobs."""
    for name, job in JOBS.items():
        click.echo(f"{name:18} {((job.__doc__ or '').strip().splitlines() or [''])[0]}")


@jobs_cli.command("run")
@click.argument("names", nargs=-1)
def run_jobs(names: tuple[str, ...]) -> None:
    """Run the named jobs (or all). Each job commits on its own, so one failure doesn't undo the others."""
    unknown = set(names) - set(JOBS)
    if unknown:
        raise click.BadParameter(f"Unknown job(s): {', '.join(sorted(unknown))}. See `flask jobs list`.")
    failed = False
    for name in names or JOBS:
        try:
            result = JOBS[name]()
            db.session.commit()
            click.echo(f"{name}: {result}")
        except Exception as exc:
            db.session.rollback()
            failed = True
            click.echo(f"{name}: FAILED ({exc})", err=True)
    if failed:
        raise SystemExit(1)
