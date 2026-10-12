/**
 * Lead workbench (CRM AI playbook v2.0, pages 3, 6-9, 11): the 30-second brief, one suggested next action with
 * Use / Edit / Ignore / Remind later, contact rules, the quick outcome form, objections, approved content, reply drafts
 * from approved templates and the ready-to-close checklist. Suggestions are advisory; the server enforces every rule.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Ban, CheckCircle2, Circle, Clock, ExternalLink, MessageSquareText, Send, Sparkles } from "lucide-react";
import { leadKeys, leadsApi, type Lead } from "@/api/leads";
import {
  CONTACT_OUTCOMES,
  OBJECTION_CATEGORIES,
  OUTCOME_CHANNELS,
  REPLY_SITUATIONS,
  playbookApi,
  playbookKeys,
  type AiAction,
  type Disposition,
  type NextActionCard,
  type Objection,
  type ReplyDraft,
  type Workbench,
} from "@/api/playbook";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect, applyServerErrors } from "@/components/crm/forms";
import { FollowUpChips, chipForOutcome, chipValue, useStaffedInTwoHours, type ChipKey } from "@/features/leads/follow-up-chips";
import { AiNote, Empty, Facts, LoadingRows, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, fromLocalInput, relative } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

const opt = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));
const NEEDS_DATE = new Set(["Callback requested", "Later"]);
const CLOSES = new Set(["Not interested", "Wrong number", "Stop contact"]);

export function useWorkbench(leadId: number) {
  return useQuery({ queryKey: playbookKeys.workbench(leadId), queryFn: () => playbookApi.workbench(leadId) });
}

const invalidate = (leadId: number) => [playbookKeys.workbench(leadId), leadKeys.detail(leadId), leadKeys.activities(leadId), ["tasks"], ["playbook", "today"]];

function slaKind(state: string) {
  return state === "Met" ? "good" : state === "Breached" || state === "Met Late" ? "danger" : state === "At Risk" ? "warn" : "neutral";
}

// ---------------------------------------------------------------- brief + next action

export function WorkbenchPanel({ lead, onAction }: { lead: Lead; onAction: (action: string) => void }) {
  const wb = useWorkbench(lead.lead_id);
  const [editNeed, setEditNeed] = useState(false);
  if (wb.isLoading) return <LoadingRows rows={4} />;
  if (!wb.data) return null;
  const w = wb.data;
  const b = w.brief;
  const clock = w.response_clock;
  return (
    <>
      {w.contact_policy.stop_contact && (
        <Warning>
          <Ban className="mr-1 inline size-4" />
          Stop contact since {dateTime(w.contact_policy.stop_contact.at)}: {w.contact_policy.stop_contact.reason}. No outreach; record only contact the learner starts.
          <ClearStopContact lead={lead} />
        </Warning>
      )}
      <Section
        title="What we know"
        subtitle="Facts recorded on this enquiry · ask only what is missing"
        action={
          w.can_contact && (
            <Button size="sm" variant="ghost" onClick={() => setEditNeed(true)}>
              Edit
            </Button>
          )
        }
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {clock.is_eligible && (
            <Status kind={slaKind(clock.sla_state)}>
              <Clock className="mr-1 inline size-3" />
              First attempt: {clock.sla_state}
              {!clock.attempted_at && ` · due ${relative(clock.due_at)}`}
            </Status>
          )}
          {b.contact_state && <Status kind="warn">{b.contact_state}</Status>}
          {w.contact_policy.never_reached && (
            <Status kind="neutral">
              Never reached · calls {w.contact_policy.calls.used}/{w.contact_policy.calls.limit} · WhatsApp {w.contact_policy.whatsapp.used}/{w.contact_policy.whatsapp.limit}
            </Status>
          )}
        </div>
        <Facts
          columns={1}
          items={[
            ["Goal", b.need.learner_goal ?? <Missing key="g" />],
            ["Starting point", b.need.prior_experience ?? <Missing key="p" />],
            ["Timing / mode", b.need.preferred_timing ?? <Missing key="t" />],
            ["Joining window", b.need.joining_window ?? <Missing key="j" />],
            ["Open question", b.need.open_question ?? "—"],
            ["Course interests", b.course_interests.map((c) => c.course?.course_title ?? c.lead_code).join(", ") || "—"],
            ["Language · best time", `${b.preferred_language}${b.preferred_contact_time ? ` · ${b.preferred_contact_time}` : ""}`],
            ["Last discussion", b.last_discussion ? `${b.last_discussion.activity_type}${b.last_discussion.outcome ? ` · ${b.last_discussion.outcome}` : ""} · ${relative(b.last_discussion.occurred_at)}${b.last_discussion.summary ? ` — ${b.last_discussion.summary}` : ""}` : "No contact yet"],
            ["Promised next action", b.promised_next_action ? `${b.promised_next_action.next_action ?? "Follow-up"}${b.promised_next_action.at ? ` · ${dateTime(b.promised_next_action.at)}` : ""}` : "None"],
          ]}
        />
        {b.enquiry_message && <p className="mt-2 text-xs text-muted-foreground">Source: enquiry message — “{b.enquiry_message}”</p>}
      </Section>
      <NextActionCardView lead={lead} card={w.next_action} assistance={w.assistance} onAction={onAction} />
      {editNeed && <NeedDialog lead={lead} onClose={() => setEditNeed(false)} />}
    </>
  );
}

function ClearStopContact({ lead }: { lead: Lead }) {
  const { hasRole } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const clear = useApiMutation(() => playbookApi.clearStopContact(lead.person.person_id, reason), {
    success: "Stop contact cleared",
    invalidate: invalidate(lead.lead_id),
    onSuccess: () => setOpen(false),
  });
  if (!hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER")) return null;
  return (
    <>
      <Button size="sm" variant="outline" className="ml-2" onClick={() => setOpen(true)}>
        Clear
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear stop contact</DialogTitle>
            <DialogDescription>Only when the learner has asked to be contacted again. The reason is audited.</DialogDescription>
          </DialogHeader>
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => clear.mutate(undefined)} disabled={!reason.trim() || clear.isPending}>
              Clear stop contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Missing() {
  return <span className="text-muted-foreground italic">Not recorded</span>;
}

function NextActionCardView({ lead, card, assistance, onAction }: { lead: Lead; card: NextActionCard | null; assistance: Workbench["assistance"]; onAction: (action: string) => void }) {
  const [mode, setMode] = useState<null | "edit" | "snooze">(null);
  const [text, setText] = useState("");
  const [remind, setRemind] = useState("");
  const dispose = useApiMutation(
    (v: { status: Disposition; final_text?: string; remind_at?: string }) => playbookApi.disposeNextAction(lead.lead_id, { action_code: card!.action_code, ...v }),
    { success: (a) => `Suggestion ${a.status.toLowerCase()}`, invalidate: invalidate(lead.lead_id), onSuccess: () => setMode(null) },
  );
  if (assistance.is_paused) {
    return (
      <Section title="Suggested next action">
        <p className="text-sm text-muted-foreground">AI assistance is paused for this branch ({assistance.pause_reason}). Work the lead as usual.</p>
      </Section>
    );
  }
  if (!card) return null;
  if (card.hidden) {
    return (
      <Section title="Suggested next action">
        <p className="text-sm text-muted-foreground">
          You {card.disposition?.status === "Snoozed" ? `asked to be reminded ${dateTime(card.disposition.remind_at)}` : "ignored this suggestion"}. Choose your own next step; promised callbacks and tasks are unchanged.
        </p>
      </Section>
    );
  }
  const run = () => {
    const a = card.primary_action;
    if (a) onAction(a);
    dispose.mutate({ status: "Used" });
  };
  return (
    <AiNote
      title="Suggested next action"
      actions={
        mode === null ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={run} disabled={dispose.isPending}>
              Use
            </Button>
            <Button size="sm" variant="outline" onClick={() => (setText(card.suggestion), setMode("edit"))}>
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => dispose.mutate({ status: "Ignored" })} disabled={dispose.isPending}>
              Ignore
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("snooze")}>
              Remind later
            </Button>
          </div>
        ) : mode === "edit" ? (
          <form className="grid w-full gap-2" onSubmit={(e) => (e.preventDefault(), dispose.mutate({ status: "Edited", final_text: text }))}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Edited next action" />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={!text.trim() || dispose.isPending}>
                Save edit
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setMode(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form className="flex w-full flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), dispose.mutate({ status: "Snoozed", remind_at: fromLocalInput(remind)! }))}>
            <Input type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} aria-label="Remind at" className="max-w-56" />
            <Button size="sm" type="submit" disabled={!remind || dispose.isPending}>
              Remind me
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </form>
        )
      }
    >
      <p className="font-medium text-foreground">{card.suggestion}</p>
      <p className="mt-1 text-xs">
        Why: {card.reason} · Owner: {card.owner ?? "Unassigned"}
      </p>
    </AiNote>
  );
}

function NeedDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const form = useForm({ defaultValues: { learner_goal: lead.need.learner_goal ?? "", prior_experience: lead.need.prior_experience ?? "", preferred_timing: lead.need.preferred_timing ?? "", joining_window: lead.need.joining_window ?? "", open_question: lead.need.open_question ?? "" } });
  const save = useApiMutation(
    (v: Record<string, string>) => leadsApi.update(lead.lead_id, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim() || null]))),
    { success: "Saved", invalidate: invalidate(lead.lead_id), onSuccess: onClose, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What the learner needs</DialogTitle>
          <DialogDescription>Record a real answer or leave it empty (Unknown). Check names, dates and amounts when unsure.</DialogDescription>
        </DialogHeader>
        <form id="need-form" className="grid gap-3" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <Field label="Goal">
            <Textarea placeholder="e.g. reporting dashboards at work" {...form.register("learner_goal")} />
          </Field>
          <Field label="Starting point">
            <Input placeholder="What they have already learned or used" {...form.register("prior_experience")} />
          </Field>
          <Field label="Branch / mode / timing">
            <Input placeholder="e.g. evening classroom, Guntur" {...form.register("preferred_timing")} />
          </Field>
          <Field label="Joining window">
            <Input placeholder="e.g. after exams in November" {...form.register("joining_window")} />
          </Field>
          <Field label="Open question">
            <Input placeholder="The question still to answer" {...form.register("open_question")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="need-form" disabled={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- quick outcome

type OutcomeValues = { channel: string; direction: "Outbound" | "Inbound"; outcome: string; note: string; next_action: string; next: string; objection: string; category: string };

export function OutcomeForm({ lead }: { lead: Lead }) {
  const wb = useWorkbench(lead.lead_id);
  const form = useForm<OutcomeValues>({ defaultValues: { channel: "Call", direction: "Outbound", outcome: "Connected", note: "", next_action: "", next: "", objection: "", category: "" } });
  const outcome = form.watch("outcome");
  const channel = form.watch("channel");
  const direction = form.watch("direction");
  const staffed = useStaffedInTwoHours(lead.branch.branch_id);
  const [chip, setChip] = useState<ChipKey | null>(null);
  const [picked, setPicked] = useState(false); // the counsellor chose a time: changing the outcome no longer moves it
  const pickChip = (key: ChipKey, value: string) => {
    setChip(key);
    form.setValue("next", value, { shouldValidate: true });
  };
  const chooseOutcome = (o: string) => {
    form.setValue("outcome", o);
    if (picked) return;
    const suggested = chipForOutcome(o);
    if (suggested === "none") {
      setChip(null);
      form.setValue("next", "");
    } else if (suggested) {
      setChip(suggested);
      form.setValue("next", chipValue(suggested, staffed.data));
    }
  };
  // "In 2 hrs" follows the server's staffed time once it arrives
  useEffect(() => {
    if (chip === "in2h" && staffed.data) form.setValue("next", chipValue("in2h", staffed.data));
  }, [chip, staffed.data, form]);
  const save = useApiMutation(
    (v: OutcomeValues) =>
      playbookApi.outcome(lead.lead_id, {
        channel: v.channel,
        direction: v.direction,
        outcome: v.outcome,
        note: v.note || null,
        next_action: v.next_action || null,
        next_action_at: v.next ? fromLocalInput(v.next) : null,
        objection: v.objection.trim() ? { learner_words: v.objection.trim(), category: v.category || null } : null,
      }),
    {
      success: "Outcome saved",
      invalidate: invalidate(lead.lead_id),
      silentValidation: true,
      onSuccess: () => {
        form.reset({ ...form.getValues(), note: "", next_action: "", next: "", objection: "", category: "" });
        setChip(null);
        setPicked(false);
      },
      onError: (e) => applyServerErrors(form, e),
    },
  );
  const blocked = direction === "Outbound" && outcome !== "Stop contact" ? wb.data?.contact_policy.blocked[channel as "Call"] : null;
  return (
    <form className="grid gap-2" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Outcome">
        {CONTACT_OUTCOMES.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={outcome === o}
            onClick={() => chooseOutcome(o)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${outcome === o ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
          >
            {o}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Channel" htmlFor="oc-channel">
          <NativeSelect id="oc-channel" options={opt(OUTCOME_CHANNELS)} {...form.register("channel")} />
        </Field>
        <Field label="Who started it" htmlFor="oc-direction">
          <NativeSelect id="oc-direction" options={[{ value: "Outbound", label: "We contacted" }, { value: "Inbound", label: "Learner contacted" }]} {...form.register("direction")} />
        </Field>
      </div>
      {blocked && <Warning>{blocked}</Warning>}
      <Field label="Note" hint="What was actually said" htmlFor="oc-note">
        <Textarea id="oc-note" {...form.register("note")} />
      </Field>
      {!CLOSES.has(outcome) && (
        <>
          <Field label="Agreed next action" htmlFor="oc-next-action">
            <Input id="oc-next-action" placeholder="e.g. share syllabus and discuss timings" {...form.register("next_action")} />
          </Field>
          <Field label={`Next action date (IST)${NEEDS_DATE.has(outcome) ? " · required" : ""}`} error={form.formState.errors.next?.message ?? form.formState.errors["next_action_at" as "next"]?.message} htmlFor="oc-next">
            <div className="mb-1.5">
              <FollowUpChips
                active={chip}
                staffedIso={staffed.data}
                onPick={(key, value) => {
                  setPicked(true);
                  pickChip(key, value);
                }}
              />
            </div>
            <Input
              id="oc-next"
              type="datetime-local"
              {...form.register("next", {
                required: NEEDS_DATE.has(outcome) ? "The agreed date is required" : false,
                onChange: () => {
                  setPicked(true);
                  setChip(null);
                },
              })}
            />
          </Field>
        </>
      )}
      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">Record an objection</summary>
        <div className="mt-2 grid gap-2">
          <Field label="Learner's own words" htmlFor="oc-objection">
            <Input id="oc-objection" {...form.register("objection")} />
          </Field>
          <Field label="Category (optional)" htmlFor="oc-category">
            <NativeSelect id="oc-category" options={[{ value: "", label: "—" }, ...opt(OBJECTION_CATEGORIES)]} {...form.register("category")} />
          </Field>
        </div>
      </details>
      <Button type="submit" disabled={save.isPending || !!blocked}>
        Save outcome
      </Button>
      {!form.watch("next") && !CLOSES.has(outcome) && <p className="text-xs text-muted-foreground">Without a date the lead is shown as “{outcome === "No answer" ? "Awaiting reply" : "Next action missing"}” so it doesn't disappear.</p>}
    </form>
  );
}

// ---------------------------------------------------------------- objections tab

export function ObjectionsTab({ lead }: { lead: Lead }) {
  const wb = useWorkbench(lead.lead_id);
  const guide = useQuery({ queryKey: ["playbook", "guide"], queryFn: playbookApi.objectionGuide, staleTime: Infinity });
  const [closing, setClosing] = useState<Objection | null>(null);
  const rows = wb.data?.objections ?? [];
  if (wb.isLoading) return <LoadingRows />;
  if (!rows.length) return <Empty title="No objections recorded">Record the learner's own words with “Save outcome”.</Empty>;
  return (
    <div className="space-y-3">
      {rows.map((o) => {
        const g = guide.data?.find((x) => x.category === (o.category ?? "Other"));
        return (
          <div key={o.objection_id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">“{o.learner_words}”</p>
              <Status kind={o.status === "Open" ? "warn" : o.status === "Resolved" ? "good" : "neutral"}>{o.status}</Status>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {o.category ?? "No category"} · {o.created_by?.full_name} · {dateTime(o.created_at)}
            </p>
            {o.status === "Open" && g && (
              <div className="mt-2 rounded-md bg-muted p-2 text-sm">
                <p>
                  <span className="font-medium">Ask / explain:</span> {g.ask}
                </p>
                <p className="mt-1">
                  <span className="font-medium">Useful next action:</span> {g.next_action}
                </p>
              </div>
            )}
            {o.resolution && <p className="mt-2 text-sm">Answer: {o.resolution}</p>}
            {o.status === "Open" && wb.data?.can_contact && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setClosing(o)}>
                Record answer
              </Button>
            )}
          </div>
        );
      })}
      {closing && <CloseObjectionDialog lead={lead} objection={closing} onClose={() => setClosing(null)} />}
    </div>
  );
}

function CloseObjectionDialog({ lead, objection, onClose }: { lead: Lead; objection: Objection; onClose: () => void }) {
  const form = useForm({ defaultValues: { status: "Resolved", resolution: "" } });
  const save = useApiMutation((v: { status: string; resolution: string }) => playbookApi.updateObjection(objection.objection_id, { status: v.status as Objection["status"], resolution: v.resolution }), {
    success: "Objection updated",
    invalidate: invalidate(lead.lead_id),
    onSuccess: onClose,
    onError: (e) => applyServerErrors(form, e),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the answer</DialogTitle>
          <DialogDescription>“{objection.learner_words}” — the learner's words stay as recorded.</DialogDescription>
        </DialogHeader>
        <form id="objection-form" className="grid gap-3" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <Field label="Result">
            <NativeSelect options={[{ value: "Resolved", label: "Resolved" }, { value: "Closed unresolved", label: "Considered decline / not resolved" }]} {...form.register("status")} />
          </Field>
          <Field label="Answer given" error={form.formState.errors.resolution?.message}>
            <Textarea {...form.register("resolution", { required: "Record the answer given" })} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="objection-form" disabled={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- batches (timetable from the LMS)

export function BatchOptions({ lead }: { lead: Lead }) {
  const wb = useWorkbench(lead.lead_id);
  const rows = wb.data?.batches ?? [];
  if (!lead.course) return null;
  return (
    <Section title="Batches for this course" subtitle={`${lead.course.course_title} at ${lead.branch.branch_name} · from the LMS`}>
      {rows.length ? (
        <ul className="space-y-2 text-sm">
          {rows.map((b) => (
            <li key={b.batch_id} className="rounded-md border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {b.lms_batch_code ?? b.batch_code} · from {date(b.start_date)}
                </span>
                {b.is_offerable ? <Status kind="good">{b.seats_left} seat(s) left</Status> : <Status kind="neutral">Not offerable</Status>}
              </div>
              <p className={`text-xs ${b.timing_confirmed ? "" : "italic text-muted-foreground"}`}>
                {b.delivery_mode} · {b.timing}
              </p>
              {b.not_offerable_reason && <p className="text-xs text-muted-foreground">{b.not_offerable_reason} (staff only)</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No upcoming batch is published for this course yet. Don't promise one; record the learner's preferred timing and a follow-up date.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- approved content + closing checklist

export function ApprovedContent({ lead, onDraft }: { lead: Lead; onDraft: (situation: string) => void }) {
  const wb = useWorkbench(lead.lead_id);
  const items = wb.data?.content ?? [];
  return (
    <Section title="Approved content" subtitle="Only approved, current material — share what matches the actual question">
      {items.length ? (
        <ul className="space-y-2 text-sm">
          {items.map((k) => (
            <li key={k.knowledge_id} className="flex items-start justify-between gap-2">
              <span>
                <span className="font-medium">{k.title}</span> <span className="text-xs text-muted-foreground">· {k.kind}</span>
                {k.is_stale && <Status kind="warn">Review due</Status>}
                {k.kind !== "Syllabus" && k.kind !== "Brochure" && <span className="block text-xs text-muted-foreground">{k.body}</span>}
              </span>
              {k.link_url && (
                <a href={k.link_url} target="_blank" rel="noreferrer" className="shrink-0 text-primary" aria-label={`Open ${k.title}`}>
                  <ExternalLink className="size-4" />
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No approved material for this course yet. Unknown fee, timetable or academic facts go to the responsible reviewer.</p>
      )}
      {wb.data?.can_contact && (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => onDraft("Syllabus request")} disabled={!wb.data.assistance.drafts_allowed}>
          <MessageSquareText />
          Draft a reply
        </Button>
      )}
    </Section>
  );
}

export function ClosingChecklist({ lead }: { lead: Lead }) {
  const wb = useWorkbench(lead.lead_id);
  const list = wb.data?.closing_checklist;
  if (!list) return null;
  const next = list.items.find((i) => !i.done);
  return (
    <Section title="Ready to close" subtitle={list.complete ? "All checks complete" : `Next: ${next?.next_action}`}>
      <ul className="space-y-1.5 text-sm">
        {list.items.map((i) => (
          <li key={i.key} className="flex items-start gap-2">
            {i.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <span>
              {i.label}
              {i.evidence && <span className="block text-xs text-muted-foreground">{i.evidence}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">Payment submitted and payment verified are different states. Only Accounts verification creates the receipt and admission.</p>
    </Section>
  );
}

// ---------------------------------------------------------------- reply draft

export function ReplyDraftDialog({ lead, situation: initial, onClose }: { lead: Lead; situation: string; onClose: () => void }) {
  const { profile } = useAuth();
  const [situation, setSituation] = useState(initial);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [text, setText] = useState("");
  const make = useApiMutation(() => playbookApi.replyDraft(lead.lead_id, situation), {
    onSuccess: (d) => (setDraft(d), setText(d.text)),
  });
  const send = useApiMutation(() => playbookApi.recordMessage(lead.lead_id, { channel: "WhatsApp", text, ai_action_id: draft?.draft.ai_action_id }), {
    success: "Recorded as sent (manually) — not marked Delivered",
    invalidate: invalidate(lead.lead_id),
    onSuccess: onClose,
  });
  const openWhatsApp = () => {
    const digits = (draft?.whatsapp_number ?? lead.person.phone).replace(/\D/g, "");
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    send.mutate(undefined);
  };
  const unfilled = /\{\w+\}/.test(text);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reply draft · {lead.name}</DialogTitle>
          <DialogDescription>From an approved template with recorded facts only. Review, edit, then send — once.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex items-end gap-2">
            <Field label="Situation" className="flex-1">
              <NativeSelect options={opt(REPLY_SITUATIONS)} value={situation} onChange={(e) => setSituation(e.target.value)} />
            </Field>
            <Button variant="outline" onClick={() => make.mutate(undefined)} disabled={make.isPending}>
              <Sparkles />
              {draft ? "Redo" : "Draft"}
            </Button>
          </div>
          {draft && (
            <>
              {draft.language_fallback && <Warning>No approved {lead.person.preferred_language} template yet — this is the English version.</Warning>}
              {draft.blocked_reasons.map((r) => (
                <Warning key={r}>{r}</Warning>
              ))}
              <Field label="Message">
                <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <p className="text-xs text-muted-foreground">
                Sending opens WhatsApp with this text and records it on the timeline as “Manually recorded” by {profile?.user.full_name}. Copying a draft is not delivery.
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={openWhatsApp} disabled={!draft || unfilled || send.isPending || draft.blocked_reasons.some((r) => !r.startsWith("Missing"))}>
            <Send />
            Send on WhatsApp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- counselling brief (AI tab)

export function CounsellingBrief({ lead }: { lead: Lead }) {
  const [brief, setBrief] = useState<AiAction | null>(null);
  const make = useApiMutation(() => playbookApi.counsellingBrief(lead.lead_id), { onSuccess: setBrief });
  const p = (brief?.payload ?? {}) as {
    understood_need?: string;
    useful_question?: string;
    course_options?: { title: string; why: string }[];
    info_to_share?: { knowledge_id: number; title: string; link_url: string | null }[];
    missing_checks?: string[];
  };
  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" onClick={() => make.mutate(undefined)} disabled={make.isPending}>
        <Sparkles />
        Counselling brief
      </Button>
      {brief && (
        <AiNote title={`Counselling brief · ${brief.model === "rules-fallback" ? "rule-based" : "AI"} · review before use`}>
          <Facts
            columns={1}
            items={[
              ["Understood need", p.understood_need ?? "—"],
              ["One useful question", p.useful_question ?? "—"],
              ["Course options", p.course_options?.length ? p.course_options.map((o) => `${o.title} — ${o.why}`).join("; ") : "None fits yet"],
              ["Approved info to share", p.info_to_share?.length ? p.info_to_share.map((k) => k.title).join(", ") : "None"],
              ["Next action", brief.suggestion],
              ["Check first", p.missing_checks?.length ? p.missing_checks.join("; ") : "—"],
            ]}
          />
        </AiNote>
      )}
    </div>
  );
}
