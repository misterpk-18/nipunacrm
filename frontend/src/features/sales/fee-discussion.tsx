import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { ArrowRight, BadgeCheck, FileText, IndianRupee, Search, Send, ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { CLOSED_MILESTONES, feeKeys, feesApi, type FeeDiscussion, type FeeVersion, type Offer } from "@/api/fees";
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
import { CreateInvoiceDialog } from "@/features/finance/create-invoice";
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
    queryKey: leadKeys.list({ q, branch_id: branchId, per_page: 10, lead_status: "All" }),
    queryFn: () => leadsApi.list({ q, branch_id: branchId, per_page: 10, lead_status: "All" }),
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
      <PageHead title="Fee Discussion & Invoice" description="Pick a deal to price its course, get approvals and create the invoice." />
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
  const { hasRole } = useAuth();
  const [dialog, setDialog] = useState<null | "scr" | "invoice">(null);

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
                ["Validity", date(v.valid_until)],
                ["Counsellor", d.counsellor?.full_name ?? "—"],
                ["Fee shared", d.fee_shared_at ? dateTime(d.fee_shared_at) : "Not yet"],
              ]}
            />
          ) : (
            <Empty title="No version yet">Save the first version below — standard fee, offer and any extra concession.</Empty>
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
            </div>
          )}
          {v && v.status === "Approved" && canInvoice && !closed && ["Approved", "Fee Shared"].includes(d.milestone) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button onClick={() => setDialog("invoice")}>
                <FileText />
                Create invoice
              </Button>
              <Button variant="outline" asChild>
                <Link to="/leads/$leadId" params={{ leadId: String(d.lead.lead_id) }}>
                  Delivery plan on the deal
                </Link>
              </Button>
              <span className="text-xs text-muted-foreground">The course needs an accepted delivery plan; the payment schedule is set on the invoice.</span>
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
        </Section>
        {workable && d.milestone !== "Invoice Issued" && (
          <Section title={v ? "New version / counteroffer" : "First version"} subtitle="Amounts are frozen once saved; a new version supersedes the open one." className="min-w-0 lg:col-span-2">
            <VersionForm discussion={d} />
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
      {dialog === "invoice" && <CreateInvoiceDialog leadId={d.lead.lead_id} onClose={() => setDialog(null)} />}
    </>
  );
}

type VersionValues = { offer_id: string; extra_concession: string; valid_until: string; notes: string };

function offerDiscount(offer: Offer, standard: number) {
  if (offer.benefit_type === "Discount Amount") return Math.min(Number(offer.discount_amount ?? 0), standard);
  if (offer.benefit_type === "Discount Percent") return Math.round(standard * Number(offer.discount_percent ?? 0)) / 100;
  return 0;
}

/** A version is the price only (standard fee − offer − extra concession); the 1–3 instalments are set on the invoice. */
function VersionForm({ discussion }: { discussion: FeeDiscussion }) {
  const current = discussion.current_version;
  const form = useForm<VersionValues>({ defaultValues: { offer_id: "", extra_concession: "0", valid_until: "", notes: "" } });
  const offers = discussion.applicable_offers ?? [];
  const used = discussion.used_offers ?? [];
  const standard = Number(current?.standard_fee ?? discussion.course.standard_fee);
  const [offerId, extra] = form.watch(["offer_id", "extra_concession"]);
  const offer = offers.find((o) => String(o.offer_id) === offerId);
  const finalPayable = Math.max(standard - (offer ? offerDiscount(offer, standard) : 0) - Number(extra || 0), 0);

  useEffect(() => {
    form.reset({
      offer_id: current?.offer ? String(current.offer.offer_id) : "",
      extra_concession: current ? String(Number(current.extra_concession)) : "0",
      valid_until: "",
      notes: "",
    });
  }, [current, form]);

  const save = useApiMutation(
    (v: VersionValues) =>
      feesApi.addVersion(discussion.fee_discussion_id, {
        offer_id: v.offer_id ? Number(v.offer_id) : null,
        extra_concession: v.extra_concession || "0",
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
  const e = form.formState.errors;
  const offerHint = [
    offers.length ? null : "No active offer for this course and branch today",
    used.length ? `Already used by this learner (one use per person): ${used.map((u) => `${u.offer_code} on ${u.admission_code}`).join(", ")}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <Field label="Offer" htmlFor="v-offer" hint={offerHint || undefined} error={e.offer_id?.message}>
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
      <Field label="Valid until (optional)" htmlFor="v-valid" hint="Defaults to 7 days or the offer's end" error={e.valid_until?.message}>
        <Input id="v-valid" type="date" min={todayIST()} {...form.register("valid_until")} />
      </Field>
      <Field label="Notes" htmlFor="v-notes">
        <Textarea id="v-notes" rows={2} {...form.register("notes")} />
      </Field>
      <div className="sm:col-span-2">
        <p className="mb-2 text-xs text-muted-foreground">
          Standard fee {money(standard)} · final payable about {money(finalPayable)} — the final payable, 70% floor and validity are confirmed when saved. The
          payment schedule (1–3 instalments) is agreed when the invoice is created.
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

function LeadInvoices({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: feeKeys.invoicesForLead(leadId), queryFn: () => feesApi.invoicesForLead(leadId) });
  return (
    <QueryView query={q} empty={<Empty title="No invoice yet">Create one once the fee is approved and the delivery plan accepted.</Empty>} rows={2}>
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
                {i.courses.map((c) => c.course.course_title).join(", ")} · issued {date(i.issued_on)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryView>
  );
}
