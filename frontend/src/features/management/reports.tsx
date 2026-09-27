/** Reports (#12): management, funnel, performance, SLA with shared filters; CSV export; scheduled reports (admins). */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Download, Plus } from "lucide-react";
import type { Funnel } from "@/api/dashboard";
import {
  REPORT_FORMATS,
  REPORT_FREQUENCIES,
  REPORT_NAMES,
  reportKeys,
  reportsApi,
  useReport,
  type ManagementReport,
  type PerformanceRow,
  type ReportEnvelope,
  type ReportFilters,
  type ReportName,
  type ScheduledReport,
  type SlaReport,
} from "@/api/reports";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  BranchSelect,
  CourseSelect,
  Field,
  LookupSelect,
  NativeSelect,
  StaffSelect,
  applyServerErrors,
  useBranchCode,
} from "@/components/crm/forms";
import {
  DataTable,
  Empty,
  PageHead,
  QueryView,
  Section,
  Status,
} from "@/components/crm/ui";
import { dateTime, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FunnelChart } from "./charts";
import { PeriodBar, periodQuery, type PeriodValue } from "./shared";
import { useBranches } from "@/api/reference";

type Extra = { course_id: string; staff_id: string; source_id: string };

export function ReportsPage() {
  const branchId = useBranchFilter();
  const branchCode = useBranchCode(branchId);
  const { isAdmin } = useAuth();
  const [period, setPeriod] = useState<PeriodValue>({ period: "This Month" });
  const [extra, setExtra] = useState<Extra>({
    course_id: "",
    staff_id: "",
    source_id: "",
  });
  const [by, setBy] = useState<"course" | "source" | "staff">("course");
  const ready = period.period !== "Custom" || Boolean(period.from && period.to);

  const filters: ReportFilters = {
    ...periodQuery(period),
    branch_id: branchId,
    course_id: extra.course_id ? Number(extra.course_id) : undefined,
    staff_id: extra.staff_id ? Number(extra.staff_id) : undefined,
    source_id: extra.source_id ? Number(extra.source_id) : undefined,
  };
  const management = useReport<ManagementReport>("management", filters, ready);
  const funnel = useReport<Funnel>("funnel", filters, ready);
  const performance = useReport<PerformanceRow[]>(
    "performance",
    { ...filters, by },
    ready,
  );
  const sla = useReport<SlaReport>("sla", filters, ready);

  const exportCsv = useApiMutation(
    (name: ReportName) =>
      reportsApi.exportCsv(
        name,
        name === "performance" ? { ...filters, by } : filters,
      ),
    {
      success: "Export downloaded",
    },
  );
  const exportButton = (name: ReportName) => (
    <Button
      size="sm"
      variant="outline"
      onClick={() => exportCsv.mutate(name)}
      disabled={exportCsv.isPending || !ready}
      aria-label={`Export ${name} CSV`}
    >
      <Download />
      CSV
    </Button>
  );

  return (
    <>
      <PageHead
        title="Reports"
        description="IST · week Monday–Sunday · collections by verification date · pending verification never counted"
      />
      <div className="mb-4 space-y-3">
        <PeriodBar value={period} onChange={setPeriod} idPrefix="rep" />
        <div className="panel grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Course" htmlFor="rep-course">
            <CourseSelect
              id="rep-course"
              branchCode={branchCode}
              placeholder="Any course"
              value={extra.course_id}
              onChange={(e) =>
                setExtra({ ...extra, course_id: e.target.value })
              }
            />
          </Field>
          <Field label="Staff (lead owner)" htmlFor="rep-staff">
            <StaffSelect
              id="rep-staff"
              branchId={branchId}
              placeholder="Any staff"
              value={extra.staff_id}
              onChange={(e) => setExtra({ ...extra, staff_id: e.target.value })}
            />
          </Field>
          <Field label="Original source" htmlFor="rep-source">
            <LookupSelect
              id="rep-source"
              lookup="lead_sources"
              placeholder="Any source"
              value={extra.source_id}
              onChange={(e) =>
                setExtra({ ...extra, source_id: e.target.value })
              }
            />
          </Field>
          <Freshness report={management.data} />
        </div>
      </div>

      {!ready ? (
        <Empty title="Choose a date range" />
      ) : (
        <div className="space-y-4">
          <Section
            title="Management · collections & admissions"
            subtitle="Verified collections by verification date"
            action={exportButton("management")}
          >
            <QueryView query={management} rows={4}>
              {(r) => <ManagementView data={r.data} />}
            </QueryView>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="Lead funnel"
              subtitle="Leads created in period that reached each stage"
              action={exportButton("funnel")}
              className="min-w-0"
            >
              <QueryView query={funnel} rows={6}>
                {(r) =>
                  r.data.total_leads ? (
                    <>
                      <FunnelChart stages={r.data.stages} />
                      <p className="mt-2 text-xs text-muted-foreground">
                        {r.data.total_leads} leads created in the period.
                      </p>
                    </>
                  ) : (
                    <Empty title="No leads for these filters" />
                  )
                }
              </QueryView>
            </Section>
            <Section
              title="SLA · follow-ups & first response"
              action={exportButton("sla")}
              className="min-w-0"
            >
              <QueryView query={sla} rows={5}>
                {(r) => <SlaView data={r.data} />}
              </QueryView>
            </Section>
          </div>

          <Section
            title="Performance"
            subtitle="Enquiries → leads → paid admissions"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  aria-label="Performance by"
                  className="h-8 w-40"
                  value={by}
                  onChange={(e) => setBy(e.target.value as typeof by)}
                  options={[
                    { value: "course", label: "By course" },
                    { value: "source", label: "By source" },
                    { value: "staff", label: "By staff" },
                  ]}
                />
                {exportButton("performance")}
              </div>
            }
          >
            <QueryView
              query={performance}
              rows={5}
              isEmpty={(r) => r.data.length === 0}
              empty={<Empty title="No results for these filters" />}
            >
              {(r) => <PerformanceView rows={r.data} by={by} />}
            </QueryView>
          </Section>

          {isAdmin && <ScheduledReports />}
        </div>
      )}
    </>
  );
}

