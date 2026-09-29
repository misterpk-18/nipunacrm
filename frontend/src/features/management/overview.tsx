/**
 * V4 Overview tab: four KPI cards, verified collections for the last 7 days, admission pipeline bars,
 * "Your attention" queues and branch pulse — from GET /dashboard/overview plus the existing list endpoints.
 * Money stays a string end to end (money() only formats; sumMoney() adds in paise).
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, Clock3, Columns3, GraduationCap, SquareUser, Wallet } from "lucide-react";
import { admissionsApi } from "@/api/admissions";
import { list } from "@/api/client";
import { leadsApi, type LeadRow } from "@/api/leads";
import { useOverview, type Overview } from "@/api/overview";
import type { PaymentRow } from "@/api/payments";
import { useBranchFilter } from "@/auth/auth";
import { Avatar, Empty, ErrorPanel, KpiCard, LeadChip, LoadingRows, QueryView, Section, Status } from "@/components/crm/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { date, dateTime, isPast, money, relative, sumMoney, todayIST } from "@/lib/format";
import { useCanOpen } from "./shared";

export function OverviewTab() {
  const branchId = useBranchFilter();
  const overview = useOverview({ branch_id: branchId });
  const canOpen = useCanOpen();
  const d = overview.data;
  const k = d?.kpis;
  const link = (path: string) => (canOpen(path) ? path : undefined);

  if (overview.error) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />;
  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="dash-kpis" aria-label="Key figures">
        <KpiCard
          label="Open enquiries"
          value={k?.open_enquiries ?? 0}
          hint={k ? `${k.new_enquiries} ready for first contact` : undefined}
          icon={SquareUser}
          tone="violet"
          to={link("/leads")}
          search={{ lead_status: "All" }}
          loading={overview.isLoading}
        />
        <KpiCard
          label="Admissions"
          value={k?.admissions ?? 0}
          hint={k ? `${k.awaiting_batch} awaiting batch allocation` : undefined}
          icon={GraduationCap}
          tone="blue"
          to={link("/admissions")}
          loading={overview.isLoading}
        />
        <KpiCard
          label="Verified collections"
          value={k ? money(k.verified_collections) : "—"}
          hint={k ? `${k.verified_payments} verified payment transaction${k.verified_payments === 1 ? "" : "s"} this month` : undefined}
          icon={Wallet}
          tone="green"
          to={link("/payments")}
          search={{ status: "Verified" }}
          loading={overview.isLoading}
        />
        <KpiCard
          label="Outstanding balance"
          value={k ? money(k.outstanding_balance) : "—"}
          hint={k ? `${k.pending_verification.count} payment${k.pending_verification.count === 1 ? "" : "s"} awaiting verification` : undefined}
          icon={Clock3}
          tone="amber"
          to={link("/collections")}
          loading={overview.isLoading}
        />
      </div>
      <div className="dash-grid">
        <CollectionsPanel data={d} loading={overview.isLoading} />
        <PipelinePanel data={d} loading={overview.isLoading} />
      </div>
      <div className="dash-grid items-start">
        <AttentionPanel data={d} />
        <BranchPulse query={overview} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- collections (7 days)

/** A round axis maximum ≥ value (1 / 2 / 2.5 / 5 × 10ⁿ). */
function niceMax(value: number) {
  if (value <= 0) return 1000;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].map((s) => s * power).find((s) => s >= value) ?? 10 * power);
}

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

