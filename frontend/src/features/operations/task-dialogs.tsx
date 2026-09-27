import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { taskKeys, tasksApi, TASK_LINK_FIELDS, type NewTask, type Task, type TaskLinkField } from "@/api/tasks";
import { useBranches } from "@/api/reference";
import type { RoleCode } from "@/api/types";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, Field, LookupSelect, NativeSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { ConfirmAction, ErrorPanel, Facts, LoadingRows, Status } from "@/components/crm/ui";
import { dateTime, fromLocalInput, relative } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { LINK_LABELS, LinkedRecord } from "./linked-record";

export const TASK_OWNER_ROLES: RoleCode[] = [
  "BRANCH_MANAGER",
  "SALES",
  "FRONT_OFFICE",
  "ACCOUNTS",
  "ACADEMIC_COORDINATOR",
  "TRAINER",
  "PLACEMENT",
  "HR",
];

const ROLE_NAMES: Record<string, string> = {
  FOUNDER_CEO: "Founder / CEO",
  SUPER_ADMIN: "Super Admin",
  BRANCH_MANAGER: "Branch Manager",
  SALES: "Sales",
  FRONT_OFFICE: "Front Office",
  ACCOUNTS: "Accounts",
  ACADEMIC_COORDINATOR: "Academic Coordinator",
  TRAINER: "Trainer",
  PLACEMENT: "Placement",
  HR: "HR",
};

export function ownerLabel(t: Pick<Task, "owner" | "team_role">) {
  if (t.owner) return t.owner.full_name;
  return t.team_role ? `Unassigned · ${ROLE_NAMES[t.team_role] ?? t.team_role} team` : "Unassigned";
}

export function conditionLabel(t: Task): string {
  const parts: string[] = [];
  if (t.is_unassigned && !["Completed", "Cancelled"].includes(t.status)) parts.push("Unassigned");
  if (t.is_overdue) parts.push("Overdue");
  else if (t.is_due_today) parts.push("Due Today");
  if (!parts.length && !["Completed", "Cancelled"].includes(t.status)) parts.push("On track");
  return parts.join(" · ");
}

export const isOpenTask = (t: Pick<Task, "status">) => !["Completed", "Cancelled"].includes(t.status);

/** Who may work a task (mirrors services/tasks._workable, minus "creator" which the API doesn't expose). */
export function useTaskPermissions(task: Task | undefined) {
  const { profile, roles, isAdmin, hasRole } = useAuth();
  const me = profile?.user.user_id;
  const manager = isAdmin || (hasRole("BRANCH_MANAGER") && Boolean(profile?.scopes.some((s) => s.role_code === "BRANCH_MANAGER" && s.branch_id === task?.branch_id)));
  const teamMember = Boolean(task && task.owner_user_id === null && (task.team_role === null || roles.includes(task.team_role as RoleCode)));
  const canWork = Boolean(task && (manager || task.owner_user_id === me || teamMember));
  return { manager, canWork };
}

// ---------------------------------------------------------------- create

type NewValues = {
  task_type_id: string;
  title: string;
  description: string;
  branch_id: string;
  owner_user_id: string;
  due_at: string;
  link_field: string;
  link_id: string;
};

