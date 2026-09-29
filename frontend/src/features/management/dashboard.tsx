/** Dashboard (#1) and Branch Manager view, from GET /dashboard (role-aware: company / branch_manager / staff). */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { list } from "@/api/client";
import {
  useDashboard,
  type ApprovalQueues,
  type BranchTiles,
  type Dashboard,
  type KpiTiles,
  type TargetAchievement,
} from "@/api/dashboard";
import { useReport } from "@/api/reports";
import type { Funnel } from "@/api/dashboard";
import type { Money } from "@/api/types";
import { useAuth, useBranchFilter } from "@/auth/auth";
import {
  DataTable,
  Empty,
  PageHead,
  QueryView,
  Section,
} from "@/components/crm/ui";
import { date, money, todayIST } from "@/lib/format";
import { CalendarDays, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { OverviewTab } from "./overview";
import { CollectionsChart, FunnelChart, Meter } from "./charts";
import { ManagementBrief } from "./ai-parts";
import { LongGapMetric } from "./payment-gaps";
import {
  LinkedMetric,
  PeriodBar,
  QueueRow,
  periodLabel,
  periodQuery,
  useCanOpen,
  type PeriodValue,
} from "./shared";

export type DashboardTab = "overview" | "performance";

/**
 * /dashboard: V4 "Workspace overview" with Overview (new KPI cards, charts, attention queues) and Performance
 * (the period KPIs, Long-gap plans, funnel, branch comparison, targets, approvals, AI brief).
 * /branch-manager renders the performance view on its own.
 */
export function DashboardPage({
  manager = false,
  tab = "overview",
  onTab,
}: {
  manager?: boolean;
  tab?: DashboardTab;
  onTab?: (tab: DashboardTab) => void;
}) {
  const { hasRole } = useAuth();
  const [newLead, setNewLead] = useState(false);
  if (manager) return <PerformanceView manager />;
  const canAddLead = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE");
  return (
    <>
      <PageHead
        eyebrow="Your workspace at a glance"
        title="Workspace overview"
        description="Sales, admissions and collections. Your next actions, in one place."
        actions={
          <>
            <span className="hidden items-center gap-2 rounded-[8px] border bg-card px-3 py-2.5 text-xs text-muted-foreground xl:inline-flex">
              <CalendarDays className="size-4" aria-hidden />
              {date(todayIST())}
            </span>
            {canAddLead && (
              <Button onClick={() => setNewLead(true)}>
                <Plus />
                Add lead
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => onTab?.(v as DashboardTab)}>
        <TabsList aria-label="Dashboard views" className="mb-5 w-full gap-7">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-0">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="performance" className="mt-0">
          <PerformanceView />
        </TabsContent>
      </Tabs>
      {canAddLead && <NewLeadDialog open={newLead} onOpenChange={setNewLead} />}
    </>
  );
}

/** The period dashboard (all existing KPIs); standalone with a page title for /branch-manager. */
function PerformanceView({ manager = false }: { manager?: boolean }) {
  const branchId = useBranchFilter();
  const { hasRole } = useAuth();
  const [period, setPeriod] = useState<PeriodValue>({ period: "This Month" });
  const ready = period.period !== "Custom" || Boolean(period.from && period.to);
  const dashboard = useDashboard({
    ...periodQuery(period),
    branch_id: branchId,
  });
  const canBrief = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER");

  const d = dashboard.data;
  const title = manager
    ? "Branch Manager Dashboard"
    : d?.view === "company"
      ? "Founder / CEO Dashboard"
      : d?.view === "branch_manager"
        ? "Branch Manager Dashboard"
        : "Dashboard";
  const periodText = d ? periodLabel(d.period, d.from, d.to) : "Loading period…";

  return (
    <>
      {manager ? (
        <PageHead title={title} description={periodText} />
      ) : (
        <div className="section-head mb-4">
          <h2>{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{periodText}</p>
        </div>
      )}
      <div className="mb-4">
        <PeriodBar value={period} onChange={setPeriod} idPrefix="dash" />
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Collections count only verified events by verification date; pending
        verification is shown separately and never counted. Overdue follow-ups,
        SLA risk and overdue dues are current positions.
      </p>
      {!ready ? (
        <Empty title="Choose a date range" />
      ) : (
        <QueryView query={dashboard} rows={8}>
          {(data) => (
            <div className="space-y-4">
              <KpiGrid data={data} />
              {manager && <TeamQueues data={data} branchId={branchId} />}
              {data.view !== "staff" && (
                <CompanyOrBranch
                  data={data}
                  period={period}
                  branchId={branchId}
                  manager={manager}
                />
              )}
              {canBrief && data.view !== "staff" && (
                <ManagementBrief period={period.period} branchId={branchId} />
              )}
            </div>
          )}
        </QueryView>
      )}
    </>
  );
}

function tilesOf(d: Dashboard): KpiTiles {
  return d.view === "company" ? d.company : d.tiles;
}

function KpiGrid({ data }: { data: Dashboard }) {
  const t = tilesOf(data);
  const queues = data.view === "staff" ? null : data.approval_queues;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <LinkedMetric
        label="Genuine Enquiries"
        value={t.genuine_enquiries}
        hint="Created in period · excl. spam / test / duplicates"
        to="/leads"
      />
      <LinkedMetric
        label="Overdue Follow-ups"
        value={t.overdue_follow_ups}
        hint={`SLA at risk: ${t.sla_at_risk}`}
        to="/tasks"
      />
      <LinkedMetric
        label="Demos S / A / N"
        value={`${t.demos.scheduled} / ${t.demos.attended} / ${t.demos.no_show}`}
        hint="Scheduled / attended / no-show"
        to="/demos"
      />
      <LinkedMetric
        label="Paid Admissions"
        value={t.paid_admissions}
        hint="₹1,000 admission token verified"
        to="/admissions"
      />
      <LinkedMetric
        label="Verified Collections"
        value={money(t.verified_collections)}
        hint="Net of reversals"
        to="/payments"
      />
      <LinkedMetric
        label="Pending Verification"
        value={money(t.pending_verification_excluded)}
        hint="Not counted in collections"
        to="/payments"
      />
      <LinkedMetric
        label="Overdue Instalment Value"
        value={money(t.overdue_dues)}
        hint="Current position"
        to="/collections"
      />
      <LongGapMetric tiles={t} />
      {queues ? (
        <LinkedMetric
          label="Approvals I can decide"
          value={queues.can_approve}
          hint={`Higher approval: ${queues.higher_approval}`}
          to="/discount-approval"
        />
      ) : (
        <LinkedMetric
          label="SLA at risk"
          value={t.sla_at_risk}
          hint="First response nearing deadline"
          to="/leads"
        />
      )}
    </div>
  );
}

function CompanyOrBranch({
  data,
  period,
  branchId,
  manager,
}: {
  data: Exclude<Dashboard, { view: "staff" }>;
  period: PeriodValue;
  branchId?: number;
  manager: boolean;
}) {
  // Company view carries no funnel: read it from the funnel report with the same period / branch.
  const funnelReport = useReport<Funnel>(
    "funnel",
    { ...periodQuery(period), branch_id: branchId },
    data.view === "company",
  );
  const funnel =
    data.view === "branch_manager" ? data.funnel : funnelReport.data?.data;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Lead funnel"
          subtitle="Leads created in period that reached each stage"
          className="min-w-0"
        >
          {data.view === "company" && funnelReport.isLoading ? (
            <Empty title="Loading funnel…" />
          ) : funnel && funnel.total_leads > 0 ? (
            <FunnelChart stages={funnel.stages} />
          ) : (
            <Empty title="No leads created in this period" />
          )}
        </Section>
        <Section
          title="Collections by branch"
          subtitle="Verified vs pending verification (excluded)"
          className="min-w-0"
        >
          <CollectionsChart
            rows={data.branches.map((b) => ({
              name: b.branch.branch_name,
              verified: b.verified_collections,
              pending: b.pending_verification_excluded,
            }))}
          />
        </Section>
      </div>
      <Section
        title="Branch comparison"
        subtitle={periodLabel(data.period, data.from, data.to)}
      >
        <BranchTable rows={data.branches} />
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <TargetsSection targets={data.targets} />
        {data.view === "branch_manager" ? (
          <Section title="Top staff" subtitle="Paid admissions in period">
            {data.top_staff.length ? (
              <div className="text-sm">
                {data.top_staff.map((s) => (
                  <div
                    key={s.user_id}
                    className="flex justify-between border-b py-2 last:border-b-0"
                  >
                    <span>{s.full_name}</span>
                    <strong>{s.paid_admissions}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No paid admissions yet" />
            )}
          </Section>
        ) : (
          !manager && <ApprovalSection queues={data.approval_queues} />
        )}
      </div>
      {data.view === "branch_manager" && !manager && (
        <ApprovalSection queues={data.approval_queues} />
      )}
    </>
  );
}

function BranchTable({ rows }: { rows: BranchTiles[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.branch.branch_id}
      columns={[
        {
          header: "Branch",
          cell: (r) => (
            <span className="font-medium">{r.branch.branch_name}</span>
          ),
        },
        { header: "Genuine enquiries", cell: (r) => r.genuine_enquiries },
        {
          header: "Demos S/A/N",
          cell: (r) =>
            `${r.demos.scheduled}/${r.demos.attended}/${r.demos.no_show}`,
        },
        { header: "Paid admissions", cell: (r) => r.paid_admissions },
        {
          header: "Verified collections",
          cell: (r) => money(r.verified_collections),
        },
        {
          header: "Pending (excluded)",
          cell: (r) => money(r.pending_verification_excluded),
        },
        { header: "Overdue dues", cell: (r) => money(r.overdue_dues) },
        { header: "Overdue follow-ups", cell: (r) => r.overdue_follow_ups },
        {
          header: "Counsellors",
          cell: (r) => r.staff_coverage.active_counsellors,
        },
        {
          header: "Unassigned leads",
          cell: (r) => r.staff_coverage.unassigned_open_leads,
        },
      ]}
    />
  );
}

export function TargetsSection({
  targets,
  title = "Targets (Target Master)",
}: {
  targets: TargetAchievement[];
  title?: string;
}) {
  const canOpen = useCanOpen();
  return (
    <Section
      title={title}
      subtitle={
        targets[0]
          ? `${targets[0].version_code} · compared only with verified results in the target period`
          : "Approved targets for today"
      }
      action={
        canOpen("/target-master") ? (
          <Link
            className="text-xs font-medium text-primary"
            to="/target-master"
          >
            Target Master
          </Link>
        ) : undefined
      }
    >
      {targets.length ? (
        <div className="space-y-5">
          {targets.map((t) => (
            <div key={`${t.version_code}-${t.scope}`} className="space-y-2">
              <div className="text-sm font-semibold">
                {t.scope === "Company" ? "Company" : t.scope}
              </div>
              <Meter
                label="Verified collections"
                value={money(t.verified_collections)}
                target={
                  t.verified_collections_target === null
                    ? null
                    : money(t.verified_collections_target)
                }
                pct={t.collections_pct}
              />
              <Meter
                label="Paid admissions"
                value={String(t.paid_admissions)}
                target={
                  t.paid_admissions_target === null
                    ? null
                    : String(t.paid_admissions_target)
                }
                pct={t.admissions_pct}
              />
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No approved targets for today">
          Unconfigured measures display Not Set.
        </Empty>
      )}
    </Section>
  );
}

function ApprovalSection({ queues }: { queues: ApprovalQueues }) {
  return (
    <Section title="Approval queues" subtitle="Current position">
      <QueueRow
        label="Special closing requests I can decide"
        count={queues.can_approve}
        to="/discount-approval"
      />
      <QueueRow
        label="Needs higher approval"
        count={queues.higher_approval}
        to="/discount-approval"
      />
      <QueueRow
        label="Approved fee changes to apply"
        count={queues.awaiting_execution.fee_changes_to_apply}
        to="/admissions"
      />
      <QueueRow
        label="Refund payouts awaiting execution"
        count={queues.awaiting_execution.refund_payouts}
        to="/refunds"
      />
      <QueueRow
        label="Payment corrections pending approval"
        count={queues.awaiting_execution.corrections_pending}
        to="/payments"
      />
    </Section>
  );
}

/** Branch Manager team queues: approvals, unassigned leads, overdue tasks, payments pending verification. */
function TeamQueues({
  data,
  branchId,
}: {
  data: Dashboard;
  branchId?: number;
}) {
  const overdue = useQuery({
    queryKey: ["tasks", "count", "team-overdue", branchId ?? null],
    queryFn: () =>
      list<unknown>("/tasks", {
        view: "team",
        overdue: true,
        per_page: 1,
        branch_id: branchId,
      }),
  });
  const pending = useQuery({
    queryKey: ["payments", "count", "pending-verification", branchId ?? null],
    queryFn: () =>
      list<unknown>("/payments", {
        status: "Pending Verification",
        per_page: 1,
        branch_id: branchId,
      }),
  });
  const unassigned =
    data.view === "staff"
      ? null
      : data.branches.reduce(
          (n, b) => n + b.staff_coverage.unassigned_open_leads,
          0,
        );
  const queues = data.view === "staff" ? null : data.approval_queues;
  const pendingTotals = (
    pending.data?.meta as
      { totals?: { pending_verification: Money } } | undefined
  )?.totals;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section
        title="Team queues"
        subtitle="What needs the branch's attention now"
      >
        {queues && (
          <QueueRow
            label="Approvals pending"
            hint={`Special closing requests you can decide · ${queues.higher_approval} need higher approval`}
            count={queues.can_approve}
            to="/discount-approval"
          />
        )}
        {unassigned !== null && (
          <QueueRow
            label="Unassigned leads"
            hint="Open leads with no owner"
            count={unassigned}
            to="/leads"
            search={{ assigned_to: "unassigned", lead_status: "All" }}
          />
        )}
        <QueueRow
          label="Overdue tasks"
          hint="Team tasks past their due time"
          count={overdue.data?.meta.total ?? "…"}
          to="/tasks"
          search={{ tab: "Overdue" }}
        />
        <QueueRow
          label="Payments pending verification"
          hint={
            pendingTotals
              ? `${money(pendingTotals.pending_verification)} not yet counted`
              : "Awaiting Accounts"
          }
          count={pending.data?.meta.total ?? "…"}
          to="/payments"
          search={{ status: "Pending Verification" }}
        />
      </Section>
      {queues && (
        <Section
          title="Awaiting execution"
          subtitle="Approved, not yet applied"
        >
          <QueueRow
            label="Approved fee changes to apply"
            count={queues.awaiting_execution.fee_changes_to_apply}
            to="/admissions"
          />
          <QueueRow
            label="Refund payouts"
            count={queues.awaiting_execution.refund_payouts}
            to="/refunds"
          />
          <QueueRow
            label="Payment corrections pending approval"
            count={queues.awaiting_execution.corrections_pending}
            to="/payments"
          />
        </Section>
      )}
    </div>
  );
}
