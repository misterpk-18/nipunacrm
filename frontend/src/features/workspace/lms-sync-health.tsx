/**
 * Sync health strip (LMS round 3): is the LMS answering, when the CRM last pushed and pulled, and what is waiting —
 * from GET /lms/sync-status. Shown on LMS access and the Super Admin dashboard.
 */
import { useLmsSyncStatus } from "@/api/lms";
import { Status } from "@/components/crm/ui";
import { dateTime } from "@/lib/format";

export function LmsSyncHealth() {
  const sync = useLmsSyncStatus().data;
  if (!sync?.configured) return null;
  const { pull, outbox, held } = sync;
  const reachable = sync.lms_reachable;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3 text-sm" aria-label="LMS sync health">
      <Status kind={reachable === null ? "neutral" : reachable ? "good" : "danger"}>
        {reachable === null ? "LMS not contacted yet" : reachable ? "LMS reachable" : "LMS not reachable"}
      </Status>
      <span className="text-muted-foreground">
        Last push {outbox.last_delivered_at ? dateTime(outbox.last_delivered_at) : "—"} · last pull{" "}
        {pull.last_success_at ? dateTime(pull.last_success_at) : "—"}
      </span>
      <Status kind={outbox.pending ? "warn" : "good"}>
        {`${outbox.pending} waiting to send${outbox.oldest_pending_at ? ` · oldest ${dateTime(outbox.oldest_pending_at)}` : ""}`}
      </Status>
      {outbox.failed > 0 && <Status kind="danger">{`${outbox.failed} failed`}</Status>}
      {held > 0 && <Status kind="warn">{`${held} held from the LMS`}</Status>}
      {(pull.last_error || outbox.last_error) && (
        <span className="basis-full text-xs text-muted-foreground">Last error: {pull.last_error ?? outbox.last_error}</span>
      )}
    </div>
  );
}
