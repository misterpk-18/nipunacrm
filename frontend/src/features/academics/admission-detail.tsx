import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, BadgeCheck, Ban, CalendarCheck, Gift, IndianRupee, Pencil, Users } from "lucide-react";
import {
  DELIVERY_MODES,
  HANDOVER_STATUSES,
  LMS_STATUSES,
  admissionKeys,
  admissionsApi,
  useAdmission,
  type AdmissionDetail,
  type Allocation,
} from "@/api/admissions";
import { batchKeys, batchesApi, useCurriculumVersions } from "@/api/batches";
import { useBranches, useCourses } from "@/api/reference";
import { studentKeys } from "@/api/students";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/crm/forms";
import { ConfirmAction, DataTable, ErrorPanel, Facts, LoadingRows, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { useCan } from "./can";
import { CheckResult, FormDialog } from "./shared";

const INVALIDATE = [admissionKeys.all, batchKeys.all, studentKeys.all, ["tasks"], ["invoices"]];

/** Everything about one admission, with the actions the current role may take. */
export function AdmissionPanel({ admissionId }: { admissionId: number }) {
  const query = useAdmission(admissionId);
  if (query.isLoading) return <LoadingRows rows={8} />;
  if (query.error) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;
  const a = query.data!;
  return (
    <div className="space-y-4">
      <Summary a={a} />
      <Actions a={a} />
      <Allocations a={a} />
      <Curriculum a={a} />
      <FeeChanges a={a} />
    </div>
  );
}

function Summary({ a }: { a: AdmissionDetail }) {
  return (
    <Section title="Admission and enrolment" subtitle={`${a.admission_code} · admitted ${date(a.admission_date)}`}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Status>{a.enrolment_status}</Status>
        <Status>{a.curriculum_status === "Mapped" ? "Curriculum Mapped" : "Curriculum Mapping Pending"}</Status>
        <Status>{`Payment ${a.payment_completion}`}</Status>
        {a.complimentary_of_admission_id && <Status kind="neutral">Complimentary</Status>}
      </div>
      {a.cancellation && (
        <div className="mb-3">
          <Warning>
            Cancelled {dateTime(a.cancellation.cancelled_at)} — {a.cancellation.reason}
          </Warning>
        </div>
      )}
      <Facts
        items={[
          [
            "Person",
            <Link to="/students/$personId" params={{ personId: String(a.person.person_id) }} className="text-primary">
              {a.person.full_name} <small className="text-muted-foreground">{a.person.person_code}</small>
            </Link>,
          ],
          ["Course", `${a.course.course_title} (${a.course.course_code})`],
          ["Original / service branch", `${a.original_branch.branch_name} / ${a.service_branch.branch_name}`],
          ["Accepted plan", `${a.seat_type} · ${a.delivery_mode}${a.planned_start_date ? ` · starts ${date(a.planned_start_date)}` : ""}`],
          ["Payment plan", a.payment_plan?.plan_name ?? "—"],
          [
            "Invoice",
            a.invoice ? (
              <Link to="/invoices/$invoiceId" params={{ invoiceId: String(a.invoice.invoice_id) }} className="text-primary">
                {a.invoice.invoice_number}
              </Link>
            ) : (
              "—"
            ),
          ],
          ["Final fee", money(a.final_fee)],
          ["Verified paid · pending", `${money(a.balance.verified_paid)} · ${money(a.balance.pending_verification)}`],
          ["Outstanding", money(a.balance.outstanding)],
          ["First verified payment", dateTime(a.first_verified_payment_at)],
          ["Counsellor", a.counsellor?.full_name ?? "—"],
          ["Handover · LMS", `${a.handover_status} · ${a.lms_status}`],
          ["Academic completion", a.academic_completed_at ? `${dateTime(a.academic_completed_at)} · support until ${date(a.support_until)}` : "—"],
          ["Access until", date(a.access_until)],
        ]}
      />
    </Section>
  );
}

function Actions({ a }: { a: AdmissionDetail }) {
  const can = useCan();
  const branches = useBranches();
  const courses = useCourses();
  const svc = a.service_branch.branch_id;
  const active = !["Cancelled", "Completed"].includes(a.enrolment_status);

  const [edit, setEdit] = useState({ handover_status: "", lms_status: "", delivery_mode: "", planned_start_date: "" });
  const [transfer, setTransfer] = useState({ to_branch_id: "", reason: "", effective_date: "" });
  const [comp, setComp] = useState({ offer_id: "", course_id: "" });

  const canEdit = can.manager(svc) || can.at(svc, "SALES", "FRONT_OFFICE", "ACCOUNTS", "ACADEMIC_COORDINATOR");
  const canComp = can.sell(a.original_branch.branch_id) && !a.complimentary_of_admission_id;
  const offers = useQuery({ queryKey: ["offers", "active"], queryFn: admissionsApi.activeOffers, enabled: canComp, retry: false });

  const update = useApiMutation((body: Parameters<typeof admissionsApi.update>[1]) => admissionsApi.update(a.admission_id, body), {
    success: "Admission updated",
    invalidate: INVALIDATE,
  });
  const doTransfer = useApiMutation(
    () =>
      admissionsApi.transfer(a.admission_id, {
        to_branch_id: Number(transfer.to_branch_id),
        reason: transfer.reason.trim(),
        effective_date: transfer.effective_date || null,
      }),
    { success: "Service branch transferred — active allocations were moved out", invalidate: INVALIDATE },
  );
  const cancel = useApiMutation((reason: string) => admissionsApi.cancel(a.admission_id, reason), { success: "Admission cancelled", invalidate: INVALIDATE });
  const complete = useApiMutation(() => admissionsApi.complete(a.admission_id), { success: "Completion authorised — support window started", invalidate: INVALIDATE });
  const addComp = useApiMutation(() => admissionsApi.complimentary(a.admission_id, { offer_id: Number(comp.offer_id), course_id: Number(comp.course_id) }), {
    success: (r) => `Complimentary admission ${r.admission_code} created`,
    invalidate: INVALIDATE,
  });

  const offerCourses = offers.data?.find((o) => o.offer_id === Number(comp.offer_id))?.complimentary_courses;
  const compCourseOptions = (offerCourses?.length
    ? offerCourses.map((c) => c.course ?? courses.data?.find((x) => x.course_id === c.course_id)).filter(Boolean)
    : courses.data ?? []
  ).map((c) => ({ value: c!.course_id, label: `${c!.course_title} (${c!.course_code})` }));

  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && (
        <FormDialog
          title="Update admission"
          description="Handover, LMS and delivery details. Fee, plan and admission date are frozen."
          onOpen={() => setEdit({ handover_status: a.handover_status, lms_status: a.lms_status, delivery_mode: a.delivery_mode, planned_start_date: a.planned_start_date ?? "" })}
          onSubmit={() => {
            const body: Record<string, string | null> = {};
            if (edit.handover_status !== a.handover_status) body["handover_status"] = edit.handover_status;
            if (edit.lms_status !== a.lms_status) body["lms_status"] = edit.lms_status;
            if (edit.delivery_mode !== a.delivery_mode) body["delivery_mode"] = edit.delivery_mode;
            if (edit.planned_start_date !== (a.planned_start_date ?? "")) body["planned_start_date"] = edit.planned_start_date || null;
            return update.mutateAsync(body);
          }}
          trigger={
            <Button size="sm" variant="outline">
              <Pencil />
              Update
            </Button>
          }
        >
          <Field label="Handover status" htmlFor="ad-handover">
            <NativeSelect id="ad-handover" value={edit.handover_status} options={HANDOVER_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => setEdit({ ...edit, handover_status: e.target.value })} />
          </Field>
          <Field label="LMS status" htmlFor="ad-lms">
            <NativeSelect id="ad-lms" value={edit.lms_status} options={LMS_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => setEdit({ ...edit, lms_status: e.target.value })} />
          </Field>
          <Field label="Delivery mode" htmlFor="ad-mode">
            <NativeSelect id="ad-mode" value={edit.delivery_mode} options={DELIVERY_MODES.map((s) => ({ value: s, label: s }))} onChange={(e) => setEdit({ ...edit, delivery_mode: e.target.value })} />
          </Field>
          <Field label="Planned start date" htmlFor="ad-start">
            <Input id="ad-start" type="date" value={edit.planned_start_date} onChange={(e) => setEdit({ ...edit, planned_start_date: e.target.value })} />
          </Field>
        </FormDialog>
      )}
      {canComp && active && (
        <FormDialog
          title="Add complimentary course"
          description="From an active Offer Master version; the fee threshold and a verified payment are checked by the server."
          disabled={!comp.offer_id || !comp.course_id}
          onOpen={() => setComp({ offer_id: "", course_id: "" })}
          onSubmit={() => addComp.mutateAsync(undefined)}
          trigger={
            <Button size="sm" variant="outline">
              <Gift />
              Complimentary course
            </Button>
          }
        >
          {offers.data ? (
            <Field label="Active offer" htmlFor="ad-offer" hint={offers.data.length ? undefined : "No active offer — complimentary access needs an active Offer Master version."}>
              <NativeSelect
                id="ad-offer"
                value={comp.offer_id}
                placeholder="Choose offer…"
                options={offers.data.map((o) => ({ value: o.offer_id, label: `${o.offer_code} · ${o.offer_name}` }))}
                onChange={(e) => setComp({ offer_id: e.target.value, course_id: "" })}
              />
            </Field>
          ) : (
            <Field label="Offer ID" htmlFor="ad-offer-id" hint="Offer Master is visible to managers; enter the active offer's ID.">
              <Input id="ad-offer-id" inputMode="numeric" value={comp.offer_id} onChange={(e) => setComp({ ...comp, offer_id: e.target.value })} />
            </Field>
          )}
          <Field label="Complimentary course" htmlFor="ad-comp-course">
            <NativeSelect id="ad-comp-course" value={comp.course_id} placeholder="Choose course…" options={compCourseOptions} onChange={(e) => setComp({ ...comp, course_id: e.target.value })} />
          </Field>
        </FormDialog>
      )}
      {can.manager(svc) && active && (
        <FormDialog
          title="Transfer service branch"
          description="Active batch allocations are closed as Moved; the student is re-allocated at the new branch."
          disabled={!transfer.to_branch_id || !transfer.reason.trim()}
          onOpen={() => setTransfer({ to_branch_id: "", reason: "", effective_date: "" })}
          onSubmit={() => doTransfer.mutateAsync(undefined)}
          trigger={
            <Button size="sm" variant="outline">
              <ArrowRightLeft />
              Transfer
            </Button>
          }
        >
          <Field label="To branch" htmlFor="ad-to-branch">
            <NativeSelect
              id="ad-to-branch"
              value={transfer.to_branch_id}
              placeholder="Choose branch…"
              options={(branches.data ?? []).filter((b) => b.branch_id !== svc).map((b) => ({ value: b.branch_id, label: b.branch_name }))}
              onChange={(e) => setTransfer({ ...transfer, to_branch_id: e.target.value })}
            />
          </Field>
          <Field label="Effective date (optional)" htmlFor="ad-eff">
            <Input id="ad-eff" type="date" value={transfer.effective_date} onChange={(e) => setTransfer({ ...transfer, effective_date: e.target.value })} />
          </Field>
          <Field label="Transfer reason" htmlFor="ad-transfer-reason">
            <Textarea id="ad-transfer-reason" value={transfer.reason} onChange={(e) => setTransfer({ ...transfer, reason: e.target.value })} />
          </Field>
        </FormDialog>
      )}
      {can.coordinator(svc) && a.enrolment_status === "In Progress" && (
        <ConfirmAction
          title="Authorise academic completion?"
          description="Closes the active allocation as Completed, marks the learner as alumni and starts the support window."
          action="Authorise completion"
          onConfirm={() => complete.mutateAsync(undefined)}
          trigger={
            <Button size="sm" variant="outline">
              <BadgeCheck />
              Complete
            </Button>
          }
        />
      )}
      {can.manager(svc) && active && (
        <ConfirmAction
          title={`Cancel ${a.admission_code}?`}
          description="Operational cancellation: active allocations are withdrawn. Refunds are a separate case."
          action="Cancel admission"
          destructive
          reason
          reasonLabel="Cancellation reason"
          onConfirm={(reason) => cancel.mutateAsync(reason)}
          trigger={
            <Button size="sm" variant="ghost" className="text-destructive">
              <Ban />
              Cancel admission
            </Button>
          }
        />
      )}
    </div>
  );
}

