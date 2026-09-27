import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Bell, CalendarClock, Check, CheckCircle2, Pencil, ShieldCheck, XCircle } from "lucide-react";
import {
  CANCEL_REASONS,
  DEMO_OUTCOMES,
  DEMO_STATUSES,
  OPEN_DEMO_STATUSES,
  RESCHEDULE_REASONS,
  demoKeys,
  demosApi,
  type DemoFilters,
  type DemoRow,
} from "@/api/demos";
import { leadKeys } from "@/api/leads";
import { LEAD_OWNER_ROLES } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CourseSelect, Field, NativeSelect, StaffSelect, applyServerErrors, useBranchCode } from "@/components/crm/forms";
import { ConfirmAction, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Section, Status, Warning } from "@/components/crm/ui";
import { dateTime, fromLocalInput, isPast, todayIST, toLocalInput } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FormDialog, SALES_SIDE } from "./shared";

export type DemoSearch = { from?: string; to?: string; status?: string; trainer_id?: number; page?: number };

const INVALIDATE = [demoKeys.all, leadKeys.all, ["tasks"], ["pipeline"], ["dashboard"]];

type Action = { kind: "edit" | "reschedule" | "cancel" | "outcome"; demo: DemoRow };

export function DemosPage({ search, onSearch }: { search: DemoSearch; onSearch: (next: DemoSearch) => void }) {
  const branchId = useBranchFilter();
  const { hasRole, profile } = useAuth();
  const salesSide = hasRole(...SALES_SIDE);
  const isTrainer = hasRole("TRAINER");
  const canApproveExtra = hasRole("BRANCH_MANAGER", "ACADEMIC_COORDINATOR");
  const [act, setAct] = useState<Action | null>(null);
  const [openReminders, setOpenReminders] = useState<number | null>(null);

  const filters: DemoFilters = { ...search, branch_id: branchId, per_page: 25 };
  const demos = useQuery({ queryKey: demoKeys.list(filters), queryFn: () => demosApi.list(filters), placeholderData: (prev) => prev });
  const set = (patch: Partial<DemoSearch>) => onSearch({ ...search, ...patch, page: undefined });

  const confirm = useApiMutation((id: number) => demosApi.confirm(id), { success: (d) => `${d.demo_code} confirmed`, invalidate: INVALIDATE });
  const approveExtra = useApiMutation((id: number) => demosApi.approveExtra(id), { success: (d) => `Extra demo ${d.demo_code} approved`, invalidate: INVALIDATE });

  const rows = demos.data?.data;
  return (
    <>
      <PageHead
        title="Demo Management"
        description="Scheduling, reminders, attendance and outcome. Book a new demo from the lead's page (Lead 360 → Schedule demo)."
      />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Warning>Normally maximum 2 attended demos. More needs Academic Coordinator or Branch Manager approval.</Warning>
        <Warning>Usual duration 30–45 minutes; practical demos may be up to 60 minutes.</Warning>
        <Warning>Payment Pending Verification or Admitted records never move backward after a demo; Lost is never reopened.</Warning>
      </div>
      <Section
        title="Demo schedule"
        subtitle="Commercial follow-up within 2 staffed hours after an attended demo or confirmed no-show"
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => set({ from: todayIST(), to: todayIST() })}>
              Today
            </Button>
            <Button size="sm" variant="outline" onClick={() => set({ from: todayIST(), to: undefined })}>
              Upcoming
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSearch({})}>
              All
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From" htmlFor="demo-from">
            <Input id="demo-from" type="date" value={search.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
          </Field>
          <Field label="To" htmlFor="demo-to">
            <Input id="demo-to" type="date" value={search.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
          </Field>
          <Field label="Status" htmlFor="demo-status">
            <NativeSelect id="demo-status" value={search.status ?? ""} placeholder="Any" options={DEMO_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ status: e.target.value || undefined })} />
          </Field>
          <Field label="Trainer" htmlFor="demo-trainer">
            <StaffSelect
              id="demo-trainer"
              branchId={branchId}
              roles={["TRAINER"]}
              placeholder="Any trainer"
              value={search.trainer_id ?? ""}
              onChange={(e) => set({ trainer_id: e.target.value ? Number(e.target.value) : undefined })}
            />
          </Field>
        </div>
        {demos.isLoading ? (
          <LoadingRows />
        ) : demos.error ? (
          <ErrorPanel error={demos.error} onRetry={() => void demos.refetch()} />
        ) : !rows?.length ? (
          <Empty title="No demos match">Try another date range or status.</Empty>
        ) : (
          <div className="space-y-3">
            {rows.map((d) => {
              const open = OPEN_DEMO_STATUSES.includes(d.status);
              const started = isPast(d.scheduled_at);
              const attended = Number(d.attended_demos?.split(" ")[0] ?? 0);
              const canOutcome = open && (salesSide || isTrainer);
              return (
                <article key={d.demo_id} className="rounded-md border p-3 text-sm" aria-label={`Demo ${d.demo_code}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <b>{d.demo_code}</b> ·{" "}
                      <Link to="/leads/$leadId" params={{ leadId: String(d.lead.lead_id) }} className="text-primary">
                        {d.lead.name}
                      </Link>{" "}
                      · {d.course?.course_title ?? "No course"} · {d.branch.branch_name}
                      <div className="text-xs text-muted-foreground">
                        {dateTime(d.scheduled_at)} · {d.duration_minutes} min · {d.demo_type} · {d.trainer?.full_name ?? "Trainer not assigned"} · {d.mode} · lead stage:{" "}
                        {d.lead.stage}
                        {d.attended_demos ? ` · attended demos: ${d.attended_demos}` : ""}
                      </div>
                    </div>
                    <Status>{d.status}</Status>
                  </div>
                  {d.outcome && (
                    <div className="mt-2 text-xs">
                      Outcome: <b>{d.outcome}</b>
                    </div>
                  )}
                  {openReminders === d.demo_id && <Reminders demoId={d.demo_id} />}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setOpenReminders((x) => (x === d.demo_id ? null : d.demo_id))}>
                      <Bell />
                      {openReminders === d.demo_id ? "Hide reminders" : "Reminders"}
                    </Button>
                    {open && salesSide && d.status === "Scheduled" && (
                      <Button size="sm" variant="outline" disabled={confirm.isPending} onClick={() => confirm.mutate(d.demo_id)}>
                        <CheckCircle2 />
                        Confirm
                      </Button>
                    )}
                    {open && salesSide && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setAct({ kind: "edit", demo: d })}>
                          <Pencil />
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setAct({ kind: "reschedule", demo: d })}>
                          <CalendarClock />
                          Reschedule
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setAct({ kind: "cancel", demo: d })}>
                          <XCircle />
                          Cancel
                        </Button>
                      </>
                    )}
                    {canOutcome && (
                      <Button
                        size="sm"
                        disabled={!started}
                        title={started ? undefined : "Available once the demo has started"}
                        onClick={() => setAct({ kind: "outcome", demo: d })}
                      >
                        <Check />
                        Record attendance / outcome
                      </Button>
                    )}
                    {open && canApproveExtra && attended >= 2 && (
                      <ConfirmAction
                        trigger={
                          <Button size="sm" variant="outline">
                            <ShieldCheck />
                            Approve extra demo
                          </Button>
                        }
                        title={`Approve extra demo ${d.demo_code}?`}
                        description={`${d.lead.name} has already attended ${d.attended_demos} demos. Your approval is recorded in the audit trail.`}
                        action="Approve"
                        onConfirm={() => approveExtra.mutateAsync(d.demo_id)}
                      />
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <Pagination meta={demos.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </Section>
      {act?.kind === "edit" && <EditDemoDialog demo={act.demo} onClose={() => setAct(null)} />}
      {act?.kind === "reschedule" && <RescheduleDialog demo={act.demo} onClose={() => setAct(null)} />}
      {act?.kind === "cancel" && <CancelDialog demo={act.demo} onClose={() => setAct(null)} />}
      {act?.kind === "outcome" && <OutcomeDialog demo={act.demo} isTrainer={isTrainer && !salesSide} userName={profile?.user.full_name} onClose={() => setAct(null)} />}
    </>
  );
}

function Reminders({ demoId }: { demoId: number }) {
  const q = useQuery({ queryKey: demoKeys.reminders(demoId), queryFn: () => demosApi.reminders(demoId) });
  if (q.isLoading) return <LoadingRows rows={1} />;
  if (q.error) return <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data?.length) return <p className="mt-2 text-xs text-muted-foreground">No reminders.</p>;
  return (
    <ul className="mt-2 flex flex-wrap gap-1 text-xs" aria-label="Reminders">
      {q.data.map((r) => (
        <li key={r.reminder_id} className="rounded border px-2 py-0.5" title={r.failure_reason ?? r.note ?? undefined}>
          {r.reminder_type}: <b>{r.state}</b> · {r.sent_at ? `sent ${dateTime(r.sent_at)}` : `due ${dateTime(r.due_at)}`}
        </li>
      ))}
    </ul>
  );
}

function EditDemoDialog({ demo, onClose }: { demo: DemoRow; onClose: () => void }) {
  const detail = useQuery({ queryKey: demoKeys.detail(demo.demo_id), queryFn: () => demosApi.get(demo.demo_id) });
  const form = useForm({
    values: {
      trainer_user_id: demo.trainer ? String(demo.trainer.user_id) : "",
      mode: demo.mode,
      duration_minutes: String(demo.duration_minutes),
      meeting_link: detail.data?.meeting_link ?? "",
    },
  });
  const save = useApiMutation(
    (v: { trainer_user_id: string; mode: string; duration_minutes: string; meeting_link: string }) =>
      demosApi.update(demo.demo_id, {
        trainer_user_id: v.trainer_user_id ? Number(v.trainer_user_id) : null,
        mode: v.mode,
        duration_minutes: Number(v.duration_minutes),
        meeting_link: v.mode === "Online" ? v.meeting_link || null : null,
      }),
    { success: (d) => `${d.demo_code} updated`, invalidate: INVALIDATE, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog title={`Edit ${demo.demo_code}`} description={`${demo.lead.name} · ${dateTime(demo.scheduled_at)}`} onClose={onClose} busy={save.isPending} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <Field label="Trainer" htmlFor="edit-trainer" error={form.formState.errors.trainer_user_id?.message}>
        <StaffSelect id="edit-trainer" branchId={demo.branch.branch_id} roles={["TRAINER"]} placeholder="Assign later" {...form.register("trainer_user_id")} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mode" htmlFor="edit-mode">
          <NativeSelect id="edit-mode" options={["In-person", "Online"].map((t) => ({ value: t, label: t }))} {...form.register("mode")} />
        </Field>
        <Field label="Duration (minutes)" htmlFor="edit-duration" error={form.formState.errors.duration_minutes?.message}>
          <Input id="edit-duration" type="number" min={15} max={60} step={15} {...form.register("duration_minutes")} />
        </Field>
      </div>
      {form.watch("mode") === "Online" && (
        <Field label="Meeting link" htmlFor="edit-link" error={form.formState.errors.meeting_link?.message}>
          <Input id="edit-link" type="url" {...form.register("meeting_link")} />
        </Field>
      )}
    </FormDialog>
  );
}

function RescheduleDialog({ demo, onClose }: { demo: DemoRow; onClose: () => void }) {
  const form = useForm({ defaultValues: { scheduled_at: toLocalInput(demo.scheduled_at), reason: "" } });
  const go = useApiMutation(
    (v: { scheduled_at: string; reason: string }) => demosApi.reschedule(demo.demo_id, { scheduled_at: fromLocalInput(v.scheduled_at)!, reason: v.reason }),
    { success: (d) => `${demo.demo_code} rescheduled as ${d.demo_code} · old reminders superseded`, invalidate: INVALIDATE, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog
      title={`Reschedule ${demo.demo_code}`}
      description="The old demo becomes Rescheduled and its pending reminders are superseded; a new demo carries the booking forward."
      onClose={onClose}
      busy={go.isPending}
      submitLabel="Confirm reschedule"
      onSubmit={form.handleSubmit((v) => go.mutate(v))}
    >
      <Field label="New date / time (IST)" htmlFor="res-at" error={form.formState.errors.scheduled_at?.message}>
        <Input id="res-at" type="datetime-local" {...form.register("scheduled_at", { required: "Required" })} />
      </Field>
      <Field label="Reason (required)" htmlFor="res-reason" error={form.formState.errors.reason?.message}>
        <NativeSelect id="res-reason" placeholder="Choose reason" options={RESCHEDULE_REASONS.map((r) => ({ value: r, label: r }))} {...form.register("reason", { required: "Required" })} />
      </Field>
    </FormDialog>
  );
}

function CancelDialog({ demo, onClose }: { demo: DemoRow; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const go = useApiMutation(() => demosApi.cancel(demo.demo_id, reason), {
    success: (d) => `${d.demo_code} cancelled · pending reminders cleared`,
    invalidate: INVALIDATE,
    onSuccess: onClose,
  });
  return (
    <FormDialog
      title={`Cancel ${demo.demo_code}`}
      description="Pending reminders are cleared. No message is sent to the student."
      onClose={onClose}
      busy={go.isPending}
      disabled={!reason}
      destructive
      submitLabel="Confirm cancellation"
      onSubmit={() => go.mutate(undefined)}
    >
      <Field label="Cancellation reason (required)" htmlFor="cancel-reason">
        <NativeSelect id="cancel-reason" value={reason} placeholder="Choose reason" options={CANCEL_REASONS.map((r) => ({ value: r, label: r }))} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

type OutcomeForm = {
  status: "Attended" | "No Show";
  student_feedback: string;
  trainer_feedback: string;
  rating: string;
  outcome: string;
  recommended_course_id: string;
  next_action: string;
  commercial_owner_id: string;
  next_follow_up_at: string;
};

function OutcomeDialog({ demo, onClose, isTrainer, userName }: { demo: DemoRow; onClose: () => void; isTrainer: boolean; userName: string | undefined }) {
  const branchCode = useBranchCode(demo.branch.branch_id);
  const form = useForm<OutcomeForm>({
    defaultValues: {
      status: "Attended",
      student_feedback: "",
      trainer_feedback: "",
      rating: "",
      outcome: DEMO_OUTCOMES[0],
      recommended_course_id: "",
      next_action: "Fee discussion",
      commercial_owner_id: "",
      next_follow_up_at: "",
    },
  });
  const save = useApiMutation(
    (v: OutcomeForm) =>
      demosApi.outcome(demo.demo_id, {
        status: v.status,
        student_feedback: v.student_feedback || null,
        trainer_feedback: v.trainer_feedback || null,
        rating: v.rating ? Number(v.rating) : null,
        outcome: v.outcome || null,
        recommended_course_id: v.recommended_course_id ? Number(v.recommended_course_id) : null,
        next_action: v.next_action || null,
        commercial_owner_id: v.commercial_owner_id ? Number(v.commercial_owner_id) : null,
        next_follow_up_at: fromLocalInput(v.next_follow_up_at)!,
      }),
    {
      success: (d) => `${d.demo_code} marked ${d.status} · commercial follow-up task created`,
      invalidate: INVALIDATE,
      onSuccess: onClose,
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  const e = form.formState.errors;
  return (
    <FormDialog
      title={`Attendance & outcome · ${demo.demo_code}`}
      description={`${demo.lead.name} · ${isTrainer ? `recorded by ${userName ?? "trainer"}` : "commercial follow-up target: within 2 staffed hours"}`}
      onClose={onClose}
      busy={save.isPending}
      submitLabel="Save outcome"
      onSubmit={form.handleSubmit((v) => save.mutate(v))}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Attendance" htmlFor="out-status">
          <NativeSelect id="out-status" options={["Attended", "No Show"].map((s) => ({ value: s, label: s }))} {...form.register("status")} />
        </Field>
        <Field label="Rating (1–5)" htmlFor="out-rating" error={e.rating?.message}>
          <NativeSelect id="out-rating" placeholder="—" options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} {...form.register("rating")} />
        </Field>
      </div>
      <Field label="Student feedback" htmlFor="out-sf">
        <Textarea id="out-sf" {...form.register("student_feedback")} />
      </Field>
      <Field label="Trainer feedback" htmlFor="out-tf">
        <Textarea id="out-tf" {...form.register("trainer_feedback")} />
      </Field>
      <Field label="Outcome" htmlFor="out-outcome" error={e.outcome?.message}>
        <NativeSelect id="out-outcome" options={DEMO_OUTCOMES.map((o) => ({ value: o, label: o }))} {...form.register("outcome")} />
      </Field>
      <Field label="Recommended course" htmlFor="out-course" error={e.recommended_course_id?.message}>
        <CourseSelect id="out-course" branchCode={branchCode} placeholder="Same course" {...form.register("recommended_course_id")} />
      </Field>
      <Field label="Next action" htmlFor="out-next">
        <Input id="out-next" {...form.register("next_action")} />
      </Field>
      <Field label="Commercial owner" htmlFor="out-owner" hint="Defaults to the lead owner" error={e.commercial_owner_id?.message}>
        <StaffSelect id="out-owner" branchId={demo.branch.branch_id} roles={LEAD_OWNER_ROLES} placeholder="Lead owner" {...form.register("commercial_owner_id")} />
      </Field>
      <Field label="Next follow-up (exact IST)" htmlFor="out-fu" error={e.next_follow_up_at?.message}>
        <Input id="out-fu" type="datetime-local" {...form.register("next_follow_up_at", { required: "Required" })} />
      </Field>
    </FormDialog>
  );
}
