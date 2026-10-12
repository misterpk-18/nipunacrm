import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { ArrowRight, BadgeCheck, FileText, IndianRupee, RefreshCw, Search, Send, ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { dealKeys, dealsApi } from "@/api/deals";
import { CLOSED_MILESTONES, feeKeys, feesApi, type FeeDiscussion, type FeeVersion, type ScrSummary } from "@/api/fees";
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
import { DeliveryPlanPanel } from "./deal-panels";
import { FeeValidity } from "./fee-validity";
import { FormDialog, SALES_SIDE } from "./shared";
import { ApprovalStatus, ConcessionNotice } from "./special-closing";
import { usePricePreview } from "./use-price-preview";

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

// ---------------------------------------------------------------- one discussion: step 1 price, step 2 delivery plan, then invoice

function DiscussionView({ discussionId }: { discussionId: number }) {
  const q = useQuery({
    queryKey: feeKeys.detail(discussionId),
    queryFn: () => feesApi.get(discussionId),
    // a request waiting for a manager's decision updates this screen by itself
    refetchInterval: (query) => (query.state.data?.current_version?.status === "Pending Approval" ? 8000 : false),
  });
  const { hasRole } = useAuth();
  const [dialog, setDialog] = useState<null | "scr" | "invoice">(null);
  const leadId = q.data?.lead.lead_id ?? 0;
  const lead = useQuery({ queryKey: leadKeys.detail(leadId), queryFn: () => leadsApi.get(leadId), enabled: leadId > 0 });
  const plan = useQuery({ queryKey: dealKeys.deliveryPlan(leadId), queryFn: () => dealsApi.deliveryPlan(leadId), enabled: leadId > 0 });

  const approve = useApiMutation((versionId: number) => feesApi.approveVersion(versionId), { success: (v) => `Version ${v.version_no} approved`, invalidate: INVALIDATE });
  const share = useApiMutation(() => feesApi.share(discussionId), { success: "Approved fee marked as shared", invalidate: INVALIDATE });
  const reissue = useApiMutation(() => feesApi.reissue(discussionId), {
    success: (x) => `Re-issued as version ${x.version_no} at ${money(x.final_payable)}`,
    invalidate: INVALIDATE,
  });
  const acceptCounter = useApiMutation(
    (scr: ScrSummary) =>
      feesApi.addVersion(discussionId, {
        offer_id: q.data?.current_version?.offer?.offer_id ?? null,
        extra_concession: scr.counter_extra ?? "0",
        request_reason: `Accepting the counteroffer on ${scr.scr_code}`,
      }),
    { success: (x) => `Version ${x.version_no} saved and sent for approval`, invalidate: INVALIDATE },
  );

  if (q.isLoading) return <LoadingRows rows={8} />;
  if (q.error) return <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const v = d.current_version;
  const salesSide = hasRole(...SALES_SIDE);
  const canInvoice = hasRole(...SALES_SIDE, "ACCOUNTS");
  const closed = CLOSED_MILESTONES.includes(d.milestone);
  const workable = salesSide && !closed;
  const expired = v?.validity?.state === "expired";
  const approved = v?.status === "Approved" && !expired;
  const planAccepted = plan.data?.plan?.status === "Accepted";
  const reissueInfo = d.reissue;

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
          title={`Step 1 · ${v?.status === "Approved" ? "Price agreed" : "Agree the price"}`}
          subtitle="A version is valid for 7 calendar days or until the offer ends, whichever comes first"
          action={<FeeValidity validity={v?.validity} />}
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
                ["Valid until", date(v.valid_until)],
                ["Counsellor", d.counsellor?.full_name ?? "—"],
                ["Fee shared", d.fee_shared_at ? dateTime(d.fee_shared_at) : "Not yet"],
              ]}
            />
          ) : (
            <Empty title="No version yet">Choose the offer and any extra concession below, then save the price.</Empty>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Status>{`${d.milestone} · milestone`}</Status>
            {v && <Status>{`Version ${v.version_no} · ${v.status}`}</Status>}
            {v?.below_floor && <Status kind="danger">Below floor</Status>}
            {v?.needs_special_closing && v.status !== "Approved" && <Status kind="warn">Needs special closing</Status>}
          </div>
          {v && (
            <div className="mt-4">
              <ApprovalStatus version={v} canAct={workable && !expired} busy={acceptCounter.isPending} onAcceptCounter={(scr) => acceptCounter.mutate(scr)} />
            </div>
          )}
          {expired && reissueInfo?.available && workable && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" role="status">
              <b>This price has expired.</b>{" "}
              {reissueInfo.same_price ? (
                <>
                  The same offer and price are still available: {money(reissueInfo.new_final_payable)}.
                  <div className="mt-2">
                    <Button size="sm" disabled={reissue.isPending} onClick={() => reissue.mutate(undefined)}>
                      <RefreshCw />
                      Re-issue at same price
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  It can't be re-issued at the same price because things changed:
                  <ul className="mt-1 list-disc pl-5">
                    {reissueInfo.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  Save a new price below.
                </>
              )}
            </div>
          )}
          {v && workable && !expired && (
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
        </Section>
        <Section title="Version history" className="min-w-0">
          {d.versions.length ? (
            <DataTable
              rows={[...d.versions].sort((a, b) => b.version_no - a.version_no)}
              rowKey={(x) => x.version_id}
              columns={[
                { header: "Version", cell: (x) => `v${x.version_no}${x.version_id === v?.version_id ? " · Current" : ""}` },
                { header: "Final payable", cell: (x) => money(x.final_payable) },
                {
                  header: "Status",
                  cell: (x) => (
                    <span className="flex flex-wrap items-center gap-1">
                      <Status>{x.status}</Status>
                      {x.version_id === v?.version_id && <FeeValidity validity={x.validity} />}
                    </span>
                  ),
                },
              ]}
            />
          ) : (
            <Empty title="No versions yet" />
          )}
        </Section>
        {workable && d.milestone !== "Invoice Issued" && (
          <Section
            title={v ? "New version / counteroffer" : "Offer and price"}
            subtitle="The best eligible offer is applied for you — switch or remove it. Amounts are frozen once saved; a new version supersedes the open one."
            className="min-w-0 lg:col-span-2"
          >
            <PriceForm discussion={d} />
          </Section>
        )}
        <Section title="Invoices for this lead" className="min-w-0">
          <LeadInvoices leadId={d.lead.lead_id} />
        </Section>
      </div>
      {approved && (
        <div className="mt-4 grid gap-3">
          <div>
            <h2 className="text-foreground">Step 2 · Delivery plan</h2>
            <p className="mt-1 text-sm text-muted-foreground">The price is agreed. Confirm how and where the learner will study, then create the invoice.</p>
          </div>
          {lead.data && <DeliveryPlanPanel lead={lead.data} />}
          {canInvoice && !closed && ["Approved", "Fee Shared"].includes(d.milestone) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!planAccepted} onClick={() => setDialog("invoice")}>
                <FileText />
                Create invoice
              </Button>
              {!planAccepted && <span className="text-xs text-muted-foreground">Accept the delivery plan above to unlock the invoice; the payment schedule is set on the invoice.</span>}
            </div>
          )}
        </div>
      )}
      <div className="mt-4">
        <Warning>After the first verified payment, fee changes require Founder / CEO or Super Admin approval plus an Accounts correction. No self-approval.</Warning>
      </div>
      {dialog === "scr" && v && <SpecialClosingDialog version={v} onClose={() => setDialog(null)} />}
      {dialog === "invoice" && <CreateInvoiceDialog leadId={d.lead.lead_id} onClose={() => setDialog(null)} />}
    </>
  );
}

