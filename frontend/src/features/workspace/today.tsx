/**
 * My work today (playbook page 2): one queue ordered by service urgency — breached / approaching response deadlines
 * and promised callbacks first, then new enquiries, near-term demos and replies, then post-demo decisions and agreed
 * follow-ups, then future joining, reactivation and optional course suggestions. Lower tiers are never hidden.
 * Handover: what the cover person needs before the shift ends.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { playbookApi, playbookKeys, type HandoverRow, type WorkItem } from "@/api/playbook";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { DemoOutcomeDue } from "@/features/sales/demos-page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Field, StaffSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, LoadingRows, PriorityChip, Section, Status } from "@/components/crm/ui";
import { dateTime, relative } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { LeadContact } from "./lead-parts";

const TIER_KIND = { 1: "danger", 2: "warn", 3: "info", 4: "neutral" } as const;

function ItemLink({ item }: { item: WorkItem }) {
  if (item.lead)
    return (
      <Link to="/leads/$leadId" params={{ leadId: String(item.lead.lead_id) }} className="font-semibold text-foreground hover:text-primary">
        {item.title}
      </Link>
    );
  if (item.person_id)
    return (
      <Link to="/persons/$personId" params={{ personId: String(item.person_id) }} className="font-semibold text-foreground hover:text-primary">
        {item.title}
      </Link>
    );
  return (
    <Link to="/communications" className="font-semibold text-foreground hover:text-primary">
      {item.title}
    </Link>
  );
}

export function TodayQueue({ mine }: { mine: boolean }) {
  const branchId = useBranchFilter();
  const { profile } = useAuth();
  const [owner, setOwner] = useState<"me" | "all">(mine ? "me" : "all");
  const query = { owner, branch_id: branchId };
  const today = useQuery({ queryKey: playbookKeys.today(query), queryFn: () => playbookApi.today(query), refetchInterval: 60_000 });
  if (today.isLoading) return <LoadingRows rows={6} />;
  if (today.error) return <ErrorPanel error={today.error} onRetry={() => void today.refetch()} />;
  const d = today.data!;
  return (
    <div className="space-y-4">
      <DemoOutcomeDue ownerId={mine ? profile?.user.user_id : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        {d.tiers.map((t) => (
          <Status key={t.tier} kind={TIER_KIND[t.tier as 1]}>
            {t.count} · {t.label}
          </Status>
        ))}
        {!mine && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOwner(owner === "me" ? "all" : "me")}>
            {owner === "me" ? "Show whole branch" : "Show only mine"}
          </Button>
        )}
      </div>
      <section className="panel" aria-label="Today's work queue">
        {d.items.length === 0 ? (
          <Empty title="Nothing due">No enquiry needs attention right now. Lower-priority lists are under “Queues”.</Empty>
        ) : (
          <ol className="divide-y">
            {d.items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-start gap-3 py-3">
                <Status kind={TIER_KIND[item.tier]}>{item.tier}</Status>
                <div className="min-w-0 flex-1">
                  <ItemLink item={item} />
                  <p className="text-sm text-muted-foreground">{item.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.lead ? `${item.lead.lead_code} · ${item.lead.course?.course_title ?? "No course"} · ${item.lead.stage} · Owner: ${item.lead.owner ?? "Unassigned"}` : ""}
                    {item.also.length > 0 && ` · also: ${item.also.map((a) => a.title.split(" · ")[0]).join(", ")}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.lead?.ai_priority && <PriorityChip priority={item.lead.ai_priority} />}
                  {item.due_at && (
                    <span className={`text-right text-xs ${item.overdue ? "font-semibold text-destructive" : "text-muted-foreground"}`} title={dateTime(item.due_at)}>
                      {relative(item.due_at)}
                    </span>
                  )}
                  {item.lead && <LeadContact phone={item.lead.phone} />}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="text-xs text-muted-foreground">
        Order follows service urgency and evidence, not a guessed conversion score. Hot / Warm / Cold help prioritise; they never cancel a promised callback.
      </p>
    </div>
  );
}

export function HandoverList() {
  const { hasRole } = useAuth();
  const branchId = useBranchFilter();
  const query = { branch_id: branchId };
  const rows = useQuery({ queryKey: playbookKeys.handover(query), queryFn: () => playbookApi.handover(query) });
  const [noteFor, setNoteFor] = useState<HandoverRow | null>(null);
  const canNote = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE");
  return (
    <Section title="Shift handover" subtitle="Clear or hand over what is due: last contact, promise, unresolved question and next time">
      <DataTable
        stack
        rows={rows.data}
        loading={rows.isLoading}
        error={rows.error}
        onRetry={() => void rows.refetch()}
        rowKey={(r) => r.lead.lead_id}
        empty={<Empty title="Nothing to hand over">No open promise or due action on your leads today.</Empty>}
        columns={[
          {
            header: "Lead",
            cell: (r) => (
              <Link to="/leads/$leadId" params={{ leadId: String(r.lead.lead_id) }} className="font-semibold text-primary">
                {r.lead.name}
                <small className="block font-normal text-muted-foreground">
                  {r.lead.lead_code} · {r.lead.course?.course_title ?? "No course"}
                </small>
              </Link>
            ),
          },
          { header: "Last contact", cell: (r) => (r.last_contact ? `${r.last_contact.activity_type} · ${relative(r.last_contact.occurred_at)}${r.last_contact.summary ? ` — ${r.last_contact.summary}` : ""}` : r.first_attempt_pending ? <Status kind="danger">No staff attempt yet</Status> : "—") },
          { header: "Promise", cell: (r) => (r.promise ? `${r.promise.next_action ?? "Follow-up"}${r.promise.at ? ` · ${dateTime(r.promise.at)}` : ""}` : "—") },
          { header: "Unresolved", cell: (r) => r.unresolved ?? "—" },
          {
            header: "",
            cell: (r) =>
              canNote && (
                <Button size="sm" variant="outline" onClick={() => setNoteFor(r)}>
                  Hand over
                </Button>
              ),
          },
        ]}
      />
      {noteFor && <HandoverDialog row={noteFor} onClose={() => setNoteFor(null)} />}
    </Section>
  );
}

function HandoverDialog({ row, onClose }: { row: HandoverRow; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [cover, setCover] = useState("");
  const save = useApiMutation(() => playbookApi.handoverNote(row.lead.lead_id, { note, cover_user_id: cover ? Number(cover) : null }), {
    success: "Handover saved",
    invalidate: [["playbook"], ["tasks"]],
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hand over · {row.lead.name}</DialogTitle>
          <DialogDescription>The note goes on the timeline. A cover task helps without changing the owner.</DialogDescription>
        </DialogHeader>
        <Field label="Note for the cover person">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was promised, what they still need to know, when to call" />
        </Field>
        <Field label="Cover person (optional)">
          <StaffSelect branchId={row.lead.branch.branch_id} value={cover} onChange={(e) => setCover(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(undefined)} disabled={!note.trim() || save.isPending}>
            Save handover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
