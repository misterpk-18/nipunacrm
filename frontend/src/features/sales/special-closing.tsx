import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Check, Undo2, X } from "lucide-react";
import { SCR_STATUSES, feeKeys, feesApi, type ScrFilters, type SpecialClosingRequest } from "@/api/fees";
import { leadKeys } from "@/api/leads";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, Facts, PageHead, Pagination, Section, Status, Warning } from "@/components/crm/ui";
import { dateTime, isPast, money, relative } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FormDialog } from "./shared";

export type ScrSearch = { queue?: "can_approve" | "higher_approval" | "all"; status?: string; page?: number; id?: number };

const INVALIDATE = [feeKeys.scr, feeKeys.all, leadKeys.all, ["tasks"], ["notifications"], ["dashboard"]];

const QUEUE_TABS: { key: NonNullable<ScrSearch["queue"]>; label: string }[] = [
  { key: "can_approve", label: "I can approve" },
  { key: "higher_approval", label: "Needs higher approval" },
  { key: "all", label: "All requests" },
];

export function SpecialClosingQueue({ search, onSearch }: { search: ScrSearch; onSearch: (next: ScrSearch) => void }) {
  const branchId = useBranchFilter();
  const { isAdmin } = useAuth();
  const queue = search.queue ?? "can_approve";
  const filters: ScrFilters = { queue, status: queue === "all" ? search.status : undefined, branch_id: branchId, page: search.page, per_page: 25 };
  const list = useQuery({ queryKey: feeKeys.scrList(filters), queryFn: () => feesApi.listScr(filters), placeholderData: (prev) => prev });
  const rows = list.data?.data;
  const selected = rows?.find((r) => r.scr_id === search.id) ?? (rows?.length === 1 ? rows[0] : undefined);
  const limits = useQuery({ queryKey: feeKeys.concessionLimits, queryFn: feesApi.concessionLimits, enabled: isAdmin });

  return (
    <>
      <PageHead title="Special Closing Requests" description="Extra concession approvals · 5 staffed-minute decision target · a timeout never approves." />
      <div className="mb-4 overflow-x-auto" role="tablist" aria-label="Approval queues">
        <div className="inline-flex min-w-max gap-1 rounded-lg bg-muted p-1">
          {QUEUE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === queue}
              onClick={() => onSearch({ queue: t.key })}
              className={`rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap ${t.key === queue ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section
          title="Requests"
          className="min-w-0 self-start lg:col-span-2"
          action={
            queue === "all" ? (
              <div className="w-44">
                <NativeSelect
                  aria-label="Status"
                  value={search.status ?? ""}
                  placeholder="Any status"
                  options={SCR_STATUSES.map((s) => ({ value: s, label: s }))}
                  onChange={(e) => onSearch({ ...search, status: e.target.value || undefined, page: undefined })}
                />
              </div>
            ) : undefined
          }
        >
          <DataTable
            rows={rows}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            rowKey={(r) => r.scr_id}
            onRowClick={(r) => onSearch({ ...search, id: r.scr_id })}
            empty={<Empty title="No requests here">{queue === "can_approve" ? "Nothing is waiting for your decision." : "Try another queue."}</Empty>}
            columns={[
              {
                header: "Request",
                cell: (r) => (
                  <span className={r.scr_id === selected?.scr_id ? "font-semibold text-primary" : "font-medium"}>
                    {r.scr_code}
                    <small className="block font-normal text-muted-foreground">{r.fee_discussion.discussion_code} · v{r.version_no}</small>
                  </span>
                ),
              },
              { header: "Student", cell: (r) => r.person.full_name },
              { header: "Branch", cell: (r) => r.branch.branch_name },
              { header: "Standard fee", cell: (r) => money(r.standard_fee) },
              { header: "Requested extra", cell: (r) => <b>{money(r.requested_extra)}</b> },
              { header: "Final payable", cell: (r) => money(r.final_payable) },
              { header: "Floor", cell: (r) => (r.below_floor ? <Status kind="danger">{`Below · ${money(r.minimum_floor)}`}</Status> : money(r.minimum_floor)) },
              { header: "Requested by", cell: (r) => r.requested_by?.full_name ?? "—" },
              {
                header: "Decision due",
                cell: (r) =>
                  r.status === "Pending" && r.decision_due_at ? (
                    <span className={isPast(r.decision_due_at) ? "font-medium text-destructive" : undefined}>{relative(r.decision_due_at)}</span>
                  ) : (
                    "—"
                  ),
              },
              { header: "Status", cell: (r) => <Status>{r.status}</Status> },
            ]}
          />
          <Pagination meta={list.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
        </Section>
        <div className="min-w-0 space-y-4">
          {selected ? (
            <ScrDecision scr={selected} canDecide={queue === "can_approve"} />
          ) : (
            <Section title="Decision">
              <p className="text-sm text-muted-foreground">Select a request to review its commercial terms and decide.</p>
            </Section>
          )}
          <Warning>
            Floor and delegation checks are enforced by the server. Below-floor exceptions need Founder / CEO or Super Admin plus an independent approval. Self-approval is
            blocked.
          </Warning>
          {isAdmin && limits.data && (
            <Section title="Concession limits">
              <ul className="space-y-1 text-sm">
                {limits.data.map((l) => (
                  <li key={l.role_code} className="flex justify-between gap-2">
                    <span>{l.role_name}</span>
                    <span className="text-muted-foreground">
                      {l.unlimited ? "Unlimited" : [l.max_percent && `${Number(l.max_percent)}%`, l.max_amount && money(l.max_amount)].filter(Boolean).join(" or ") + " (lower)"}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function ScrDecision({ scr, canDecide }: { scr: SpecialClosingRequest; canDecide: boolean }) {
  const { profile, hasRole } = useAuth();
  const [dialog, setDialog] = useState<null | "approve" | "counter">(null);
  const reject = useApiMutation((reason: string) => feesApi.rejectScr(scr.scr_id, reason), { success: (s) => `${s.scr_code} rejected`, invalidate: INVALIDATE });
  const own = scr.requested_by?.user_id === profile?.user.user_id;
  const pending = scr.status === "Pending";
  const canAct = pending && !own && hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER");

  return (
    <Section title={`${scr.scr_code} · ${scr.person.full_name}`} subtitle={`${scr.lead.lead_code} · ${scr.branch.branch_name}`}>
      <Facts
        columns={2}
        items={[
          ["Standard fee", money(scr.standard_fee)],
          ["Requested extra", money(scr.requested_extra)],
          ["Final payable", money(scr.final_payable)],
          ["Floor (70%)", `${money(scr.minimum_floor)}${scr.below_floor ? " · below" : ""}`],
          ["Requested by", scr.requested_by?.full_name ?? "—"],
          ["Requested", dateTime(scr.requested_at)],
          ["Decision due", dateTime(scr.decision_due_at)],
          ["Status", <Status key="s">{scr.status}</Status>],
          ...(scr.counter_extra ? ([["Counteroffer", money(scr.counter_extra)]] as [string, string][]) : []),
          ...(scr.decided_by ? ([["Decided by", `${scr.decided_by.full_name} · ${dateTime(scr.decided_at)}`]] as [string, string][]) : []),
          ...(scr.decision_reason ? ([["Decision reason", scr.decision_reason]] as [string, string][]) : []),
        ]}
      />
      <div className="mt-3 rounded-md bg-muted/50 p-3 text-sm">
        <div className="text-[11px] font-semibold uppercase text-muted-foreground">Reason for the request</div>
        {scr.request_reason}
      </div>
      <div className="mt-3">
        <Link to="/fee-quote" search={{ leadId: scr.lead.lead_id, discussionId: scr.fee_discussion.fee_discussion_id }} className="text-sm text-primary">
          Open fee discussion {scr.fee_discussion.discussion_code}
        </Link>
      </div>
      {own && pending && <p className="mt-3 text-sm text-muted-foreground">You raised this request, so someone else must decide it.</p>}
      {canAct && (
        <div className="mt-4 grid gap-2">
          {!canDecide && <p className="text-xs text-muted-foreground">This request may be beyond your concession limit — the server checks it when you decide.</p>}
          <Button className="w-full" onClick={() => setDialog("approve")}>
            <Check />
            Approve
          </Button>
          <Button className="w-full" variant="outline" onClick={() => setDialog("counter")}>
            <Undo2 />
            Counteroffer
          </Button>
          <ConfirmAction
            trigger={
              <Button className="w-full" variant="destructive">
                <X />
                Reject
              </Button>
            }
            title={`Reject ${scr.scr_code}?`}
            description="The version becomes Rejected. A reason is required."
            action="Reject"
            destructive
            reason
            onConfirm={(reason) => reject.mutateAsync(reason)}
          />
        </div>
      )}
      {dialog === "approve" && <ApproveDialog scr={scr} onClose={() => setDialog(null)} />}
      {dialog === "counter" && <CounterDialog scr={scr} onClose={() => setDialog(null)} />}
    </Section>
  );
}

function ApproveDialog({ scr, onClose }: { scr: SpecialClosingRequest; onClose: () => void }) {
  const form = useForm({ defaultValues: { decision_reason: "", independent_approved_by: "" } });
  const go = useApiMutation(
    (v: { decision_reason: string; independent_approved_by: string }) =>
      feesApi.approveScr(scr.scr_id, {
        decision_reason: v.decision_reason || null,
        independent_approved_by: v.independent_approved_by ? Number(v.independent_approved_by) : null,
      }),
    { success: (s) => `${s.scr_code} approved · version approved`, invalidate: INVALIDATE, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog
      title={`Approve ${scr.scr_code}?`}
      description={`Applies ${money(scr.requested_extra)} extra concession: final payable ${money(scr.final_payable)}. Your identity and reason go to the audit trail; you may be asked for your password.`}
      onClose={onClose}
      busy={go.isPending}
      submitLabel="Approve"
      onSubmit={form.handleSubmit((v) => go.mutate(v))}
    >
      <Field label="Decision reason (optional)" htmlFor="ap-reason" error={form.formState.errors.decision_reason?.message}>
        <Textarea id="ap-reason" {...form.register("decision_reason")} />
      </Field>
      {scr.below_floor && (
        <Field label="Independent approver" htmlFor="ap-indep" hint="Required below the floor: a second Founder / CEO or Super Admin" error={form.formState.errors.independent_approved_by?.message}>
          <StaffSelect id="ap-indep" branchId={scr.branch.branch_id} roles={["FOUNDER_CEO", "SUPER_ADMIN"]} placeholder="Choose…" {...form.register("independent_approved_by")} />
        </Field>
      )}
    </FormDialog>
  );
}

function CounterDialog({ scr, onClose }: { scr: SpecialClosingRequest; onClose: () => void }) {
  const form = useForm({ defaultValues: { counter_extra: "", decision_reason: "" } });
  const go = useApiMutation(
    (v: { counter_extra: string; decision_reason: string }) => feesApi.counterofferScr(scr.scr_id, { counter_extra: v.counter_extra, decision_reason: v.decision_reason || null }),
    { success: (s) => `${s.scr_code} counteroffered`, invalidate: INVALIDATE, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog
      title={`Counteroffer ${scr.scr_code}`}
      description={`Requested ${money(scr.requested_extra)}. Offer a lower extra concession; the counsellor then saves a new version at that amount.`}
      onClose={onClose}
      busy={go.isPending}
      submitLabel="Send counteroffer"
      onSubmit={form.handleSubmit((v) => go.mutate(v))}
    >
      <Field label="Counter extra (₹)" htmlFor="co-extra" error={form.formState.errors.counter_extra?.message}>
        <Input id="co-extra" type="number" min={0} {...form.register("counter_extra", { required: "Required" })} />
      </Field>
      <Field label="Reason (optional)" htmlFor="co-reason">
        <Textarea id="co-reason" {...form.register("decision_reason")} />
      </Field>
    </FormDialog>
  );
}
