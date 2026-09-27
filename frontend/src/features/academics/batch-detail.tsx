import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CalendarCheck, Pencil, Users } from "lucide-react";
import { admissionKeys, admissionsApi, type Allocation } from "@/api/admissions";
import { batchKeys, batchesApi, useBatch, type Batch } from "@/api/batches";
import { studentKeys } from "@/api/students";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { BatchDialog } from "./batch-dialog";
import { timing } from "./batches-list";
import { useCan } from "./can";
import { CheckResult, FormDialog } from "./shared";

const INVALIDATE = [batchKeys.all, admissionKeys.all, studentKeys.all];

/** Next lifecycle step offered as a one-click status change. */
const NEXT_STATUS: Record<string, { to: string; label: string }[]> = {
  Planned: [{ to: "Open", label: "Open for allocation" }],
  Open: [
    { to: "In Progress", label: "Mark In Progress" },
    { to: "Planned", label: "Close for allocation" },
  ],
  "In Progress": [{ to: "Completed", label: "Complete batch" }],
};

export function BatchDetailView({ batchId }: { batchId: number }) {
  const query = useBatch(batchId);
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const setStatus = useApiMutation((status: string) => batchesApi.update(batchId, { status }), {
    success: (b) => `${b.batch_code} is now ${b.status}`,
    invalidate: INVALIDATE,
  });

  if (query.isLoading) return <LoadingRows rows={8} />;
  if (query.error) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;
  const b = query.data!;
  const academic = can.academic(b.branch.branch_id);
  const closed = ["Completed", "Cancelled"].includes(b.status);

  return (
    <>
      <PageHead
        title={`${b.batch_code} · ${b.batch_name}`}
        description={`${b.branch.branch_name} · ${b.course.course_title}`}
        actions={
          academic && !closed ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil />
                Edit batch
              </Button>
              {(NEXT_STATUS[b.status] ?? []).map((s) => (
                <ConfirmAction
                  key={s.to}
                  title={`${s.label}?`}
                  description={`${b.batch_code} moves from ${b.status} to ${s.to}.`}
                  action={s.label}
                  onConfirm={() => setStatus.mutateAsync(s.to)}
                  trigger={<Button variant="outline">{s.label}</Button>}
                />
              ))}
              <ConfirmAction
                title={`Cancel ${b.batch_code}?`}
                action="Cancel batch"
                destructive
                onConfirm={() => setStatus.mutateAsync("Cancelled")}
                trigger={
                  <Button variant="ghost" className="text-destructive">
                    Cancel batch
                  </Button>
                }
              />
            </>
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Schedule b={b} />
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Allocate batchId={batchId} />
          <Members batchId={batchId} />
        </div>
      </div>
      {academic && <BatchDialog open={editing} onOpenChange={setEditing} batch={b} />}
    </>
  );
}

function Schedule({ b }: { b: Batch }) {
  const rows: [string, string][] = [
    ["Branch", b.branch.branch_name],
    ["Course", `${b.course.course_code} · ${b.course.course_title}`],
    ["Curriculum version", b.curriculum_version?.version_label ?? "Not set"],
    ["Trainer", b.trainer?.full_name ?? "Not assigned"],
    ["Mode", b.delivery_mode],
    ["Start", date(b.start_date)],
    ["Expected end", date(b.end_date)],
    ["Timing", timing(b)],
    ["Class days", b.schedule_days ?? "—"],
    ["Room / link", b.location ?? "—"],
    ["Minimum students", b.min_students ? String(b.min_students) : "—"],
    ["Capacity / occupancy", `${b.allocated}/${b.capacity} · ${b.seats_left} seats left`],
    ["LMS course", b.lms_course_id ?? "—"],
  ];
  return (
    <Section title="Schedule" className="min-w-0">
      <div className="mb-3">
        <Status>{b.is_full && b.status === "Open" ? "Full" : b.status}</Status>
      </div>
      <dl className="space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Allocate({ batchId }: { batchId: number }) {
  const { data: b } = useBatch(batchId);
  const can = useCan();
  const [admissionId, setAdmissionId] = useState("");
  const check = useQuery({
    queryKey: batchKeys.check(batchId, Number(admissionId)),
    queryFn: () => batchesApi.allocationCheck(batchId, Number(admissionId)),
    enabled: !!admissionId,
  });
  const allocate = useApiMutation(() => admissionsApi.allocate(Number(admissionId), batchId), {
    success: (r) => `Allocated ${r.admission_code} → ${r.batch_code}. First regular attendance still pending.`,
    invalidate: INVALIDATE,
    onSuccess: () => setAdmissionId(""),
  });
  if (!b) return null;
  const canAllocate = can.academic(b.branch.branch_id);
  return (
    <Section title="Allocate admission" subtitle="Checks branch, course, curriculum mapping and capacity" className="min-w-0">
      {!canAllocate && <Warning>You can view but not allocate. Academic Coordinator, Branch Manager, Founder / CEO or Super Admin allocate.</Warning>}
      {canAllocate && (
        <>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Admission to allocate" htmlFor="ba-admission">
              <NativeSelect
                id="ba-admission"
                value={admissionId}
                placeholder={b.awaiting_allocation.length ? "Choose admission awaiting allocation" : "No admissions awaiting allocation for this course"}
                options={b.awaiting_allocation.map((r) => ({
                  value: r.admission.admission_id,
                  label: `${r.admission.admission_code} · ${r.admission.person.full_name} · ${r.admission.course.course_title} · service ${r.admission.service_branch.branch_code}`,
                }))}
                onChange={(e) => setAdmissionId(e.target.value)}
              />
            </Field>
            <Button disabled={!admissionId || allocate.isPending || check.data?.ok === false} onClick={() => allocate.mutate(undefined)}>
              <Users />
              Allocate
            </Button>
          </div>
          {check.data && (
            <div className="mt-2">
              <CheckResult ok={check.data.ok} reason={check.data.reason} owner={check.data.recovery_owner} />
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function Members({ batchId }: { batchId: number }) {
  const { data: b } = useBatch(batchId);
  const can = useCan();
  const [showClosed, setShowClosed] = useState(false);
  const [joining, setJoining] = useState(todayIST());
  const [close, setClose] = useState<{ status: "Moved" | "Withdrawn" | "Completed"; reason: string }>({ status: "Moved", reason: "" });
  const allocations = (b?.allocations ?? []).filter((x) => showClosed || x.status === "Active");
  // Allocation rows carry only the admission code; fetch each admission for the learner's name.
  const people = useQueries({
    queries: allocations.map((x) => ({ queryKey: admissionKeys.detail(x.admission_id), queryFn: () => admissionsApi.get(x.admission_id), staleTime: 60_000 })),
  });
  const nameOf = (id: number) => people.find((p) => p.data?.admission_id === id)?.data?.person;
  const setJoin = useApiMutation((id: number) => batchesApi.setJoiningDate(id, joining), { success: "First regular class attendance recorded", invalidate: INVALIDATE });
  const doClose = useApiMutation((id: number) => batchesApi.closeAllocation(id, { status: close.status, reason: close.reason || null }), {
    success: "Allocation closed",
    invalidate: INVALIDATE,
  });
  if (!b) return null;
  const branch = b.branch.branch_id;
  const canJoin = can.coordinator(branch) || can.at(branch, "TRAINER");

  const actions = (x: Allocation) => (
    <div className="flex gap-1">
      {x.status === "Active" && !x.joining_date && canJoin && (
        <FormDialog
          title={`Record first attendance · ${x.admission_code}`}
          description="First confirmed regular class (demos excluded). Moves enrolment to In Progress."
          submitLabel="Record joining"
          onOpen={() => setJoining(todayIST())}
          onSubmit={() => setJoin.mutateAsync(x.allocation_id)}
          trigger={
            <Button size="sm" variant="outline">
              <CalendarCheck />
              Record first attendance
            </Button>
          }
        >
          <Field label="Joining date" htmlFor={`bj-${x.allocation_id}`}>
            <Input id={`bj-${x.allocation_id}`} type="date" value={joining} min={b.start_date} max={todayIST()} onChange={(e) => setJoining(e.target.value)} />
          </Field>
        </FormDialog>
      )}
      {x.status === "Active" && can.coordinator(branch) && (
        <FormDialog
          title={`Close allocation · ${x.admission_code}`}
          submitLabel="Close allocation"
          onOpen={() => setClose({ status: "Moved", reason: "" })}
          onSubmit={() => doClose.mutateAsync(x.allocation_id)}
          trigger={
            <Button size="sm" variant="ghost">
              Close allocation
            </Button>
          }
        >
          <Field label="Outcome" htmlFor={`bc-${x.allocation_id}`}>
            <NativeSelect
              id={`bc-${x.allocation_id}`}
              value={close.status}
              options={["Moved", "Withdrawn", "Completed"].map((s) => ({ value: s, label: s }))}
              onChange={(e) => setClose({ ...close, status: e.target.value as typeof close.status })}
            />
          </Field>
          <Field label="Reason (optional)" htmlFor={`bcr-${x.allocation_id}`}>
            <Textarea id={`bcr-${x.allocation_id}`} value={close.reason} onChange={(e) => setClose({ ...close, reason: e.target.value })} />
          </Field>
        </FormDialog>
      )}
    </div>
  );

  return (
    <Section
      title="Allocated in this batch"
      className="min-w-0"
      action={
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed allocations
        </label>
      }
    >
      <DataTable
        rows={allocations}
        rowKey={(x) => x.allocation_id}
        empty={<Empty title="No admissions allocated yet" />}
        columns={[
          {
            header: "Admission",
            cell: (x) => (
              <Link to="/admissions" search={{ admission: x.admission_id }} className="font-medium text-primary">
                {x.admission_code}
              </Link>
            ),
          },
          {
            header: "Person",
            cell: (x) => {
              const p = nameOf(x.admission_id);
              return p ? (
                <Link to="/students/$personId" params={{ personId: String(p.person_id) }} className="text-primary">
                  {p.full_name}
                </Link>
              ) : (
                "…"
              );
            },
          },
          { header: "Status", cell: (x) => <Status>{x.status}</Status> },
          { header: "Allocated", cell: (x) => dateTime(x.allocated_at) },
          { header: "First regular attendance (Joining Date)", cell: (x) => (x.joining_date ? date(x.joining_date) : "Not yet recorded") },
          { header: "", cell: actions },
        ]}
      />
    </Section>
  );
}