function Allocations({ a }: { a: AdmissionDetail }) {
  const can = useCan();
  const svc = a.service_branch.branch_id;
  const canAllocate = can.academic(svc) && !["Cancelled", "Completed", "Paused"].includes(a.enrolment_status);
  const [batchId, setBatchId] = useState("");
  const [joining, setJoining] = useState(todayIST());
  const [close, setClose] = useState<{ status: "Moved" | "Withdrawn" | "Completed"; reason: string }>({ status: "Moved", reason: "" });

  const batches = useQuery({
    queryKey: batchKeys.list({ branch_id: svc, per_page: 100 }),
    queryFn: () => batchesApi.list({ branch_id: svc, per_page: 100 }),
    enabled: canAllocate,
  });
  const candidates = (batches.data?.data ?? []).filter((b) => !["Completed", "Cancelled"].includes(b.status));
  const check = useQuery({
    queryKey: batchKeys.check(Number(batchId), a.admission_id),
    queryFn: () => batchesApi.allocationCheck(Number(batchId), a.admission_id),
    enabled: !!batchId,
  });
  const allocate = useApiMutation(() => admissionsApi.allocate(a.admission_id, Number(batchId)), {
    success: (r) => `Allocated to ${r.batch_code}. First regular attendance still pending.`,
    invalidate: INVALIDATE,
    onSuccess: () => setBatchId(""),
  });
  const setJoin = useApiMutation((id: number) => batchesApi.setJoiningDate(id, joining), { success: "Joining date recorded", invalidate: INVALIDATE });
  const doClose = useApiMutation((id: number) => batchesApi.closeAllocation(id, { status: close.status, reason: close.reason || null }), {
    success: "Allocation closed",
    invalidate: INVALIDATE,
  });

  const joinAction = (x: Allocation) =>
    x.status === "Active" && !x.joining_date && (can.coordinator(svc) || can.at(svc, "TRAINER")) ? (
      <FormDialog
        title={`Record joining · ${x.batch_code}`}
        description="First confirmed regular class (demos excluded). Moves enrolment to In Progress."
        submitLabel="Record joining"
        onOpen={() => setJoining(todayIST())}
        onSubmit={() => setJoin.mutateAsync(x.allocation_id)}
        trigger={
          <Button size="sm" variant="outline">
            <CalendarCheck />
            Joining date
          </Button>
        }
      >
        <Field label="Joining date" htmlFor={`join-${x.allocation_id}`}>
          <Input id={`join-${x.allocation_id}`} type="date" value={joining} max={todayIST()} onChange={(e) => setJoining(e.target.value)} />
        </Field>
      </FormDialog>
    ) : null;

  const closeAction = (x: Allocation) =>
    x.status === "Active" && can.coordinator(svc) ? (
      <FormDialog
        title={`Close allocation · ${x.batch_code}`}
        submitLabel="Close allocation"
        onOpen={() => setClose({ status: "Moved", reason: "" })}
        onSubmit={() => doClose.mutateAsync(x.allocation_id)}
        trigger={
          <Button size="sm" variant="ghost">
            Close
          </Button>
        }
      >
        <Field label="Outcome" htmlFor={`close-${x.allocation_id}`}>
          <NativeSelect
            id={`close-${x.allocation_id}`}
            value={close.status}
            options={["Moved", "Withdrawn", "Completed"].map((s) => ({ value: s, label: s }))}
            onChange={(e) => setClose({ ...close, status: e.target.value as typeof close.status })}
          />
        </Field>
        <Field label="Reason (optional)" htmlFor={`close-reason-${x.allocation_id}`}>
          <Textarea id={`close-reason-${x.allocation_id}`} value={close.reason} onChange={(e) => setClose({ ...close, reason: e.target.value })} />
        </Field>
      </FormDialog>
    ) : null;

  return (
    <Section title="Batch allocation" subtitle="Accepted plan, enrolment, batch allocation and first regular attendance are separate records">
      <DataTable
        rows={a.allocations}
        rowKey={(x) => x.allocation_id}
        empty={<p className="text-sm text-muted-foreground">Awaiting batch allocation.</p>}
        columns={[
          {
            header: "Batch",
            cell: (x) => (
              <Link to="/batches/$batchId" params={{ batchId: String(x.batch_id) }} className="font-medium text-primary">
                {x.batch_code}
              </Link>
            ),
          },
          { header: "Status", cell: (x) => <Status>{x.status}</Status> },
          { header: "Allocated", cell: (x) => dateTime(x.allocated_at) },
          { header: "Joining date", cell: (x) => (x.joining_date ? date(x.joining_date) : "Not yet — first regular class") },
          { header: "Ended", cell: (x) => (x.ended_at ? `${dateTime(x.ended_at)}${x.end_reason ? ` · ${x.end_reason}` : ""}` : "—") },
          {
            header: "",
            cell: (x) => (
              <div className="flex gap-1">
                {joinAction(x)}
                {closeAction(x)}
              </div>
            ),
          },
        ]}
      />
      {canAllocate && (
        <div className="mt-4 space-y-2 rounded-md border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Allocate to batch" htmlFor={`alloc-${a.admission_id}`}>
              <NativeSelect
                id={`alloc-${a.admission_id}`}
                value={batchId}
                placeholder={batches.isLoading ? "Loading batches…" : "Choose batch…"}
                options={candidates.map((b) => ({
                  value: b.batch_id,
                  label: `${b.batch_code} · ${b.batch_name} · ${b.course.course_title} · ${b.allocated}/${b.capacity}`,
                }))}
                onChange={(e) => setBatchId(e.target.value)}
              />
            </Field>
            <Button disabled={!batchId || allocate.isPending || check.data?.ok === false} onClick={() => allocate.mutate(undefined)}>
              <Users />
              Allocate
            </Button>
          </div>
          {check.data && <CheckResult ok={check.data.ok} reason={check.data.reason} owner={check.data.recovery_owner} />}
        </div>
      )}
    </Section>
  );
}