export function NewTaskDialog({
  open,
  onOpenChange,
  presetLink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetLink?: { field: TaskLinkField; id: number } | undefined;
}) {
  const { branches, branchId, profile } = useAuth();
  const defaults = (): NewValues => ({
    task_type_id: "",
    title: "",
    description: "",
    branch_id: String(branchId ?? (branches.length === 1 ? branches[0]!.branch_id : "")),
    owner_user_id: profile ? String(profile.user.user_id) : "",
    due_at: "",
    link_field: presetLink?.field ?? "",
    link_id: presetLink ? String(presetLink.id) : "",
  });
  const form = useForm<NewValues>({ defaultValues: defaults() });
  const { register, handleSubmit, formState, reset, watch, setValue } = form;
  const branch = watch("branch_id");
  const linkField = watch("link_field");

  useEffect(() => {
    if (open) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useApiMutation(tasksApi.create, {
    success: (t) => `Task #${t.task_id} created`,
    invalidate: [taskKeys.all],
    silentValidation: true,
    onSuccess: () => onOpenChange(false),
    onError: (error) => applyServerErrors(form, error),
  });

  const submit = handleSubmit((v) => {
    const body: NewTask = {
      task_type_id: Number(v.task_type_id),
      title: v.title.trim(),
      description: v.description.trim() || null,
      branch_id: Number(v.branch_id),
      owner_user_id: v.owner_user_id ? Number(v.owner_user_id) : null,
      due_at: fromLocalInput(v.due_at)!,
      link: v.link_field && v.link_id ? { [v.link_field]: Number(v.link_id) } : null,
    };
    create.mutate(body);
  });
  const err = (name: keyof NewValues) => formState.errors[name]?.message;
  const required = { required: "Required" };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>Manual tasks sit alongside system tasks in the shared work queue. Reassigning a task never changes the lead or admission owner.</DialogDescription>
        </DialogHeader>
        <form id="new-task-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Task type" error={err("task_type_id")} htmlFor="nt-type">
            <LookupSelect id="nt-type" lookup="task_types" {...register("task_type_id", required)} />
          </Field>
          <Field label="Branch" error={err("branch_id")} htmlFor="nt-branch">
            <BranchSelect id="nt-branch" {...register("branch_id", { ...required, onChange: () => setValue("owner_user_id", "") })} />
          </Field>
          <Field label="Title" error={err("title")} htmlFor="nt-title" className="sm:col-span-2">
            <Input id="nt-title" {...register("title", required)} />
          </Field>
          <Field label="Description (optional)" htmlFor="nt-desc" className="sm:col-span-2">
            <Textarea id="nt-desc" rows={2} {...register("description")} />
          </Field>
          <Field label="Owner" error={err("owner_user_id")} htmlFor="nt-owner" hint="Leave unassigned to put it in the team queue">
            <StaffSelect id="nt-owner" branchId={branch ? Number(branch) : undefined} roles={TASK_OWNER_ROLES} placeholder="Unassigned" {...register("owner_user_id")} />
          </Field>
          <Field label="Due" error={err("due_at")} htmlFor="nt-due">
            <Input id="nt-due" type="datetime-local" {...register("due_at", required)} />
          </Field>
          <Field label="Linked record type (optional)" error={err("link_field" as never)} htmlFor="nt-link-field">
            <NativeSelect
              id="nt-link-field"
              placeholder="No linked record"
              options={TASK_LINK_FIELDS.map((f) => ({ value: f, label: LINK_LABELS[f] }))}
              {...register("link_field")}
            />
          </Field>
          <Field label="Linked record ID" error={err("link_id") ?? (formState.errors as Record<string, { message?: string }>)["link"]?.message} htmlFor="nt-link-id">
            <Input id="nt-link-id" type="number" min={1} disabled={!linkField} {...register("link_id", { validate: (v) => !linkField || Boolean(v) || "Enter the record ID" })} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-task-form" disabled={create.isPending}>
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- detail + actions

export function TaskDialog({ taskId, onOpenChange }: { taskId: number | null; onOpenChange: (open: boolean) => void }) {
  const task = useQuery({ queryKey: taskKeys.detail(taskId ?? 0), queryFn: () => tasksApi.get(taskId!), enabled: taskId !== null });
  return (
    <Dialog open={taskId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task.data ? `Task #${task.data.task_id} · ${task.data.task_type}` : "Task"}</DialogTitle>
          <DialogDescription>{task.data?.title ?? "Loading…"}</DialogDescription>
        </DialogHeader>
        {task.isLoading ? <LoadingRows rows={4} /> : task.error ? <ErrorPanel error={task.error} onRetry={() => void task.refetch()} /> : task.data ? <TaskBody task={task.data} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TaskBody({ task }: { task: Task }) {
  const { data: branches } = useBranches();
  const { manager, canWork } = useTaskPermissions(task);
  const [due, setDue] = useState("");
  const [revReason, setRevReason] = useState("");
  const [owner, setOwner] = useState("");
  const open = isOpenTask(task);
  const opts = { invalidate: [taskKeys.all] };

  const transition = useApiMutation((v: { action: "start" | "block" | "complete" | "cancel"; reason?: string }) => tasksApi.transition(task.task_id, v.action, v.reason), {
    ...opts,
    success: (t) => `Task ${t.status === "Waiting/Blocked" ? "blocked" : t.status.toLowerCase()}`,
  });
  const revise = useApiMutation((v: { due: string; reason: string }) => tasksApi.reviseDeadline(task.task_id, fromLocalInput(v.due)!, v.reason), {
    ...opts,
    success: "Deadline revised",
    onSuccess: () => {
      setDue("");
      setRevReason("");
    },
  });
  const reassign = useApiMutation((ownerId: number) => tasksApi.update(task.task_id, { owner_user_id: ownerId }), {
    ...opts,
    success: (t) => `Reassigned to ${t.owner?.full_name ?? "—"}`,
    onSuccess: () => setOwner(""),
  });

  return (
    <div className="space-y-5">
      <Facts
        items={[
          ["Workflow status", <Status key="s">{task.status}</Status>],
          ["Branch", branches?.find((b) => b.branch_id === task.branch_id)?.branch_name ?? task.branch_id],
          ["Owner", ownerLabel(task)],
          ["Source", task.source],
          ["Original deadline", dateTime(task.original_due_at)],
          [
            "Revised deadline",
            task.revised_due_at ? (
              <span key="r">
                {dateTime(task.revised_due_at)}
                <small className="block text-xs text-muted-foreground">Reason: {task.revision_reason}</small>
              </span>
            ) : (
              "—"
            ),
          ],
          ["Due", `${dateTime(task.due_at)} (${relative(task.due_at)})`],
          ["Linked record", <LinkedRecord key="l" task={task} />],
          ...(task.description ? ([["Description", task.description]] as [string, string][]) : []),
          ...(task.blocked_reason ? ([["Blocked reason", task.blocked_reason]] as [string, string][]) : []),
          ...(task.cancel_reason ? ([["Cancel reason", task.cancel_reason]] as [string, string][]) : []),
          ...(task.completed_at ? ([["Completed", dateTime(task.completed_at)]] as [string, string][]) : []),
          ["Created", dateTime(task.created_at)],
        ]}
      />
      {!open ? (
        <p className="text-sm text-muted-foreground">This task is {task.status.toLowerCase()} — no further actions.</p>
      ) : !canWork ? (
        <p className="text-sm text-muted-foreground">Only the task owner, its team or a branch manager can change this task.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {task.status !== "In Progress" && (
              <Button variant="outline" disabled={transition.isPending} onClick={() => transition.mutate({ action: "start" })}>
                {task.status === "Waiting/Blocked" ? "Resume" : "Start"}
              </Button>
            )}
            <Button disabled={transition.isPending} onClick={() => transition.mutate({ action: "complete" })}>
              Complete
            </Button>
            <ConfirmAction
              trigger={<Button variant="outline">Block</Button>}
              title="Mark task waiting / blocked"
              description="Record what the task is waiting on."
              action="Block task"
              reason
              reasonLabel="Blocked reason"
              onConfirm={(reason) => transition.mutateAsync({ action: "block", reason })}
            />
            {manager && (
              <ConfirmAction
                trigger={<Button variant="destructive">Cancel task</Button>}
                title="Cancel this task?"
                description="Cancelled tasks stay on record with the reason."
                action="Cancel task"
                destructive
                reason
                reasonLabel="Cancel reason"
                onConfirm={(reason) => transition.mutateAsync({ action: "cancel", reason })}
              />
            )}
          </div>
          <div className="rounded-md border p-3">
            <h3 className="mb-2 text-sm font-semibold">Revise deadline</h3>
            <p className="mb-3 text-xs text-muted-foreground">The original deadline ({dateTime(task.original_due_at)}) is kept and stays visible.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="New deadline" htmlFor="td-due">
                <Input id="td-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              </Field>
              <Field label="Reason for revision" htmlFor="td-reason">
                <Input id="td-reason" value={revReason} onChange={(e) => setRevReason(e.target.value)} />
              </Field>
            </div>
            <Button className="mt-2" size="sm" variant="outline" disabled={!due || !revReason.trim() || revise.isPending} onClick={() => revise.mutate({ due, reason: revReason.trim() })}>
              Revise deadline
            </Button>
          </div>
          {manager && (
            <div className="rounded-md border p-3">
              <h3 className="mb-2 text-sm font-semibold">Reassign</h3>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="New owner" htmlFor="td-owner" className="min-w-0 flex-1 basis-56">
                  <StaffSelect id="td-owner" branchId={task.branch_id} roles={TASK_OWNER_ROLES} placeholder="Choose owner…" value={owner} onChange={(e) => setOwner(e.target.value)} />
                </Field>
                <Button size="sm" variant="outline" disabled={!owner || reassign.isPending} onClick={() => reassign.mutate(Number(owner))}>
                  Reassign
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Reassignment never changes the Lead Owner or Admission.</p>
            </div>
          )}
        </>
      )}
      <DialogFooter />
    </div>
  );
}