function CollectionsPanel({ data, loading }: { data: Overview | undefined; loading: boolean }) {
  const canOpen = useCanOpen();
  const days = data?.collections_daily ?? [];
  const total = sumMoney(days.map((x) => x.amount));
  const max = niceMax(Math.max(0, ...days.map((x) => Number(x.amount))));
  const range = days.length ? `${dayLabel(days[0]!.date)} – ${dayLabel(days[days.length - 1]!.date)}` : "Last 7 days";
  return (
    <Section title="Collections overview" subtitle="Verified payments, net of reversals" action={<span className="subtle-chip">{range}</span>}>
      {loading ? (
        <Skeleton className="h-[200px] w-full" />
      ) : (
        <figure className="m-0" aria-label="Verified collections per day, last 7 days">
          <div className="flex items-baseline justify-between gap-3">
            <strong className="text-[25px] font-semibold tracking-[-0.035em] md:text-[28px]">{money(total)}</strong>
            <span className="text-xs text-muted-foreground">Last 7 days</span>
          </div>
          <div className="bar-chart">
            <div className="chart-grid" aria-hidden>
              {[max, max / 2, 0].map((t) => (
                <span key={t}>
                  <b>{money(t)}</b>
                </span>
              ))}
            </div>
            <div className="chart-columns">
              {days.map((x) => {
                const amount = Number(x.amount);
                const pct = Math.max(0, Math.min(100, (amount / max) * 100));
                return (
                  <div key={x.date} className="chart-column group" tabIndex={0} aria-label={`${date(x.date)}: ${money(x.amount)}`}>
                    <div className="bar-track relative">
                      <div style={{ height: `${pct}%`, minHeight: amount > 0 ? 3 : 1, opacity: amount > 0 ? 1 : 0.35 }} />
                      <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-sm group-hover:block group-focus:block">
                        <div className="text-muted-foreground">{date(x.date)}</div>
                        <strong>{money(x.amount)}</strong>
                      </div>
                    </div>
                    <small>{dayLabel(x.date).split(" ")[0]}</small>
                  </div>
                );
              })}
            </div>
          </div>
          <table className="sr-only">
            <caption>Verified collections per day</caption>
            <tbody>
              {days.map((x) => (
                <tr key={x.date}>
                  <th scope="row">{date(x.date)}</th>
                  <td>{money(x.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}
      <div className="chart-foot">
        <span>Pending claims are not collections until verified.</span>
        {canOpen("/reports") ? <Link to="/reports">View report</Link> : canOpen("/payments") ? <Link to="/payments">Payments</Link> : null}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- admission pipeline

const BAR_COLOURS: Record<string, string> = {
  Counselling: "var(--chart-5)",
  Demo: "#8e7fe6",
  "Fee discussion": "var(--chart-1)",
  Verification: "var(--primary)",
  Admitted: "var(--chart-2)",
};

function PipelinePanel({ data, loading }: { data: Overview | undefined; loading: boolean }) {
  const canOpen = useCanOpen();
  const p = data?.pipeline;
  const max = Math.max(1, ...(p?.bars.map((b) => b.count) ?? [0]));
  return (
    <Section
      title="Admission pipeline"
      subtitle={p ? `${p.open_opportunities} open opportunit${p.open_opportunities === 1 ? "y" : "ies"} across your branch scope` : "Pipeline cards by stage"}
      action={<Columns3 className="size-[18px] text-muted-foreground" aria-hidden />}
    >
      {loading || !p ? (
        <LoadingRows rows={5} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="text-[25px] font-semibold tracking-[-0.035em] md:text-[28px]">{money(p.open_value)}</strong>
            <span className="text-xs text-muted-foreground">Open opportunity value · standard fees</span>
          </div>
          <div className="mt-4 grid gap-3.5" role="list" aria-label="Pipeline cards by stage">
            {p.bars.map((b) => (
              <div key={b.label} className="funnel-row" role="listitem" title={b.stages.join(" + ")}>
                <span>{b.label}</span>
                <div className="funnel-track" aria-hidden>
                  <div style={{ width: `${(b.count / max) * 100}%`, background: BAR_COLOURS[b.label] ?? "var(--chart-1)" }} />
                </div>
                <b>{String(b.count).padStart(2, "0")}</b>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="chart-foot">
        <span>Leads are qualified before they become a deal.</span>
        {canOpen("/pipeline") && <Link to="/pipeline">Open pipeline</Link>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- your attention

type AttentionKey = "follow-ups" | "payments" | "admissions";

function followUpWhen(at: string | null) {
  if (!at) return "Unscheduled";
  if (isPast(at)) return `Overdue ${relative(at).replace(" ago", "")}`;
  const istDay = new Date(at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return istDay === todayIST() ? `Today, ${new Date(at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}` : dateTime(at);
}

function AttentionPanel({ data }: { data: Overview | undefined }) {
  const canOpen = useCanOpen();
  const tabs = (
    [
      { key: "follow-ups", label: "Follow-ups", count: data?.attention.follow_ups, path: "/leads", all: { to: "/my-work" } },
      { key: "payments", label: "Payments", count: data?.attention.payments, path: "/payments", all: { to: "/payments", search: { status: "Pending Verification" } } },
      { key: "admissions", label: "Admissions", count: data?.attention.admissions, path: "/admissions", all: { to: "/admissions", search: { enrolment_status: "Awaiting Batch Allocation" } } },
    ] as const
  ).filter((t) => canOpen(t.path));
  const [tab, setTab] = useState<AttentionKey>(tabs[0]?.key ?? "admissions");
  const current = tabs.find((t) => t.key === tab) ?? tabs[0];
  return (
    <Section
      title="Your attention, where it matters"
      subtitle="Pick up the next action and keep it moving."
      action={
        current ? (
          <Link to={current.all.to} search={"search" in current.all ? (current.all.search as never) : undefined} className="text-sm font-semibold text-primary">
            View all
          </Link>
        ) : undefined
      }
    >
      {tabs.length === 0 ? (
        <Empty title="Nothing queued for your role" />
      ) : (
        <Tabs value={current?.key} onValueChange={(v) => setTab(v as AttentionKey)}>
          <TabsList aria-label="Attention queues" className="h-[42px] w-full gap-4 sm:gap-5">
            {tabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="text-xs sm:text-sm">
                {t.label}
                <span className="queue-count">{t.count ?? "…"}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="follow-ups" className="mt-1">
            <FollowUps />
          </TabsContent>
          <TabsContent value="payments" className="mt-1">
            <PaymentClaims />
          </TabsContent>
          <TabsContent value="admissions" className="mt-1">
            <AwaitingBatch />
          </TabsContent>
        </Tabs>
      )}
    </Section>
  );
}

function FollowUps() {
  const branchId = useBranchFilter();
  const q = useQuery({
    queryKey: ["leads", "attention", branchId ?? null],
    queryFn: async () => {
      const base = { lead_status: "All", per_page: 5, branch_id: branchId };
      const [overdue, today] = await Promise.all([leadsApi.list({ ...base, queue: "overdue" }), leadsApi.list({ ...base, queue: "due_today" })]);
      const seen = new Map<number, LeadRow>();
      for (const l of [...overdue.data, ...today.data]) seen.set(l.lead_id, l);
      return [...seen.values()].sort((a, b) => (a.next_follow_up_at ?? "").localeCompare(b.next_follow_up_at ?? "")).slice(0, 5);
    },
  });
  return (
    <QueryView query={q} rows={4} empty={<Empty title="No follow-ups due">Everything scheduled is in the future.</Empty>}>
      {(rows) => (
        <div>
          {rows.map((l) => (
            <Link key={l.lead_id} to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="attention-row hover:bg-muted/40">
              <Avatar name={l.name} />
              <div className="min-w-0 flex-1">
                <b className="truncate">{l.name}</b>
                <span className="truncate">
                  {l.course?.course_title ?? "Course not chosen"} · {l.branch.branch_name}
                </span>
              </div>
              <div className="max-w-[45%] shrink-0 text-right">
                <LeadChip value={l.ai_priority ?? (l.stage === "New Enquiry" ? "New Enquiry" : null)} label={l.ai_priority ?? (l.stage === "New Enquiry" ? "New" : undefined)} />
                <span className={isPast(l.next_follow_up_at) ? "!text-destructive" : undefined}>{followUpWhen(l.next_follow_up_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </QueryView>
  );
}

function PaymentClaims() {
  const branchId = useBranchFilter();
  const q = useQuery({
    queryKey: ["payments", "attention", branchId ?? null],
    queryFn: () => list<PaymentRow>("/payments", { status: "Pending Verification", per_page: 5, branch_id: branchId }).then((r) => r.data),
  });
  return (
    <QueryView query={q} rows={4} empty={<Empty title="No payment claims waiting">Every recorded payment has been reviewed.</Empty>}>
      {(rows) => (
        <div>
          {rows.map((p) => (
            <Link key={p.payment_id} to="/payments" search={{ status: "Pending Verification" } as never} className="attention-row hover:bg-muted/40">
              <Avatar name={p.person.full_name} />
              <div className="min-w-0 flex-1">
                <b className="truncate">{p.person.full_name}</b>
                <span className="truncate">
                  {p.invoice?.invoice_number ?? "No invoice"} · {p.collecting_branch.branch_name}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <strong className="block text-sm">{money(p.amount)}</strong>
                <span>Claim · {date(p.payment_date)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </QueryView>
  );
}

function AwaitingBatch() {
  const branchId = useBranchFilter();
  const q = useQuery({
    queryKey: ["admissions", "attention", branchId ?? null],
    queryFn: () => admissionsApi.list({ enrolment_status: "Awaiting Batch Allocation", per_page: 5, branch_id: branchId }).then((r) => r.data),
  });
  return (
    <QueryView query={q} rows={4} empty={<Empty title="No admissions awaiting a batch" />}>
      {(rows) => (
        <div>
          {rows.map((a) => (
            <Link key={a.admission_id} to="/admissions" search={{ admission: a.admission_id } as never} className="attention-row hover:bg-muted/40">
              <Avatar name={a.person.full_name} />
              <div className="min-w-0 flex-1">
                <b className="truncate">{a.person.full_name}</b>
                <span className="truncate">
                  {a.course.course_title} · {a.service_branch.branch_name}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <Status kind="info">Awaiting batch</Status>
                <span>{a.admission_code}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </QueryView>
  );
}

// ---------------------------------------------------------------- branch pulse

function BranchPulse({ query }: { query: ReturnType<typeof useOverview> }) {
  return (
    <Section title="Branch pulse" subtitle="Admissions and net verified collections this month" action={<Building2 className="size-[18px] text-muted-foreground" aria-hidden />}>
      <QueryView query={{ ...query, data: query.data?.branches }} rows={2} empty={<Empty title="No branches in scope" />}>
        {(rows) => (
          <div>
            {rows.map((b) => (
              <div key={b.branch.branch_id} className="pulse-row justify-between">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="branch-monogram" aria-hidden>
                    {b.branch.branch_name[0]}
                  </span>
                  <div className="min-w-0">
                    <b className="truncate">{b.branch.branch_name}</b>
                    <small>
                      {b.admissions} admission{b.admissions === 1 ? "" : "s"}
                    </small>
                  </div>
                </div>
                <div className="text-right">
                  <b>{money(b.net_verified)}</b>
                  <small>Net verified</small>
                </div>
              </div>
            ))}
          </div>
        )}
      </QueryView>
    </Section>
  );
}