type VersionValues = { offer_id: string; extra_concession: string; valid_until: string; notes: string; request_reason: string };

/** Offer (best one pre-selected, others and "why not" listed) + extra concession with the live limit check. A price that
 *  needs no approval is saved and approved in one click; one that does is saved and sent for approval in one click. */
function PriceForm({ discussion }: { discussion: FeeDiscussion }) {
  const current = discussion.current_version;
  const options = discussion.offer_options ?? { eligible: [], unavailable: [], best_offer_id: null };
  const form = useForm<VersionValues>({ defaultValues: { offer_id: "", extra_concession: "0", valid_until: "", notes: "", request_reason: "" } });
  const standard = Number(current?.standard_fee ?? discussion.course.standard_fee);
  const [offerId, extra, reason] = form.watch(["offer_id", "extra_concession", "request_reason"]);
  const chosen = options.eligible.find((o) => String(o.offer_id) === offerId);
  const preview = usePricePreview(discussion.fee_discussion_id, chosen?.offer_id ?? null, extra || "0");
  const p = preview.data;
  const finalPayable = p ? Number(p.final_payable) : Math.max(standard - Number(chosen?.saving ?? 0) - Number(extra || 0), 0);
  const needsApproval = p?.needs_approval ?? Number(extra || 0) > 0;
  const used = discussion.used_offers ?? [];

  // Auto-apply: a fresh price starts from the version's own offer, or the best eligible offer when there is none yet.
  useEffect(() => {
    const keep = current?.offer && options.eligible.some((o) => o.offer_id === current.offer!.offer_id) ? current.offer.offer_id : null;
    form.reset({
      offer_id: String(keep ?? (current ? "" : (options.best_offer_id ?? ""))),
      extra_concession: current ? String(Number(current.extra_concession)) : "0",
      valid_until: "",
      notes: "",
      request_reason: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the saved version (or the best offer) changes
  }, [current?.version_id, options.best_offer_id, form]);

  const save = useApiMutation(
    async (mode: "draft" | "approve" | "request") => {
      const v = form.getValues();
      const saved = await feesApi.addVersion(discussion.fee_discussion_id, {
        offer_id: v.offer_id ? Number(v.offer_id) : null,
        extra_concession: v.extra_concession || "0",
        valid_until: v.valid_until || null,
        notes: v.notes || null,
        request_reason: mode === "request" ? v.request_reason : null,
      });
      return mode === "approve" ? feesApi.approveVersion(saved.version_id) : saved;
    },
    {
      success: (x) =>
        x.status === "Approved"
          ? `Price approved · version ${x.version_no} · ${money(x.final_payable)}`
          : x.status === "Pending Approval"
            ? `Version ${x.version_no} saved and sent for approval`
            : `Version ${x.version_no} saved · final payable ${money(x.final_payable)}`,
      invalidate: INVALIDATE,
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  const e = form.formState.errors;
  return (
    <form className="grid gap-4" onSubmit={(ev) => ev.preventDefault()}>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Offer</legend>
        <OfferChoice selected={offerId === ""} onSelect={() => form.setValue("offer_id", "")} title="No offer" detail={`Standard fee ${money(standard)}`} />
        {options.eligible.map((o) => (
          <OfferChoice
            key={o.offer_id}
            selected={offerId === String(o.offer_id)}
            onSelect={() => form.setValue("offer_id", String(o.offer_id))}
            title={o.offer_name}
            badge={o.is_best ? "Best saving" : undefined}
            detail={
              o.benefit_type === "Complimentary Course"
                ? `Complimentary course: ${o.complimentary_courses.map((c) => c.course_title).join(" or ")} · no change to this fee`
                : `Saves ${money(o.saving)} → ${money(o.final_price)}${o.below_floor ? " · below the 70% floor, needs special closing" : ""}`
            }
          />
        ))}
        {e.offer_id?.message && <p className="text-xs text-destructive">{e.offer_id.message}</p>}
        {(options.unavailable.length > 0 || used.length > 0) && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Why other offers aren't available ({options.unavailable.length})</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {options.unavailable.map((u) => (
                <li key={u.offer_id}>
                  <b>{u.offer_name}</b> — {u.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {options.eligible.length === 0 && options.unavailable.length === 0 && <p className="text-xs text-muted-foreground">No active offer for this course and branch today.</p>}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Extra concession (₹)" htmlFor="v-extra" error={e.extra_concession?.message}>
          <Input id="v-extra" type="number" min={0} step="1" inputMode="numeric" {...form.register("extra_concession")} />
          <div className="mt-1 min-h-4">
            <ConcessionNotice preview={p} error={preview.error} />
          </div>
        </Field>
        <Field label="Valid until (optional)" htmlFor="v-valid" hint="Defaults to 7 days or the offer's end" error={e.valid_until?.message}>
          <Input id="v-valid" type="date" min={todayIST()} {...form.register("valid_until")} />
        </Field>
        <Field label="Notes" htmlFor="v-notes" className="sm:col-span-2">
          <Textarea id="v-notes" rows={2} {...form.register("notes")} />
        </Field>
        {needsApproval && (
          <Field label="Why does the learner need this concession?" htmlFor="v-reason" hint="Sent to the approver with the request" error={e.request_reason?.message} className="sm:col-span-2">
            <Textarea id="v-reason" rows={2} {...form.register("request_reason")} />
          </Field>
        )}
      </div>
      <div>
        <p className="mb-2 text-sm">
          Final payable <b>{money(finalPayable)}</b>
          <span className="text-xs text-muted-foreground">
            {" "}
            · standard {money(standard)}
            {chosen ? ` − offer ${money(chosen.saving)}` : ""}
            {Number(extra) > 0 ? ` − extra ${money(extra)}` : ""}. The 1–3 instalments are agreed when the invoice is created.
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          {needsApproval ? (
            <Button type="button" disabled={save.isPending || !reason.trim() || preview.isError} onClick={() => save.mutate("request")}>
              <ShieldAlert />
              Request approval
            </Button>
          ) : (
            <Button type="button" disabled={save.isPending || preview.isError} onClick={() => save.mutate("approve")}>
              <BadgeCheck />
              Save and approve price
            </Button>
          )}
          <Button type="button" variant="outline" disabled={save.isPending || preview.isError} onClick={() => save.mutate("draft")}>
            Save as draft
          </Button>
        </div>
      </div>
    </form>
  );
}

function OfferChoice({ selected, onSelect, title, detail, badge }: { selected: boolean; onSelect: () => void; title: string; detail: string; badge?: string | undefined }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
      <input type="radio" name="offer" className="mt-1" checked={selected} onChange={onSelect} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {title}
          {badge && <Status kind="good">{badge}</Status>}
        </span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
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
