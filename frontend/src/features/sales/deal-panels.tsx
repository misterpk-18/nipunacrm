/** Deal panels on Lead 360 (a converted course): delivery plan (db 020) and commercial / invoice (db 021). */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, Lock, RotateCcw } from "lucide-react";
import { CAPACITY_REVIEWS, dealKeys, dealsApi, type DeliveryPlanBody } from "@/api/deals";
import type { Lead } from "@/api/leads";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, Field, NativeSelect } from "@/components/crm/forms";
import { Facts, Section, Status } from "@/components/crm/ui";
import { CreateInvoiceDialog } from "@/features/finance/create-invoice";
import { FormDialog } from "@/features/sales/shared";
import { date, dateTime, money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

const DELIVERY_MODES = ["Classroom", "Online", "Hybrid"];
const SEAT_TYPES = ["Confirmed Seat", "Future Plan"];

const invalidate = (leadId: number) => [dealKeys.deliveryPlan(leadId), dealKeys.invoiceOptions(leadId), ["pipeline"], ["leads", "activities", leadId]];

/** Confirm Delivery Plan: service branch, mode, seat type, planned start, capacity review, student acceptance. */
export function DeliveryPlanPanel({ lead }: { lead: Lead }) {
  const q = useQuery({ queryKey: dealKeys.deliveryPlan(lead.lead_id), queryFn: () => dealsApi.deliveryPlan(lead.lead_id) });
  const plan = q.data?.plan ?? null;
  const [form, setForm] = useState<DeliveryPlanBody | null>(null);
  const [reopen, setReopen] = useState(false);
  const values: DeliveryPlanBody = form ?? {
    service_branch_id: plan?.service_branch.branch_id ?? lead.branch.branch_id,
    delivery_mode: plan?.delivery_mode ?? "Classroom",
    seat_type: plan?.seat_type ?? "Confirmed Seat",
    planned_start_date: plan?.planned_start_date ?? "",
    capacity_review: plan?.capacity_review ?? "Waiting",
    student_accepted: false,
  };
  const set = (patch: DeliveryPlanBody) => setForm({ ...values, ...patch });
  const body = () => ({ ...values, planned_start_date: values.planned_start_date || null });
  const save = useApiMutation(() => dealsApi.saveDeliveryPlan(lead.lead_id, body()), {
    success: "Delivery plan saved",
    invalidate: invalidate(lead.lead_id),
    onSuccess: () => setForm(null),
  });
  const accept = useApiMutation(() => dealsApi.acceptDeliveryPlan(lead.lead_id, { ...body(), student_accepted: true }), {
    success: (r) => `${r.plan?.plan_code} saved and accepted. Batch allocation remains separate.`,
    invalidate: invalidate(lead.lead_id),
    onSuccess: () => setForm(null),
  });
  if (!q.data) return null;
  const state = q.data;
  const accepted = plan?.status === "Accepted";

  return (
    <Section
      title="Confirm delivery plan"
      subtitle="Academic coordinator / branch manager review · acceptance is separate from batch allocation"
      action={plan ? <Status kind={accepted ? "good" : "warn"}>{`${plan.plan_code} · ${plan.status}`}</Status> : undefined}
    >
      {accepted ? (
        <>
          <Facts
            items={[
              ["Service branch", plan.service_branch.branch_name],
              ["Delivery mode", plan.delivery_mode],
              ["Seat type", plan.seat_type],
              ["Planned start", date(plan.planned_start_date)],
              ["Capacity review", plan.capacity_review === "Checked" ? "Capacity checked" : "Waiting for capacity"],
              ["Accepted", `${plan.accepted_by?.full_name ?? "—"} · ${dateTime(plan.accepted_at)}`],
            ]}
          />
          {state.invoice ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" />
              Fixed: invoiced on {state.invoice.invoice_number}
            </p>
          ) : (
            state.can_edit && (
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setReopen(true)}>
                <RotateCcw />
                Reopen plan
              </Button>
            )
          )}
        </>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Service branch">
              <BranchSelect
                aria-label="Service branch"
                value={values.service_branch_id}
                disabled={!state.can_edit}
                onChange={(e) => set({ service_branch_id: Number(e.target.value) })}
              />
            </Field>
            <Field label="Delivery mode">
              <NativeSelect
                aria-label="Delivery mode"
                options={DELIVERY_MODES.map((m) => ({ value: m, label: m }))}
                value={values.delivery_mode}
                disabled={!state.can_edit}
                onChange={(e) => set({ delivery_mode: e.target.value })}
              />
            </Field>
            <Field label="Seat type">
              <NativeSelect
                aria-label="Seat type"
                options={SEAT_TYPES.map((m) => ({ value: m, label: m }))}
                value={values.seat_type}
                disabled={!state.can_edit}
                onChange={(e) => set({ seat_type: e.target.value })}
              />
            </Field>
            <Field label="Planned start date">
              <Input
                type="date"
                aria-label="Planned start date"
                min={todayIST()}
                value={values.planned_start_date ?? ""}
                disabled={!state.can_edit}
                onChange={(e) => set({ planned_start_date: e.target.value })}
              />
            </Field>
            <Field label="Capacity review">
              <NativeSelect
                aria-label="Capacity review"
                options={CAPACITY_REVIEWS.map((c) => ({ value: c, label: c === "Checked" ? "Capacity checked" : "Waiting for capacity" }))}
                value={values.capacity_review}
                disabled={!state.can_edit}
                onChange={(e) => set({ capacity_review: e.target.value })}
              />
            </Field>
          </div>
          <label className="check-tile">
            <Checkbox
              aria-label="Student acceptance captured"
              checked={values.student_accepted === true}
              disabled={!state.can_edit}
              onCheckedChange={(v) => set({ student_accepted: v === true })}
            />
            <span className="text-sm">Student acceptance captured for this confirmed plan</span>
          </label>
          {state.can_edit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!values.student_accepted || accept.isPending} onClick={() => accept.mutate(undefined)}>
                Confirm delivery plan
              </Button>
              <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(undefined)}>
                Save draft
              </Button>
            </div>
          )}
        </div>
      )}
      {reopen && <ReopenDialog leadId={lead.lead_id} onClose={() => setReopen(false)} />}
    </Section>
  );
}