function Freshness({
  report,
}: {
  report: ReportEnvelope<unknown> | undefined;
}) {
  if (!report) return null;
  return (
    <div className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
      Period {report.from} – {report.to} · cutoff {dateTime(report.cutoff_at)}{" "}
      IST · <Status>{report.completeness}</Status>
      {report.completeness_notes && (
        <span className="ml-1">{report.completeness_notes}</span>
      )}
    </div>
  );
}

function ManagementView({ data }: { data: ManagementReport }) {
  const c = data.company;
  const cards: [string, string][] = [
    ["Verified collections · gross", money(c.gross_verified)],
    ["Reversals", money(c.reversals)],
    ["Refunds", money(c.refunds)],
    ["Verified collections · net", money(c.net)],
    ["Dues recovery (subset of verified)", money(c.dues_recovery)],
    ["Pending verification (excluded)", money(c.pending_verification_excluded)],
    ["New paid admissions", String(c.new_paid_admissions)],
  ];
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <DataTable
        rows={data.branches}
        rowKey={(r) => r.branch.branch_id}
        columns={[
          {
            header: "Branch",
            cell: (r) => (
              <span className="font-medium">{r.branch.branch_name}</span>
            ),
          },
          { header: "Gross verified", cell: (r) => money(r.gross_verified) },
          { header: "Reversals", cell: (r) => money(r.reversals) },
          { header: "Refunds", cell: (r) => money(r.refunds) },
          { header: "Net", cell: (r) => money(r.net) },
          { header: "Dues recovery", cell: (r) => money(r.dues_recovery) },
          {
            header: "Pending (excluded)",
            cell: (r) => money(r.pending_verification_excluded),
          },
          { header: "New paid admissions", cell: (r) => r.new_paid_admissions },
        ]}
      />
    </>
  );
}