function Curriculum({ a }: { a: AdmissionDetail }) {
  const can = useCan();
  const allowed = can.coordinator(a.service_branch.branch_id);
  const versions = useCurriculumVersions(a.course.course_id, allowed || can.at(null, "TRAINER", "BRANCH_MANAGER"));
  const [versionId, setVersionId] = useState("");
  const map = useApiMutation(() => admissionsApi.mapCurriculum(a.admission_id, Number(versionId)), {
    success: "Curriculum mapped",
    invalidate: INVALIDATE,
    onSuccess: () => setVersionId(""),
  });
  const published = (versions.data ?? []).filter((v) => v.status === "Published" && !a.curricula.some((m) => m.curriculum_version_id === v.curriculum_version_id));
  return (
    <Section title="Curriculum mapping" subtitle={a.curriculum_status === "Mapped" ? "Mapped" : `Curriculum Mapping Pending · recovery: Academic Coordinator (${a.service_branch.branch_code})`}>
      <DataTable
        rows={a.curricula}
        rowKey={(c) => c.curriculum_version_id}
        empty={<p className="text-sm text-muted-foreground">No curriculum version mapped yet.</p>}
        columns={[
          { header: "Course", cell: (c) => c.course.course_title },
          { header: "Version", cell: (c) => c.version_label },
          { header: "Status", cell: (c) => <Status>{c.status}</Status> },
          { header: "Mapped", cell: (c) => dateTime(c.mapped_at) },
        ]}
      />
      {allowed && !["Cancelled", "Completed"].includes(a.enrolment_status) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Published curriculum version" htmlFor={`cv-${a.admission_id}`}>
            <NativeSelect
              id={`cv-${a.admission_id}`}
              value={versionId}
              placeholder={published.length ? "Choose version…" : "No other published version"}
              options={published.map((v) => ({ value: v.curriculum_version_id, label: `${v.course.course_title} · ${v.version_label}` }))}
              onChange={(e) => setVersionId(e.target.value)}
            />
          </Field>
          <Button variant="outline" disabled={!versionId || map.isPending} onClick={() => map.mutate(undefined)}>
            Map curriculum
          </Button>
        </div>
      )}
    </Section>
  );
}

