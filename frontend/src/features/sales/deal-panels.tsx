/** Deal panels on Lead 360 (a converted course): delivery plan (db 020) and commercial / invoice (db 021). */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, Lock, MessageCircle, RotateCcw, Send } from "lucide-react";
import { CAPACITY_REVIEWS, dealKeys, dealsApi, type AcceptanceMethod, type DeliveryPlanBody } from "@/api/deals";
import type { Lead } from "@/api/leads";
import type { OfferableBatch } from "@/api/playbook";
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
import { cn } from "@/lib/utils";

const DELIVERY_MODES = ["Classroom", "Online", "Hybrid"];
const SEAT_TYPES = ["Confirmed Seat", "Future Plan"];
const ACCEPT_METHODS: { value: "in_person" | "call"; label: string }[] = [
  { value: "in_person", label: "In person" },
  { value: "call", label: "On a call" },
];
const METHOD_LABEL: Record<AcceptanceMethod, string> = { in_person: "In person", call: "On a call", whatsapp: "Learner replied YES on WhatsApp" };

const invalidate = (leadId: number) => [dealKeys.deliveryPlan(leadId), dealKeys.invoiceOptions(leadId), ["pipeline"], ["leads"], ["leads", "activities", leadId]];

type PlanForm = DeliveryPlanBody & { acceptance_method: "in_person" | "call" };

/** Confirm Delivery Plan: service branch, mode, seat type, planned start (with the course's upcoming batches as hints),
 *  capacity review, and the learner's acceptance: a YES reply on WhatsApp, or ticked by staff (in person / on a call). */
