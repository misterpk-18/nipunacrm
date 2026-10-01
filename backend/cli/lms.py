"""flask --app app lms …: the Nipuna LMS outbox (db 026) — backfill, deliver, inspect, requeue —, the status pull
(db 028) — pull, holds, drop-crm-batches — and branch finance snapshots (db 029)."""
import json
import time

import click
from flask.cli import AppGroup

from config.database import db
from models import LmsOutbox
from services import lms_delivery, lms_finance, lms_pull, lms_sync

lms_cli = AppGroup("lms", help="Nipuna LMS sync: backfill events, deliver the outbox, inspect and requeue rows.")


@lms_cli.command("backfill")
@click.option("--include-cancelled", is_flag=True, help="Also send cancelled admissions (qualified, then cancelled).")
@click.option("--force", is_flag=True, help="Send again even if the record already has a Pending / Delivered event.")
@click.option("--course", "course_ids", type=int, multiple=True, help="Only this course (repeatable).")
@click.option("--admission", "admission_ids", type=int, multiple=True, help="Only this admission (repeatable).")
@click.option("--branches", "branches_only", is_flag=True, help="Only BranchUpserted for every branch.")
def backfill_command(include_cancelled, force, course_ids, admission_ids, branches_only) -> None:
    """Write events for every existing branch, course and admission to the outbox (the worker delivers them)."""
    counts = lms_sync.backfill(include_cancelled=include_cancelled, force=force, branches_only=branches_only,
                               course_ids=list(course_ids) or None, admission_ids=list(admission_ids) or None)
    click.echo(json.dumps(counts))


@lms_cli.command("finance-snapshot")
@click.option("--force", is_flag=True, help="Write one now even if the last is younger than 15 minutes.")
def finance_snapshot_command(force) -> None:
    """Write one BranchFinanceSnapshot per active branch (the job lms-finance-snapshot, which waits 15 minutes)."""
    result = lms_finance.send_snapshots(force=force)
    db.session.commit()
    click.echo(json.dumps(result))


@lms_cli.command("deliver")
@click.option("--limit", default=200, show_default=True, help="Rows per run.")
@click.option("--loop", is_flag=True, help="Keep delivering until stopped (Ctrl+C) — for local testing.")
@click.option("--interval", default=5, show_default=True, help="Seconds between runs with --loop.")
def deliver_command(limit, loop, interval) -> None:
    """Post due Pending rows to the LMS (the same as `flask jobs run lms-sync`)."""
    while True:
        result = lms_delivery.deliver(limit)
        db.session.commit()
        if not loop:
            click.echo(json.dumps(result))
            return
        if any(k != "delivered" or v for k, v in result.items()):
            click.echo(f"{time.strftime('%H:%M:%S')} {json.dumps(result)}")
        time.sleep(interval)


@lms_cli.command("outbox")
@click.option("--failed", "show_failed", is_flag=True, help="List failed and retrying rows with the LMS's error.")
def outbox_command(show_failed) -> None:
    """Row counts by status and event type."""
    click.echo(json.dumps(lms_delivery.summary(), indent=2))
    if show_failed:
        rows = db.session.execute(
            db.select(LmsOutbox).where((LmsOutbox.status == "Failed")
                                       | ((LmsOutbox.status == "Pending") & (LmsOutbox.attempts > 0)))
            .order_by(LmsOutbox.outbox_id)).scalars()
        for row in rows:
            click.echo(f"#{row.outbox_id} {row.status} {row.event_type} {row.record_key} v{row.source_version} "
                       f"attempts={row.attempts} http={row.last_http_status}: {row.last_error}")


@lms_cli.command("requeue")
@click.argument("outbox_ids", type=int, nargs=-1)
def requeue_command(outbox_ids) -> None:
    """Failed rows (all, or the given outbox ids) → Pending, sent again unchanged."""
    count = lms_delivery.requeue(list(outbox_ids) or None)
    db.session.commit()
    click.echo(f"requeued: {count}")


@lms_cli.command("status-check")
@click.option("--since", default="1970-01-01T00:00:00+00:00", show_default=True)
def status_check_command(since) -> None:
    """Call the LMS status pull once and show what it returned (counts only)."""
    if not lms_delivery.configured():
        raise click.ClickException("LMS_BASE_URL / LMS_SERVICE_KEY not set")
    answer = lms_delivery.pull_status(since)
    data = (answer.body or {}).get("data") or {}
    click.echo(json.dumps({"http": answer.status, "error": answer.error or (answer.body or {}).get("error"),
                           "as_of": data.get("as_of"),
                           **{k: len(v) for k, v in data.items() if isinstance(v, list)}}, default=str))


@lms_cli.command("pull")
@click.option("--full", is_flag=True, help="Ask for everything again (reset the watermark first).")
def pull_command(full) -> None:
    """Apply the LMS status pull once (the same as `flask jobs run lms-status-pull`)."""
    if full:
        lms_pull.reset_watermark()
        db.session.commit()
    click.echo(json.dumps(lms_pull.pull()))
    click.echo(json.dumps(lms_pull.state().to_dict(), default=str))


@lms_cli.command("holds")
def holds_command() -> None:
    """Pulled records waiting to be applied, with the reason."""
    rows = lms_pull.holds()
    for hold in rows:
        click.echo(f"{hold.record_key} attempts={hold.attempts} since={hold.first_held_at:%Y-%m-%d %H:%M}: {hold.reason}")
    if not rows:
        click.echo("no held records")


@lms_cli.command("drop-crm-batches")
@click.option("--yes", is_flag=True, help="Confirm: deletes data.")
def drop_crm_batches_command(yes) -> None:
    """Delete the CRM's own batches and all allocations, then reset the pull so the LMS's come in (dev data only)."""
    if not yes:
        raise click.ClickException("This deletes every batch allocation and the CRM's own batches; pass --yes")
    if not str(db.engine.url.database).endswith(("-dev", "_test")):
        raise click.ClickException(f"Refusing on {db.engine.url.database}: dev or test databases only")
    result = lms_pull.drop_crm_batches()
    db.session.commit()
    click.echo(json.dumps(result))