function FeeChanges({ a }: { a: AdmissionDetail }) {
  const can = useCan();
  const svc = a.service_branch.branch_id;
  const [form, setForm] = useState({ new_fee: "", reason: "" });
  const canRequest = (can.manager(svc) || can.at(a.original_branch.branch_id, "SALES", "FRONT_OFFICE")) && !a.complimentary_of_admission_id;
  const open = a.fee_changes.some((c) => c.status === "Pending" || c.status === "Approved");
  const request = useApiMutation(() => admissionsApi.requestFeeChange(a.admission_id, { new_fee: form.new_fee.trim(), reason: form.reason.trim() }), {
    success: "Fee change requested — sent to Founder / CEO or Super Admin for approval",
    invalidate: INVALIDATE,
  });
  const approve = useApiMutation(admissionsApi.approveFeeChange, { success: "Fee change approved — Accounts will apply it", invalidate: INVALIDATE });
  const reject = useApiMutation((v: { id: number; reason: string }) => admissionsApi.rejectFeeChange(v.id, v.reason), { success: "Fee change rejected", invalidate: INVALIDATE });
  const apply = useApiMutation(admissionsApi.applyFeeChange, { success: "Fee change applied — invoice and instalments revised", invalidate: INVALIDATE });

  return (
    <Section
      title="Fee changes"
      subtitle="Post-admission changes: counsellor or manager requests · Founder / CEO or Super Admin approves · Accounts applies"
      action={
        canRequest && !open && !["Cancelled"].includes(a.enrolment_status) ? (
          <FormDialog
            title="Request fee change"
            description={`Current final fee ${money(a.final_fee)}.`}
            disabled={!form.new_fee.trim() || !form.reason.trim()}
            onOpen={() => setForm({ new_fee: "", reason: "" })}
            onSubmit={() => request.mutateAsync(undefined)}
            trigger={
              <Button size="sm" variant="outline">
                <IndianRupee />
                Request fee change
              </Button>
            }
          >
            <Field label="New final fee (₹)" htmlFor="fc-fee">
              <Input id="fc-fee" inputMode="decimal" value={form.new_fee} onChange={(e) => setForm({ ...form, new_fee: e.target.value })} />
            </Field>
            <Field label="Reason for fee change" htmlFor="fc-reason">
              <Textarea id="fc-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
          </FormDialog>
        ) : undefined
      }
    >
      <DataTable
        rows={a.fee_changes}
        rowKey={(c) => c.fee_change_id}
        empty={<p className="text-sm text-muted-foreground">No fee changes.</p>}
        columns={[
          { header: "Requested", cell: (c) => dateTime(c.requested_at) },
          { header: "Old → new", cell: (c) => `${money(c.old_fee)} → ${money(c.new_fee)}` },
          { header: "Reason", cell: (c) => <span className="block max-w-64 truncate" title={c.reason}>{c.reason}</span> },
          { header: "Status", cell: (c) => <Status>{c.status}</Status> },
          { header: "Decision", cell: (c) => (c.rejection_reason ? `Rejected: ${c.rejection_reason}` : c.applied_at ? `Applied ${dateTime(c.applied_at)}` : c.approved_at ? `Approved ${dateTime(c.approved_at)}` : "—") },
          {
            header: "",
            cell: (c) => (
              <div className="flex gap-1">
                {c.status === "Pending" && can.isAdmin && c.requested_by !== can.userId && (
                  <>
                    <ConfirmAction
                      title="Approve fee change?"
                      description={`${money(c.old_fee)} → ${money(c.new_fee)}. Accounts then applies it to the invoice and instalments.`}
                      action="Approve"
                      onConfirm={() => approve.mutateAsync(c.fee_change_id)}
                      trigger={<Button size="sm">Approve</Button>}
                    />
                    <ConfirmAction
                      title="Reject fee change?"
                      action="Reject"
                      destructive
                      reason
                      reasonLabel="Rejection reason"
                      onConfirm={(reason) => reject.mutateAsync({ id: c.fee_change_id, reason })}
                      trigger={
                        <Button size="sm" variant="outline">
                          Reject
                        </Button>
                      }
                    />
                  </>
                )}
                {c.status === "Approved" && can.at(svc, "ACCOUNTS") && (
                  <ConfirmAction
                    title="Apply approved fee change?"
                    description="Revises the admission fee, invoice amount and instalments."
                    action="Apply"
                    onConfirm={() => apply.mutateAsync(c.fee_change_id)}
                    trigger={<Button size="sm">Apply</Button>}
                  />
                )}
              </div>
            ),
          },
        ]}
      />
    </Section>
  );
}