export function DeliveryPlanPanel({ lead }: { lead: Lead }) {
  const q = useQuery({
    queryKey: dealKeys.deliveryPlan(lead.lead_id),
    queryFn: () => dealsApi.deliveryPlan(lead.lead_id),
    refetchInterval: (query) => (query.state.data?.confirmation?.awaiting_reply ? 15000 : false), // the learner's YES lands here
  });
  const plan = q.data?.plan ?? null;
  const [form, setForm] = useState<PlanForm | null>(null);
  const [reopen, setReopen] = useState(false);
  const values: PlanForm = form ?? {
    service_branch_id: plan?.service_branch.branch_id ?? lead.branch.branch_id,
    delivery_mode: plan?.delivery_mode ?? "Classroom",
    seat_type: plan?.seat_type ?? "Confirmed Seat",
    planned_start_date: plan?.planned_start_date ?? "",
    capacity_review: plan?.capacity_review ?? "Waiting",
    preferred_lms_batch_code: plan?.preferred_lms_batch_code ?? null,
    preferred_lms_batch_label: plan?.preferred_lms_batch_label ?? null,
    student_accepted: false,
    acceptance_method: "in_person",
  };
  const set = (patch: Partial<PlanForm>) => setForm({ ...values, ...patch });
  const body = (): DeliveryPlanBody => {
    const { student_accepted, acceptance_method, ...fields } = values;
    return { ...fields, planned_start_date: values.planned_start_date || null };
  };
  const hints = useQuery({
    queryKey: dealKeys.planBatches(lead.lead_id, values.service_branch_id),
    queryFn: () => dealsApi.deliveryPlanBatches(lead.lead_id, values.service_branch_id),
    enabled: !!lead.course && !!q.data?.can_edit && plan?.status !== "Accepted",
  });
  const save = useApiMutation(() => dealsApi.saveDeliveryPlan(lead.lead_id, body()), {
    success: "Delivery plan saved",
    invalidate: invalidate(lead.lead_id),
    onSuccess: () => setForm(null),
  });
  const accept = useApiMutation(
    () => dealsApi.acceptDeliveryPlan(lead.lead_id, { ...body(), student_accepted: true, acceptance_method: values.acceptance_method }),
    {
      success: (r) => `${r.plan?.plan_code} saved and accepted. Batch allocation remains separate.`,
      invalidate: invalidate(lead.lead_id),
      onSuccess: () => setForm(null),
    },
  );
  const send = useApiMutation(
    async () => {
      await dealsApi.saveDeliveryPlan(lead.lead_id, body()); // the learner is asked about exactly what is on screen
      return dealsApi.sendDeliveryPlanForConfirmation(lead.lead_id);
    },
    {
      success: "Sent to the learner on WhatsApp. The plan is accepted when they reply YES.",
      invalidate: invalidate(lead.lead_id),
      onSuccess: () => setForm(null),
    },
  );
  if (!q.data) return null;
  const state = q.data;
  const accepted = plan?.status === "Accepted";
  const pickBatch = (b: OfferableBatch) =>
    set({
      planned_start_date: b.start_date,
      preferred_lms_batch_code: b.lms_batch_code,
      preferred_lms_batch_label: b.lms_batch_code ? `${b.timing} · from ${date(b.start_date)}` : null,
    });
  const confirmation = state.confirmation;

  return (
    <Section
      title="Confirm delivery plan"
      subtitle="Branch manager review · acceptance is separate from batch allocation"
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
              ["Preferred batch", plan.preferred_lms_batch_code ? `${plan.preferred_lms_batch_code}${plan.preferred_lms_batch_label ? ` · ${plan.preferred_lms_batch_label}` : ""}` : "None picked"],
              ["Capacity review", plan.capacity_review === "Checked" ? "Capacity checked" : "Waiting for capacity"],
              ["Accepted", `${plan.accepted_by?.full_name ?? (plan.acceptance_method === "whatsapp" ? "Learner" : "—")} · ${dateTime(plan.accepted_at)}`],
              ["How accepted", plan.acceptance_method ? METHOD_LABEL[plan.acceptance_method] : "Not recorded"],
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
                onChange={(e) => set({ service_branch_id: Number(e.target.value), preferred_lms_batch_code: null, preferred_lms_batch_label: null })}
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
                onChange={(e) => {
                  // typing a different date than the picked batch's start drops that preference
                  const picked = hints.data?.batches.find((b) => b.lms_batch_code === values.preferred_lms_batch_code);
                  const keep = picked && picked.start_date === e.target.value;
                  set({
                    planned_start_date: e.target.value,
                    ...(keep || !values.preferred_lms_batch_code ? {} : { preferred_lms_batch_code: null, preferred_lms_batch_label: null }),
                  });
                }}
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
          {state.can_edit && lead.course && (
            <BatchHints
              courseTitle={lead.course.course_title}
              batches={hints.data?.batches ?? []}
              loading={hints.isLoading}
              selectedCode={values.preferred_lms_batch_code ?? null}
              selectedLabel={values.preferred_lms_batch_label ?? null}
              onPick={pickBatch}
              onClear={() => set({ preferred_lms_batch_code: null, preferred_lms_batch_label: null })}
            />
          )}
          <div className="grid gap-2 rounded-xl border p-3">
            <div className="text-sm font-medium">Student acceptance</div>
            {confirmation && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <MessageCircle className="size-3.5" />
                {confirmation.awaiting_reply ? (
                  <>
                    <Status kind="info">Waiting for the learner's YES</Status>
                    Sent {dateTime(confirmation.requested_at)} · message {confirmation.status.toLowerCase()}
                  </>
                ) : (
                  <>Plan changed after it was sent; send it again so the learner confirms the new version.</>
                )}
                {confirmation.problem && <span className="text-destructive">{confirmation.problem}</span>}
              </div>
            )}
            {state.can_edit && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={send.isPending || !state.whatsapp.has_number} onClick={() => send.mutate(undefined)}>
                  <Send />
                  {confirmation?.awaiting_reply ? "Send again on WhatsApp" : "Send for confirmation"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {!state.whatsapp.has_number
                    ? "No WhatsApp number on file: use the manual option below."
                    : state.whatsapp.sending
                      ? "The learner gets this plan on WhatsApp and replies YES."
                      : "WhatsApp sending is switched off right now: use the manual option below."}
                </span>
              </div>
            )}
            <label className="check-tile">
              <Checkbox
                aria-label="Student acceptance captured"
                checked={values.student_accepted === true}
                disabled={!state.can_edit}
                onCheckedChange={(v) => set({ student_accepted: v === true })}
              />
              <span className="text-sm">Or: the student accepted this confirmed plan, and I am recording it</span>
            </label>
            {values.student_accepted === true && (
              <Field label="How accepted">
                <NativeSelect
                  aria-label="How accepted"
                  options={ACCEPT_METHODS}
                  value={values.acceptance_method}
                  disabled={!state.can_edit}
                  onChange={(e) => set({ acceptance_method: e.target.value as "in_person" | "call" })}
                />
              </Field>
            )}
          </div>
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

/** The course's upcoming LMS batches at the service branch (same list as Lead 360's "Batches for this course"). A
 *  click fills the planned start and records the batch as the learner's preference; the batch is still allocated later. */
function BatchHints({
  courseTitle,
  batches,
  loading,
  selectedCode,
  selectedLabel,
  onPick,
  onClear,
}: {
  courseTitle: string;
  batches: OfferableBatch[];
  loading: boolean;
  selectedCode: string | null;
  selectedLabel: string | null;
  onPick: (b: OfferableBatch) => void;
  onClear: () => void;
}) {
  return (
    <div className="grid gap-2 rounded-xl border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Upcoming {courseTitle} batches · pick one to fill the start date</span>
        {selectedCode && (
          <span className="flex items-center gap-2 text-xs">
            <Status kind="good">{`Preferred: ${selectedCode}`}</Status>
            <Button type="button" size="sm" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          </span>
        )}
      </div>
      {selectedCode && selectedLabel && <p className="text-xs text-muted-foreground">{selectedLabel}</p>}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading batches…</p>
      ) : batches.length ? (
        <ul className="grid gap-1.5 text-sm">
          {batches.map((b) => {
            const picked = !!b.lms_batch_code && b.lms_batch_code === selectedCode;
            return (
              <li key={b.batch_id}>
                <button
                  type="button"
                  disabled={!b.is_offerable}
                  onClick={() => onPick(b)}
                  className={cn(
                    "w-full rounded-md border p-2 text-left transition-colors",
                    b.is_offerable ? "hover:bg-muted" : "cursor-not-allowed opacity-70",
                    picked && "border-primary bg-primary/5",
                  )}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {b.lms_batch_code ?? b.batch_code} · from {date(b.start_date)}
                    </span>
                    {b.is_offerable ? <Status kind="good">{b.seats_left} seat(s) left</Status> : <Status kind="neutral">Not offerable</Status>}
                  </span>
                  <span className={cn("block text-xs", b.timing_confirmed ? "text-muted-foreground" : "italic text-muted-foreground")}>
                    {b.delivery_mode} · {b.timing}
                  </span>
                  {b.not_offerable_reason && <span className="block text-xs text-muted-foreground">{b.not_offerable_reason}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No upcoming batch is published for this course at this branch. Type the start date; the batch can be allocated later.</p>
      )}
    </div>
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