function PerformanceView({ rows, by }: { rows: PerformanceRow[]; by: string }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => `${r.key ?? "none"}-${r.label}`}
      columns={[
        {
          header:
            by === "course"
              ? "Course"
              : by === "source"
                ? "Original source"
                : "Owner",
          cell: (r) => <span className="font-medium">{r.label}</span>,
        },
        { header: "Enquiries", cell: (r) => r.enquiries },
        { header: "Leads", cell: (r) => r.leads },
        { header: "Paid admissions", cell: (r) => r.paid_admissions },
        {
          header: "Conversion",
          cell: (r) =>
            r.conversion_pct === null ? "—" : `${r.conversion_pct}%`,
        },
      ]}
    />
  );
}

function SlaView({ data }: { data: SlaReport }) {
  return (
    <>
      <div
        className="mb-4 flex flex-wrap gap-2"
        aria-label="First response SLA"
      >
        {Object.entries(data.responses).map(([state, n]) => (
          <div key={state} className="rounded-md border px-3 py-2 text-sm">
            <div className="text-xs text-muted-foreground">{state}</div>
            <strong>{n}</strong>
          </div>
        ))}
      </div>
      <DataTable
        rows={data.follow_ups}
        rowKey={(r) => `${r.owner_user_id ?? "none"}`}
        empty={<Empty title="No follow-up tasks in this period" />}
        columns={[
          {
            header: "Owner",
            cell: (r) => <span className="font-medium">{r.owner}</span>,
          },
          { header: "Tasks", cell: (r) => r.tasks },
          { header: "On time", cell: (r) => r.completed_on_time },
          { header: "Late", cell: (r) => r.completed_late },
          { header: "Overdue open", cell: (r) => r.overdue_open },
          { header: "Open", cell: (r) => r.open },
          {
            header: "Completion",
            cell: (r) =>
              r.completion_pct === null ? "—" : `${r.completion_pct}%`,
          },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------- scheduled reports

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scheduleText(r: ScheduledReport) {
  if (r.frequency === "Daily") return `Daily ${r.send_time}`;
  if (r.frequency === "Weekly")
    return `${DAYS[r.schedule_day ?? 0] ?? "?"} ${r.send_time}`;
  return `Month day ${r.schedule_day} · ${r.send_time}`;
}

function ScheduledReports() {
  const [open, setOpen] = useState(false);
  const scheduled = useQuery({
    queryKey: reportKeys.scheduled,
    queryFn: reportsApi.scheduled,
  });
  const branches = useBranches();
  const toggle = useApiMutation(
    (r: ScheduledReport) =>
      reportsApi.updateScheduled(r.scheduled_report_id, {
        is_active: !r.is_active,
      }),
    {
      success: (r) =>
        `${r.report_name} report ${r.is_active ? "activated" : "paused"}`,
      invalidate: [reportKeys.scheduled],
    },
  );
  return (
    <Section
      title="Scheduled reports"
      subtitle="Email delivery depends on the Scheduled report email integration"
      action={
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus />
          New schedule
        </Button>
      }
    >
      <DataTable
        rows={scheduled.data}
        loading={scheduled.isLoading}
        error={scheduled.error}
        onRetry={() => void scheduled.refetch()}
        rowKey={(r) => r.scheduled_report_id}
        empty={<Empty title="No scheduled reports yet" />}
        columns={[
          {
            header: "Report",
            cell: (r) => (
              <span className="font-medium capitalize">{r.report_name}</span>
            ),
          },
          { header: "Schedule", cell: scheduleText },
          { header: "Period", cell: (r) => r.period },
          {
            header: "Branch",
            cell: (r) =>
              r.branch_id
                ? (branches.data?.find((b) => b.branch_id === r.branch_id)
                    ?.branch_name ?? r.branch_id)
                : "All branches",
          },
          {
            header: "Recipients",
            cell: (r) => (
              <span className="break-all">{r.recipients.join(", ")}</span>
            ),
          },
          { header: "Format", cell: (r) => r.format },
          {
            header: "Delivery",
            cell: (r) => <Status>{r.last_delivery_status}</Status>,
          },
          {
            header: "Active",
            cell: (r) => (
              <Switch
                checked={r.is_active}
                onCheckedChange={() => toggle.mutate(r)}
                aria-label={`Active: ${r.report_name} ${scheduleText(r)}`}
              />
            ),
          },
        ]}
      />
      <ScheduleDialog open={open} onOpenChange={setOpen} />
    </Section>
  );
}

type ScheduleValues = {
  report_name: string;
  frequency: string;
  schedule_day: string;
  send_time: string;
  period: string;
  branch_id: string;
  format: string;
  recipients: string;
};

function ScheduleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const form = useForm<ScheduleValues>({
    defaultValues: {
      report_name: "management",
      frequency: "Daily",
      schedule_day: "",
      send_time: "08:30",
      period: "Yesterday",
      branch_id: "",
      format: "CSV",
      recipients: "",
    },
  });
  const { register, handleSubmit, watch, formState, reset } = form;
  const frequency = watch("frequency");
  const create = useApiMutation(reportsApi.createScheduled, {
    success: "Scheduled report saved",
    invalidate: [reportKeys.scheduled],
    silentValidation: true,
    onSuccess: () => {
      reset();
      onOpenChange(false);
    },
    onError: (e) => applyServerErrors(form, e),
  });
  const submit = handleSubmit((v) =>
    create.mutate({
      report_name: v.report_name,
      frequency: v.frequency,
      schedule_day:
        v.frequency === "Daily" || !v.schedule_day
          ? null
          : Number(v.schedule_day),
      send_time: v.send_time,
      period: v.period,
      branch_id: v.branch_id ? Number(v.branch_id) : null,
      format: v.format,
      recipients: v.recipients.split(/[,\s]+/).filter(Boolean),
    }),
  );
  const err = (k: keyof ScheduleValues) => formState.errors[k]?.message;
  const opt = (xs: readonly string[]) =>
    xs.map((x) => ({ value: x, label: x }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New scheduled report</DialogTitle>
          <DialogDescription>
            Weekly: day 1–7 (Mon–Sun). Monthly: day 1–28.
          </DialogDescription>
        </DialogHeader>
        <form
          id="schedule-form"
          onSubmit={submit}
          className="grid gap-3 sm:grid-cols-2"
        >
          <Field label="Report" htmlFor="sr-name" error={err("report_name")}>
            <NativeSelect
              id="sr-name"
              options={opt(REPORT_NAMES)}
              {...register("report_name")}
            />
          </Field>
          <Field label="Frequency" htmlFor="sr-freq" error={err("frequency")}>
            <NativeSelect
              id="sr-freq"
              options={opt(REPORT_FREQUENCIES)}
              {...register("frequency")}
            />
          </Field>
          {frequency !== "Daily" && (
            <Field
              label="Schedule day"
              htmlFor="sr-day"
              error={err("schedule_day")}
            >
              <Input
                id="sr-day"
                type="number"
                min={1}
                max={frequency === "Weekly" ? 7 : 28}
                {...register("schedule_day", { required: "Required" })}
              />
            </Field>
          )}
          <Field
            label="Send time (IST)"
            htmlFor="sr-time"
            error={err("send_time")}
          >
            <Input
              id="sr-time"
              type="time"
              {...register("send_time", { required: "Required" })}
            />
          </Field>
          <Field
            label="Report period"
            htmlFor="sr-period"
            error={err("period")}
          >
            <NativeSelect
              id="sr-period"
              options={opt([
                "Today",
                "Yesterday",
                "This Week",
                "Last Week",
                "This Month",
                "Last Month",
              ])}
              {...register("period")}
            />
          </Field>
          <Field label="Branch" htmlFor="sr-branch" error={err("branch_id")}>
            <BranchSelect
              id="sr-branch"
              placeholder="All branches"
              {...register("branch_id")}
            />
          </Field>
          <Field label="Format" htmlFor="sr-format" error={err("format")}>
            <NativeSelect
              id="sr-format"
              options={opt(REPORT_FORMATS)}
              {...register("format")}
            />
          </Field>
          <Field
            label="Recipients"
            htmlFor="sr-recipients"
            error={err("recipients")}
            hint="Comma-separated emails"
            className="sm:col-span-2"
          >
            <Input
              id="sr-recipients"
              {...register("recipients", {
                required: "At least one recipient",
              })}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="schedule-form"
            disabled={create.isPending}
          >
            Save schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