function ReopenDialog({ leadId, onClose }: { leadId: number; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const reopen = useApiMutation(() => dealsApi.reopenDeliveryPlan(leadId, reason), {
    success: "Delivery plan reopened",
    invalidate: invalidate(leadId),
    onSuccess: onClose,
  });
  return (
    <FormDialog title="Reopen delivery plan" description="The student's acceptance must be captured again." onClose={onClose} onSubmit={() => reopen.mutate(undefined)} busy={reopen.isPending} disabled={!reason.trim()} submitLabel="Reopen">
      <Field label="Reason">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
      </Field>
    </FormDialog>
  );
}

/** Commercial and invoice: approved charge, money paid, and Create invoice / View invoice. */
export function CommercialPanel({ lead }: { lead: Lead }) {
  const q = useQuery({ queryKey: dealKeys.invoiceOptions(lead.lead_id), queryFn: () => dealsApi.invoiceOptions(lead.lead_id) });
  const [creating, setCreating] = useState(false);
  if (!q.data) return null;
  const mine = q.data.courses.find((c) => c.lead.lead_id === lead.lead_id);
  if (!mine) return null;
  return (
    <Section title="Commercial and invoice" subtitle="Approved catalog / Offer Master price only · no quotation or proforma">
      <Facts
        columns={1}
        items={[
          ["Standard fee", money(mine.standard_fee)],
          ["Agreed charge", mine.fee_version?.status === "Approved" ? money(mine.fee_version.final_payable) : `${money(mine.amount)} (not approved yet)`],
          ["Delivery plan", mine.delivery_plan ? `${mine.delivery_plan.plan_code} · ${mine.delivery_plan.status}` : "Not started"],
          [
            "Invoice",
            mine.invoice ? (
              <Link key="inv" to="/invoices/$invoiceId" params={{ invoiceId: String(mine.invoice.invoice_id) }} className="font-medium text-primary">
                {mine.invoice.invoice_number}
              </Link>
            ) : (
              "Not invoiced"
            ),
          ],
        ]}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {mine.invoice ? (
          <Button size="sm" asChild>
            <Link to="/invoices/$invoiceId" params={{ invoiceId: String(mine.invoice.invoice_id) }}>
              <FileText />
              View invoice
            </Link>
          </Button>
        ) : (
          q.data.can_issue && (
            <Button size="sm" disabled={!mine.eligible} title={mine.reasons.join(" · ")} onClick={() => setCreating(true)}>
              <FileText />
              Create invoice
            </Button>
          )
        )}
        {!mine.invoice && !mine.eligible && <span className="self-center text-xs text-muted-foreground">{mine.reasons.join(" · ")}</span>}
      </div>
      {creating && <CreateInvoiceDialog leadId={lead.lead_id} onClose={() => setCreating(false)} />}
    </Section>
  );
}
