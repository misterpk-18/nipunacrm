"""flask --app app whatsapp …: the WhatsApp outbox (db 033) — counts, recent messages, send, requeue."""
import json
import time

import click
from flask.cli import AppGroup

from config.database import db
from models import WhatsappOutbox
from services import whatsapp

whatsapp_cli = AppGroup("whatsapp", help="WhatsApp template messages: inspect the outbox, send, requeue.")


@whatsapp_cli.command("outbox")
@click.option("--recent", default=0, help="Also list the last N messages.")
@click.option("--problems", is_flag=True, help="List Failed and Skipped messages with the reason.")
def outbox_command(recent, problems) -> None:
    """Message counts by status; the sending switch and test list."""
    click.echo(json.dumps(whatsapp.summary(), indent=2))
    query = db.select(WhatsappOutbox).order_by(WhatsappOutbox.outbox_id.desc())
    if problems:
        query = query.where(WhatsappOutbox.status.in_(("Failed", "Skipped")))
    elif not recent:
        return
    for row in db.session.execute(query.limit(recent or 50)).scalars():
        click.echo(f"#{row.outbox_id} {row.status:9} {row.template_name} to {row.to_phone or '-'} "
                   f"[{row.source_type}:{row.source_id}] {row.skip_reason or row.last_error or ''}")


@whatsapp_cli.command("deliver")
@click.option("--limit", default=100, help="Most messages to send in one run.")
@click.option("--loop", is_flag=True, help="Keep running until interrupted.")
@click.option("--interval", default=10, help="Seconds between runs with --loop.")
def deliver_command(limit, loop, interval) -> None:
    """Send due Queued messages (the same as `flask jobs run whatsapp-send`)."""
    while True:
        click.echo(json.dumps(whatsapp.deliver(limit)))
        if not loop:
            return
        time.sleep(interval)


@whatsapp_cli.command("requeue")
@click.argument("outbox_ids", type=int, nargs=-1, required=True)
def requeue_command(outbox_ids) -> None:
    """Failed / Skipped messages with a number go back to Queued. For a Failed one whose answer was lost, check first."""
    count = whatsapp.requeue(list(outbox_ids))
    db.session.commit()
    click.echo(f"requeued: {count}")
