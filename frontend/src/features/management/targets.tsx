/** Target Master: approved achievement, version history, create draft (company + per-branch lines), approve. */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { CheckCircle2, Plus } from "lucide-react";
import { useBranches } from "@/api/reference";
import {
  targetKeys,
  targetsApi,
  useAchievement,
  useTargets,
  type TargetVersion,
} from "@/api/targets";
import { dashboardKeys } from "@/api/dashboard";
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
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect, applyServerErrors } from "@/components/crm/forms";
import {
  ConfirmAction,
  DataTable,
  Empty,
  PageHead,
  Section,
  Status,
} from "@/components/crm/ui";
import { date, dateTime, money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { TargetsSection } from "./dashboard";

export function TargetMasterPage() {
  const { isAdmin } = useAuth();
  const branchId = useBranchFilter();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const achievement = useAchievement({ date: todayIST(), branch_id: branchId });
  const versions = useTargets(status || undefined);
  const branches = useBranches();
  const branchName = (id: number | null) =>
    id === null
      ? "Company"
      : (branches.data?.find((b) => b.branch_id === id)?.branch_code ??
        `Branch ${id}`);

  const approve = useApiMutation(
    (v: TargetVersion) => targetsApi.approve(v.target_version_id),
    {
      success: (v) => `${v.version_code} approved`,
      invalidate: [targetKeys.all, dashboardKeys.all],
    },
  );

  const lineText = (v: TargetVersion, id: number | null) => {
    const line = v.lines.find((l) => l.branch_id === id);
    if (!line) return "—";
    return `${line.verified_collections_target === null ? "Not Set" : money(line.verified_collections_target)} · ${line.paid_admissions_target ?? "Not Set"} adm.`;
  };
  const scopes: (number | null)[] = [
    null,
    ...(branches.data ?? []).map((b) => b.branch_id),
  ];

  return (
    <>
      <PageHead
        title="Target Master"
        description="Versioned monthly targets · approving a version supersedes any overlapping approved version"
        actions={
          isAdmin && (
            <Button onClick={() => setOpen(true)}>
              <Plus />
              New target version
            </Button>
          )
        }
      />
      <div className="space-y-4">
        {achievement.isLoading ? null : (
          <TargetsSection
            targets={achievement.data ?? []}
            title="Current achievement"
          />
        )}
        <Section
          title="Target versions"
          subtitle="Version history preserves prior effective periods and approver audit"
          action={
            <NativeSelect
              aria-label="Status filter"
              className="h-8 w-40"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="All statuses"
              options={["Draft", "Approved", "Superseded"].map((s) => ({
                value: s,
                label: s,
              }))}
            />
          }
        >
          <DataTable
            rows={versions.data}
            loading={versions.isLoading}
            error={versions.error}
            onRetry={() => void versions.refetch()}
            rowKey={(v) => v.target_version_id}
            empty={<Empty title="No target versions" />}
            columns={[
              {
                header: "Version",
                cell: (v) => (
                  <span className="font-medium">{v.version_code}</span>
                ),
              },
              {
                header: "Effective period",
                cell: (v) => `${date(v.period_start)} – ${date(v.period_end)}`,
              },
              { header: "Status", cell: (v) => <Status>{v.status}</Status> },
              ...scopes.map((id) => ({
                header: branchName(id),
                cell: (v: TargetVersion) => lineText(v, id),
              })),
              {
                header: "Approved",
                cell: (v) => (v.approved_at ? dateTime(v.approved_at) : "—"),
              },
              { header: "Notes", cell: (v) => v.notes ?? "—" },
              {
                header: "Actions",
                cell: (v) =>
                  isAdmin && v.status === "Draft" ? (
                    <ConfirmAction
                      trigger={
                        <Button
                          size="sm"
                          aria-label={`Approve ${v.version_code}`}
                        >
                          <CheckCircle2 />
                          Approve
                        </Button>
                      }
                      title={`Approve ${v.version_code}?`}
                      description="Any overlapping approved version will be superseded. Dashboards and reports compare against the approved version."
                      action="Approve"
                      onConfirm={() => approve.mutateAsync(v)}
                    />
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Unconfigured measures display Not Set.
          </p>
        </Section>
      </div>
      {isAdmin && <NewTargetDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

type LineValues = { collections: string; admissions: string };
type Values = {
  period_start: string;
  period_end: string;
  notes: string;
  lines: Record<string, LineValues>;
};

function NewTargetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const branches = useBranches();
  const scopes = [
    { key: "company", id: null as number | null, label: "Company" },
    ...(branches.data ?? []).map((b) => ({
      key: String(b.branch_id),
      id: b.branch_id as number | null,
      label: b.branch_name,
    })),
  ];
  const form = useForm<Values>({
    defaultValues: { period_start: "", period_end: "", notes: "", lines: {} },
  });
  const { register, handleSubmit, formState, reset } = form;
  const create = useApiMutation(targetsApi.create, {
    success: (v) => `${v.version_code} saved as Draft`,
    invalidate: [targetKeys.all],
    silentValidation: true,
    onSuccess: () => {
      reset();
      onOpenChange(false);
    },
    onError: (e) => applyServerErrors(form, e),
  });
  const submit = handleSubmit((v) => {
    const lines = scopes
      .map((s) => ({
        s,
        l: v.lines[s.key] ?? { collections: "", admissions: "" },
      }))
      .filter(
        ({ s, l }) =>
          s.id === null || l.collections !== "" || l.admissions !== "",
      )
      .map(({ s, l }) => ({
        branch_id: s.id,
        verified_collections_target:
          l.collections === "" ? null : l.collections,
        paid_admissions_target:
          l.admissions === "" ? null : Number(l.admissions),
      }));
    create.mutate({
      period_start: v.period_start,
      period_end: v.period_end,
      notes: v.notes || null,
      lines,
    });
  });
  const err = (k: "period_start" | "period_end" | "notes") =>
    formState.errors[k]?.message;
  const linesError = (
    formState.errors as Record<string, { message?: string } | undefined>
  )["lines"]?.message;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New target version</DialogTitle>
          <DialogDescription>
            Saved as Draft. Leave a measure blank to keep it Not Set. A Founder
            / Admin approves it.
          </DialogDescription>
        </DialogHeader>
        <form id="target-form" onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Period start"
              htmlFor="tg-start"
              error={err("period_start")}
            >
              <Input
                id="tg-start"
                type="date"
                {...register("period_start", { required: "Required" })}
              />
            </Field>
            <Field
              label="Period end"
              htmlFor="tg-end"
              error={err("period_end")}
            >
              <Input
                id="tg-end"
                type="date"
                {...register("period_end", { required: "Required" })}
              />
            </Field>
          </div>
          <div className="table-wrap">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Verified collections target (₹)</th>
                  <th>Paid admissions target</th>
                </tr>
              </thead>
              <tbody>
                {scopes.map((s) => (
                  <tr key={s.key}>
                    <td className="font-medium">{s.label}</td>
                    <td>
                      <Input
                        aria-label={`${s.label} collections target`}
                        inputMode="decimal"
                        {...register(`lines.${s.key}.collections` as const)}
                      />
                    </td>
                    <td>
                      <Input
                        aria-label={`${s.label} admissions target`}
                        type="number"
                        min={0}
                        {...register(`lines.${s.key}.admissions` as const)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {linesError && (
            <p className="text-xs text-destructive">{linesError}</p>
          )}
          <Field label="Notes" htmlFor="tg-notes">
            <Textarea id="tg-notes" {...register("notes")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="target-form" disabled={create.isPending}>
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
