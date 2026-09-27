import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { ArrowRight, BadgeCheck, FileText, IndianRupee, Search, Send, ShieldAlert, Signature } from "lucide-react";
import { ApiError } from "@/api/client";
import {
  CLOSED_MILESTONES,
  DELIVERY_MODES,
  SEAT_TYPES,
  feeKeys,
  feesApi,
  type FeeDiscussion,
  type FeeVersion,
  type PaymentPlan,
} from "@/api/fees";
import { leadKeys, leadsApi, useLead } from "@/api/leads";
import { LEAD_OWNER_ROLES } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CourseSelect, Field, NativeSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, Facts, LoadingRows, PageHead, QueryView, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime, money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FormDialog, SALES_SIDE } from "./shared";

const INVALIDATE = [feeKeys.all, feeKeys.scr, leadKeys.all, ["pipeline"], ["invoices"], ["dashboard"]];

export function FeeQuotePage({ leadId, discussionId }: { leadId?: number | undefined; discussionId?: number | undefined }) {
  if (discussionId) return <DiscussionView discussionId={discussionId} />;
  if (leadId) return <LeadDiscussions leadId={leadId} />;
  return <LeadPicker />;
}

// ---------------------------------------------------------------- no lead: pick one

function LeadPicker() {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const results = useQuery({
    queryKey: leadKeys.list({ q, branch_id: branchId, per_page: 10 }),
    queryFn: () => leadsApi.list({ q, branch_id: branchId, per_page: 10 }),
    enabled: q.length > 0,
  });
  const inFee = useQuery({
    queryKey: leadKeys.list({ stage: "Fee Discussion / Payment Awaited", branch_id: branchId, per_page: 25 }),
    queryFn: () => leadsApi.list({ stage: "Fee Discussion / Payment Awaited", branch_id: branchId, per_page: 25 }),
  });
  const open = (id: number) => void navigate({ to: "/fee-quote", search: { leadId: id } });
  const cols = [
    {
      header: "Lead",
      cell: (l: { lead_id: number; name: string; lead_code: string }) => (
        <span className="font-semibold text-primary">
          {l.name}
          <small className="block font-normal text-muted-foreground">{l.lead_code}</small>
        </span>
      ),
    },
    { header: "Course", cell: (l: { course: { course_title: string } | null }) => l.course?.course_title ?? "—" },
    { header: "Branch", cell: (l: { branch: { branch_name: string } }) => l.branch.branch_name },
    { header: "Owner", cell: (l: { owner: { full_name: string } | null }) => l.owner?.full_name ?? "Unassigned" },
    { header: "Stage", cell: (l: { stage: string }) => <Status>{l.stage}</Status> },
    {
      header: "",
      cell: (l: { lead_id: number }) => (
        <Button size="sm" variant="outline" onClick={() => open(l.lead_id)}>
          Open fees
          <ArrowRight />
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHead title="Fee Discussion & Invoice" description="Pick a lead to price its course, get approvals, record the accepted plan and issue the invoice." />
      <Section title="Find a lead">
        <form
          className="relative mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(text.trim());
          }}
        >
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Name, phone, email or lead code — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Find lead" />
        </form>
        {q && (
          <DataTable
            rows={results.data?.data}
            loading={results.isLoading}
            error={results.error}
            onRetry={() => void results.refetch()}
            rowKey={(l) => l.lead_id}
            onRowClick={(l) => open(l.lead_id)}
            empty={<Empty title="No leads match" />}
            columns={cols}
          />
        )}
      </Section>
      <Section title="Leads in fee discussion" subtitle="Fee Discussion / Payment Awaited" className="mt-4">
        <DataTable
          rows={inFee.data?.data}
          loading={inFee.isLoading}
          error={inFee.error}
          onRetry={() => void inFee.refetch()}
          rowKey={(l) => l.lead_id}
          onRowClick={(l) => open(l.lead_id)}
          empty={<Empty title="No leads are in fee discussion" />}
          columns={cols}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- lead: its discussions + start one

function LeadDiscussions({ leadId }: { leadId: number }) {
  const lead = useLead(leadId);
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const discussions = useQuery({ queryKey: feeKeys.forLead(leadId), queryFn: () => feesApi.listForLead(leadId) });
  const form = useForm({ values: { course_id: lead.data?.course ? String(lead.data.course.course_id) : "", counsellor_id: "" } });
  const goTo = (id: number) => void navigate({ to: "/fee-quote", search: { leadId, discussionId: id } });
  const start = useApiMutation(
    (v: { course_id: string; counsellor_id: string }) =>
      feesApi.start(leadId, { course_id: v.course_id ? Number(v.course_id) : null, counsellor_id: v.counsellor_id ? Number(v.counsellor_id) : null }),
    {
      success: (d) => `Fee discussion ${d.discussion_code} started`,
      invalidate: INVALIDATE,
      onSuccess: (d) => goTo(d.fee_discussion_id),
      silentValidation: true,
      onError: (e) => {
        applyServerErrors(form, e);
        const existing = e instanceof ApiError && e.code === "CONFLICT" ? (e.details as unknown as { fee_discussion_id?: number } | null)?.fee_discussion_id : undefined;
        if (existing) goTo(existing);
      },
    },
  );

  if (lead.isLoading) return <LoadingRows rows={6} />;
  if (lead.error) return <ErrorPanel error={lead.error} onRetry={() => void lead.refetch()} />;
  const l = lead.data!;
  const canStart = hasRole(...SALES_SIDE) && l.is_open;

  return (
    <>
      <PageHead
        title="Fee Discussion & Invoice"
        description={`${l.name} · ${l.lead_code} · ${l.branch.branch_name} · ${l.stage}`}
        actions={
          <Button variant="outline" asChild>
            <Link to="/leads/$leadId" params={{ leadId: String(leadId) }}>
              Lead 360
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Fee discussions" className="min-w-0 lg:col-span-2">
          <QueryView query={discussions} empty={<Empty title="No fee discussion yet">Start one to price this lead's course.</Empty>}>
            {(rows) => (
              <DataTable
                rows={rows}
                rowKey={(d) => d.fee_discussion_id}
                onRowClick={(d) => goTo(d.fee_discussion_id)}
                columns={[
                  { header: "Discussion", cell: (d) => <span className="font-medium text-primary">{d.discussion_code}</span> },
                  { header: "Course", cell: (d) => d.course.course_title },
                  { header: "Milestone", cell: (d) => <Status>{d.milestone}</Status> },
                  { header: "Current version", cell: (d) => (d.current_version ? `v${d.current_version.version_no} · ${d.current_version.status}` : "—") },
                  { header: "Final payable", cell: (d) => money(d.current_version?.final_payable) },
                  { header: "Started", cell: (d) => date(d.created_at) },
                ]}
              />
            )}
          </QueryView>
        </Section>
        <Section title="Start a fee discussion" className="min-w-0">
          {canStart ? (
            <form className="grid gap-3" onSubmit={form.handleSubmit((v) => start.mutate(v))}>
              <Field label="Course being priced" htmlFor="fd-course" error={form.formState.errors.course_id?.message}>
                <CourseSelect id="fd-course" branchCode={l.branch.branch_code} {...form.register("course_id")} />
              </Field>
              <Field label="Counsellor" htmlFor="fd-counsellor" hint={l.owner ? `Defaults to the lead owner, ${l.owner.full_name}` : "Defaults to the lead owner"} error={form.formState.errors.counsellor_id?.message}>
                <StaffSelect id="fd-counsellor" branchId={l.branch.branch_id} roles={LEAD_OWNER_ROLES} placeholder="Lead owner" {...form.register("counsellor_id")} />
              </Field>
              <Button type="submit" disabled={start.isPending}>
                <IndianRupee />
                Start fee discussion
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{l.is_open ? "Only counsellors or a branch manager can start a fee discussion." : `The lead is ${l.stage}.`}</p>
          )}
        </Section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- one discussion

function DiscussionView({ discussionId }: { discussionId: number }) {
  const q = useQuery({ queryKey: feeKeys.detail(discussionId), queryFn: () => feesApi.get(discussionId) });
  const plans = useQuery({ queryKey: feeKeys.paymentPlans, queryFn: feesApi.paymentPlans, staleTime: 10 * 60_000 });
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | "scr" | "accept" | "invoice">(null);

  const approve = useApiMutation((versionId: number) => feesApi.approveVersion(versionId), { success: (v) => `Version ${v.version_no} approved`, invalidate: INVALIDATE });
  const share = useApiMutation(() => feesApi.share(discussionId), { success: "Approved fee marked as shared", invalidate: INVALIDATE });

  if (q.isLoading) return <LoadingRows rows={8} />;
  if (q.error) return <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const v = d.current_version;
  const salesSide = hasRole(...SALES_SIDE);
  const canInvoice = hasRole(...SALES_SIDE, "ACCOUNTS");
  const closed = CLOSED_MILESTONES.includes(d.milestone);
  const workable = salesSide && !closed;
  const plan = plans.data?.find((p) => p.payment_plan_id === v?.payment_plan.payment_plan_id);
  const pendingScr = v?.special_closing_requests.find((s) => s.status === "Pending");

  return (
    <>
      <PageHead
        title="Fee Discussion & Invoice"
        description={`${d.discussion_code}${v ? ` · Version ${v.version_no}` : ""} · ${d.person.full_name} · ${d.lead.lead_code}`}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/leads/$leadId" params={{ leadId: String(d.lead.lead_id) }}>
                Lead 360
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/fee-quote" search={{ leadId: d.lead.lead_id }}>
                All discussions
              </Link>
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section
          title={v?.status === "Approved" ? "Approved commercial discussion" : "Commercial discussion"}
          subtitle="Default validity: 7 calendar days or offer expiry, whichever comes first"
          className="min-w-0 lg:col-span-2"
        >
          {v ? (
            <Facts
              columns={3}
              items={[
                ["Course", d.course.course_title],
                ["Branch", d.branch.branch_name],
                ["Standard fee", money(v.standard_fee)],
                ["Offer / version", `${v.offer ? `${v.offer.offer_name} (${v.offer.offer_code})` : "No offer"} · v${v.version_no}`],
                ["Offer discount", money(v.offer_discount)],
                ["Extra concession", money(v.extra_concession)],
                ["Final payable amount", <b key="fp">{money(v.final_payable)}</b>],
                ["Minimum payable floor (70%)", money(v.minimum_floor)],
                ["Payment plan", v.payment_plan.plan_name],
                ["Validity", date(v.valid_until)],
                ["Counsellor", d.counsellor?.full_name ?? "—"],
                ["Fee shared", d.fee_shared_at ? dateTime(d.fee_shared_at) : "Not yet"],
              ]}
            />
          ) : (
            <Empty title="No version yet">Save the first version below — standard fee, offer and payment plan.</Empty>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Status>{`${d.milestone} · milestone`}</Status>
            {v && <Status>{`Version ${v.version_no} · ${v.status}`}</Status>}
            {v?.below_floor && <Status kind="danger">Below floor</Status>}
            {v?.needs_special_closing && v.status !== "Approved" && <Status kind="warn">Needs special closing</Status>}
            {v?.special_closing_requests.map((s) => (
              <Status key={s.scr_id}>{`${s.scr_code} · ${s.status}${s.counter_extra ? ` · counter ${money(s.counter_extra)}` : ""}`}</Status>
            ))}
          </div>
          {pendingScr && (
            <div className="mt-4">
              <Warning>
                Special closing {pendingScr.scr_code} for {money(pendingScr.requested_extra)} is waiting for a manager's decision (5 staffed-minute target; a timeout
                never approves).
              </Warning>
            </div>
          )}
          {v && workable && (
            <div className="mt-5 flex flex-wrap gap-2">
              {["Discussion Saved", "Counteroffered"].includes(v.status) && !v.needs_special_closing && (
                <Button disabled={approve.isPending} onClick={() => approve.mutate(v.version_id)}>
                  <BadgeCheck />
                  Approve version
                </Button>
              )}
              {["Discussion Saved", "Counteroffered"].includes(v.status) && v.needs_special_closing && (
                <Button onClick={() => setDialog("scr")}>
                  <ShieldAlert />
                  Request special closing
                </Button>
              )}
              {v.status === "Approved" && d.milestone === "Approved" && (
                <Button variant="secondary" disabled={share.isPending} onClick={() => share.mutate(undefined)}>
                  <Send />
                  Share approved fee
                </Button>
              )}
              {v.status === "Approved" && !d.accepted_plan && (
                <Button variant="outline" onClick={() => setDialog("accept")}>
                  <Signature />
                  Accept plan
                </Button>
              )}
            </div>
          )}
          {v && v.status === "Approved" && canInvoice && !closed && ["Approved", "Fee Shared", "Invoice Issued"].includes(d.milestone) && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => setDialog("invoice")}>
                <FileText />
                {d.milestone === "Invoice Issued" ? "Re-issue invoice" : "Issue invoice"}
              </Button>
              <Button variant="outline" asChild>
                <Link to="/invoices">Invoice Register</Link>
              </Button>
            </div>
          )}
        </Section>
        <Section title="Version history" className="min-w-0">
          {d.versions.length ? (
            <DataTable
              rows={[...d.versions].sort((a, b) => b.version_no - a.version_no)}
              rowKey={(x) => x.version_id}
              columns={[
                { header: "Version", cell: (x) => `v${x.version_no}${x.version_id === v?.version_id ? " · Current" : ""}` },
                { header: "Final payable", cell: (x) => money(x.final_payable) },
                { header: "Status", cell: (x) => <Status>{x.status}</Status> },
              ]}
            />
          ) : (
            <Empty title="No versions yet" />
          )}
          {d.accepted_plan && (
            <div className="mt-4 border-t pt-4">
              <h3 className="mb-2 text-sm font-semibold">Accepted delivery plan</h3>
              <Facts
                columns={1}
                items={[
                  ["Version", `v${d.versions.find((x) => x.version_id === d.accepted_plan!.accepted_version_id)?.version_no ?? "?"}`],
                  ["Delivery mode", d.accepted_plan.delivery_mode],
                  ["Seat type", d.accepted_plan.seat_type],
                  ["Planned start", date(d.accepted_plan.planned_start_date)],
                  ["Accepted", dateTime(d.accepted_plan.plan_accepted_at)],
                ]}
              />
            </div>
          )}
        </Section>
        {workable && !d.accepted_plan && (
          <Section title={v ? "New version / counteroffer" : "First version"} subtitle="Amounts are frozen once saved; a new version supersedes the open one." className="min-w-0 lg:col-span-2">
            <VersionForm discussion={d} plans={plans.data ?? []} />
          </Section>
        )}
        <Section title="Invoices for this lead" className="min-w-0">
          <LeadInvoices leadId={d.lead.lead_id} />
        </Section>
      </div>
      <div className="mt-4">
        <Warning>After the first verified payment, fee changes require Founder / CEO or Super Admin approval plus an Accounts correction. No self-approval.</Warning>
      </div>
      {dialog === "scr" && v && <SpecialClosingDialog version={v} onClose={() => setDialog(null)} />}
      {dialog === "accept" && v && <AcceptPlanDialog discussion={d} version={v} onClose={() => setDialog(null)} />}
      {dialog === "invoice" && v && (
        <InvoiceDialog
          version={v}
          plan={plan}
          onClose={() => setDialog(null)}
          onIssued={(invoiceId) => void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: String(invoiceId) } })}
        />
      )}
    </>
  );
}

type VersionValues = { offer_id: string; extra_concession: string; payment_plan_id: string; valid_until: string; notes: string };

function VersionForm({ discussion, plans }: { discussion: FeeDiscussion; plans: PaymentPlan[] }) {
  const current = discussion.current_version;
  const form = useForm<VersionValues>({
    defaultValues: { offer_id: "", extra_concession: "0", payment_plan_id: "", valid_until: "", notes: "" },
  });
  useEffect(() => {
    form.reset({
      offer_id: current?.offer ? String(current.offer.offer_id) : "",
      extra_concession: current ? String(Number(current.extra_concession)) : "0",
      payment_plan_id: String(current?.payment_plan.payment_plan_id ?? plans.find((p) => p.plan_code === "FULL")?.payment_plan_id ?? ""),
      valid_until: "",
      notes: "",
    });
  }, [current, plans, form]);
  const save = useApiMutation(
    (v: VersionValues) =>
      feesApi.addVersion(discussion.fee_discussion_id, {
        offer_id: v.offer_id ? Number(v.offer_id) : null,
        extra_concession: v.extra_concession || "0",
        ...(v.payment_plan_id ? { payment_plan_id: Number(v.payment_plan_id) } : {}),
        valid_until: v.valid_until || null,
        notes: v.notes || null,
      }),
    {
      success: (x) => `Version ${x.version_no} saved · final payable ${money(x.final_payable)}${x.needs_special_closing ? " · needs special closing" : ""}`,
      invalidate: INVALIDATE,
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  const offers = discussion.applicable_offers ?? [];
  const e = form.formState.errors;
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <Field label="Offer" htmlFor="v-offer" hint={offers.length ? undefined : "No active offer for this course and branch today"} error={e.offer_id?.message}>
        <NativeSelect
          id="v-offer"
          placeholder="No offer"
          options={offers.map((o) => ({
            value: o.offer_id,
            label: `${o.offer_name} · ${o.benefit_type === "Discount Amount" ? money(o.discount_amount) : o.benefit_type === "Discount Percent" ? `${Number(o.discount_percent)}%` : "complimentary course"}`,
          }))}
          {...form.register("offer_id")}
        />
      </Field>
      <Field label="Extra concession (₹)" htmlFor="v-extra" hint="Any extra concession needs a special closing approval" error={e.extra_concession?.message}>
        <Input id="v-extra" type="number" min={0} step="1" inputMode="numeric" {...form.register("extra_concession")} />
      </Field>
      <Field label="Payment plan" htmlFor="v-plan" error={e.payment_plan_id?.message}>
        <NativeSelect id="v-plan" options={plans.map((p) => ({ value: p.payment_plan_id, label: p.plan_name }))} {...form.register("payment_plan_id")} />
      </Field>
      <Field label="Valid until (optional)" htmlFor="v-valid" hint="Defaults to 7 days or the offer's end" error={e.valid_until?.message}>
        <Input id="v-valid" type="date" min={todayIST()} {...form.register("valid_until")} />
      </Field>
      <Field label="Notes" htmlFor="v-notes" className="sm:col-span-2">
        <Textarea id="v-notes" {...form.register("notes")} />
      </Field>
      <div className="sm:col-span-2">
        <p className="mb-2 text-xs text-muted-foreground">
          Standard fee {money(current?.standard_fee ?? null)} {current ? "" : "(from the course)"} — final payable, 70% floor and validity are computed when saved.
        </p>
        <Button type="submit" variant="outline" disabled={save.isPending}>
          Save discussion
        </Button>
      </div>
    </form>
  );
}

function SpecialClosingDialog({ version, onClose }: { version: FeeVersion; onClose: () => void }) {
  const form = useForm({ defaultValues: { requested_extra: String(Number(version.extra_concession)), request_reason: "" } });
  const go = useApiMutation(
    (v: { requested_extra: string; request_reason: string }) =>
      feesApi.requestSpecialClosing(version.version_id, { requested_extra: v.requested_extra, request_reason: v.request_reason }),
    { success: (s) => `Special closing ${s.scr_code} requested`, invalidate: INVALIDATE, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog
      title={`Request special closing · v${version.version_no}`}
      description={`Final payable ${money(version.final_payable)} · floor ${money(version.minimum_floor)}${version.below_floor ? " · below floor: needs Founder / CEO or Super Admin plus an independent approval" : ""}`}
      onClose={onClose}
      busy={go.isPending}
      submitLabel="Send for approval"
      onSubmit={form.handleSubmit((v) => go.mutate(v))}
    >
      <Field label="Requested extra (₹)" htmlFor="scr-extra" error={form.formState.errors.requested_extra?.message}>
        <Input id="scr-extra" type="number" min={0} {...form.register("requested_extra")} />
      </Field>
      <Field label="Reason for the request" htmlFor="scr-reason" error={form.formState.errors.request_reason?.message}>
        <Textarea id="scr-reason" {...form.register("request_reason", { required: "Required" })} />
      </Field>
    </FormDialog>
  );
}

function AcceptPlanDialog({ discussion, version, onClose }: { discussion: FeeDiscussion; version: FeeVersion; onClose: () => void }) {
  const form = useForm({ defaultValues: { delivery_mode: "Classroom", seat_type: "Confirmed Seat", planned_start_date: "" } });
  const go = useApiMutation(
    (v: { delivery_mode: string; seat_type: string; planned_start_date: string }) =>
      feesApi.acceptPlan(discussion.fee_discussion_id, {
        version_id: version.version_id,
        delivery_mode: v.delivery_mode,
        seat_type: v.seat_type,
        planned_start_date: v.seat_type === "Future Plan" ? v.planned_start_date || null : null,
      }),
    { success: "Accepted plan recorded", invalidate: INVALIDATE, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  const future = form.watch("seat_type") === "Future Plan";
  return (
    <FormDialog
      title="Record the accepted plan"
      description={`The student accepts version ${version.version_no} at ${money(version.final_payable)} (${version.payment_plan.plan_name}). This is admission prerequisite 1.`}
      onClose={onClose}
      busy={go.isPending}
      submitLabel="Accept plan"
      onSubmit={form.handleSubmit((v) => go.mutate(v))}
    >
      <Field label="Delivery mode" htmlFor="ap-mode">
        <NativeSelect id="ap-mode" options={DELIVERY_MODES.map((m) => ({ value: m, label: m }))} {...form.register("delivery_mode")} />
      </Field>
      <Field label="Seat type" htmlFor="ap-seat">
        <NativeSelect id="ap-seat" options={SEAT_TYPES.map((m) => ({ value: m, label: m }))} {...form.register("seat_type")} />
      </Field>
      {future && (
        <Field label="Planned start date" htmlFor="ap-start" error={form.formState.errors.planned_start_date?.message}>
          <Input id="ap-start" type="date" min={todayIST()} {...form.register("planned_start_date", { required: future ? "Required for a future plan" : false })} />
        </Field>
      )}
    </FormDialog>
  );
}

function InvoiceDialog({ version, plan, onClose, onIssued }: { version: FeeVersion; plan: PaymentPlan | undefined; onClose: () => void; onIssued: (invoiceId: number) => void }) {
  const installments = plan?.installments ?? [];
  const multi = installments.length > 1;
  const form = useForm({
    defaultValues: {
      day0_date: todayIST(),
      terms: "",
      days: installments.map((i) => String(i.due_days_after_admission)),
    },
  });
  const go = useApiMutation(
    (v: { day0_date: string; terms: string; days: string[] }) =>
      feesApi.issueInvoice(version.version_id, {
        day0_date: v.day0_date || null,
        agreed_due_days: multi ? v.days.map((x) => Number(x)) : null,
        terms: v.terms || null,
      }),
    {
      success: (inv) => `Invoice ${inv.invoice_number} issued`,
      invalidate: INVALIDATE,
      onSuccess: (inv) => {
        onClose();
        onIssued(inv.invoice_id);
      },
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <FormDialog
      title="Issue invoice"
      description={`From approved version ${version.version_no}: ${money(version.final_payable)} · ${version.payment_plan.plan_name}. A previous invoice for this discussion is superseded.`}
      onClose={onClose}
      busy={go.isPending}
      submitLabel="Issue invoice"
      onSubmit={form.handleSubmit((v) => go.mutate(v))}
    >
      <Field label="Day 0 (admission / first payment date)" htmlFor="inv-day0" error={form.formState.errors.day0_date?.message}>
        <Input id="inv-day0" type="date" {...form.register("day0_date")} />
      </Field>
      {multi &&
        installments.map((i, idx) => (
          <Field
            key={i.installment_no}
            label={`Instalment ${i.installment_no} · ${Number(i.percent_of_fee)}% · due day`}
            htmlFor={`inv-day-${idx}`}
            hint={i.due_days_min === i.due_days_max ? `Fixed: day ${i.due_days_min}` : `Agree an exact day between ${i.due_days_min} and ${i.due_days_max}`}
          >
            <Input
              id={`inv-day-${idx}`}
              type="number"
              min={i.due_days_min}
              max={i.due_days_max}
              readOnly={i.due_days_min === i.due_days_max}
              {...form.register(`days.${idx}` as const)}
            />
          </Field>
        ))}
      {(form.formState.errors as Record<string, { message?: string }>)["agreed_due_days"]?.message && (
        <p className="text-xs text-destructive">{(form.formState.errors as Record<string, { message?: string }>)["agreed_due_days"]?.message}</p>
      )}
      <Field label="Terms (optional)" htmlFor="inv-terms">
        <Textarea id="inv-terms" {...form.register("terms")} />
      </Field>
    </FormDialog>
  );
}

function LeadInvoices({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: feeKeys.invoicesForLead(leadId), queryFn: () => feesApi.invoicesForLead(leadId) });
  return (
    <QueryView query={q} empty={<Empty title="No invoice yet">Issue one from an approved version.</Empty>} rows={2}>
      {(rows) => (
        <ul className="space-y-2 text-sm">
          {rows.map((i) => (
            <li key={i.invoice_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
              <Link to="/invoices/$invoiceId" params={{ invoiceId: String(i.invoice_id) }} className="font-medium text-primary">
                {i.invoice_number}
              </Link>
              <span>{money(i.billed_amount)}</span>
              <Status>{i.status}</Status>
              <span className="w-full text-xs text-muted-foreground">
                {i.course.course_title} · issued {date(i.issued_on)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryView>
  );
}
