/** Admin operations tabs: integrations, incidents, active sessions, deletion requests, audit log. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Plus, Save } from "lucide-react";
import {
  DELETABLE_TYPES,
  DELETION_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INTEGRATION_STATES,
  VERIFICATION_STATES,
  adminApi,
  adminKeys,
  type AuditFilters,
  type Incident,
  type Integration,
} from "@/api/admin";
import { useStaff } from "@/api/reference";
import { useAuth } from "@/auth/auth";
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
  Pagination,
  Section,
  Status,
} from "@/components/crm/ui";
import { dateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

const opt = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x }));

function useUserNames() {
  const staff = useStaff(undefined, undefined);
  return (id: number | null | undefined) =>
    id
      ? (staff.data?.find((s) => s.user_id === id)?.full_name ?? `User #${id}`)
      : "—";
}

// ---------------------------------------------------------------- integrations & incidents

export function IntegrationsTab() {
  const integrations = useQuery({
    queryKey: adminKeys.integrations,
    queryFn: adminApi.integrations,
  });
  return (
    <div className="space-y-4">
      <Section
        title="Integration status"
        subtitle="Record the real state of each external service · nothing here sends messages"
      >
        <DataTable
          rows={integrations.data}
          loading={integrations.isLoading}
          error={integrations.error}
          onRetry={() => void integrations.refetch()}
          rowKey={(i) => i.service_code}
          columns={[
            {
              header: "Service",
              cell: (i) => (
                <span>
                  <span className="font-medium">{i.service_name}</span>
                  <small className="block font-mono text-muted-foreground">
                    {i.service_code}
                  </small>
                </span>
              ),
            },
            {
              header: "State",
              cell: (i) => (
                <IntegrationSelect
                  integration={i}
                  field="state"
                  options={INTEGRATION_STATES}
                />
              ),
            },
            {
              header: "Verification",
              cell: (i) => (
                <IntegrationSelect
                  integration={i}
                  field="verification"
                  options={VERIFICATION_STATES}
                />
              ),
            },
            {
              header: "Last successful test / notes",
              cell: (i) => <IntegrationNotes integration={i} />,
            },
            { header: "Updated", cell: (i) => dateTime(i.updated_at) },
          ]}
        />
      </Section>
      <IncidentsSection />
    </div>
  );
}

function IntegrationSelect({
  integration,
  field,
  options,
}: {
  integration: Integration;
  field: "state" | "verification";
  options: readonly string[];
}) {
  const save = useApiMutation(
    (v: string) =>
      adminApi.updateIntegration(integration.service_code, { [field]: v }),
    {
      success: `${integration.service_name} updated`,
      invalidate: [adminKeys.integrations],
    },
  );
  return (
    <NativeSelect
      className="h-8 w-44"
      aria-label={`${integration.service_name} ${field}`}
      value={integration[field]}
      onChange={(e) => save.mutate(e.target.value)}
      options={opt(options)}
    />
  );
}

function IntegrationNotes({ integration }: { integration: Integration }) {
  const [tested, setTested] = useState(
    toLocalInput(integration.last_successful_test_at),
  );
  const [notes, setNotes] = useState(integration.notes ?? "");
  useEffect(() => {
    setTested(toLocalInput(integration.last_successful_test_at));
    setNotes(integration.notes ?? "");
  }, [integration.last_successful_test_at, integration.notes]);
  const save = useApiMutation(
    () =>
      adminApi.updateIntegration(integration.service_code, {
        last_successful_test_at: fromLocalInput(tested),
        notes: notes || null,
      }),
    {
      success: `${integration.service_name} updated`,
      invalidate: [adminKeys.integrations],
    },
  );
  const changed =
    tested !== toLocalInput(integration.last_successful_test_at) ||
    notes !== (integration.notes ?? "");
  return (
    <div className="flex min-w-96 flex-wrap gap-2">
      <Input
        type="datetime-local"
        className="h-8 w-52"
        aria-label={`${integration.service_name} last successful test`}
        value={tested}
        onChange={(e) => setTested(e.target.value)}
      />
      <Input
        className="h-8 min-w-32 flex-1"
        aria-label={`${integration.service_name} notes`}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || save.isPending}
        onClick={() => save.mutate(undefined)}
        aria-label={`Save ${integration.service_name}`}
      >
        <Save />
      </Button>
    </div>
  );
}

function IncidentsSection() {
  const [filters, setFilters] = useState<{
    page: number;
    status?: string;
    severity?: string;
  }>({ page: 1 });
  const [dialog, setDialog] = useState<Incident | "new" | null>(null);
  const incidents = useQuery({
    queryKey: [...adminKeys.incidents, filters],
    queryFn: () => adminApi.incidents(filters),
  });
  const nameOf = useUserNames();
  return (
    <Section
      title="Incident register"
      action={
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label="Incident status filter"
            className="h-8 w-36"
            placeholder="Any status"
            value={filters.status ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                page: 1,
                status: e.target.value || undefined,
              })
            }
            options={opt(INCIDENT_STATUSES)}
          />
          <NativeSelect
            aria-label="Incident severity filter"
            className="h-8 w-36"
            placeholder="Any severity"
            value={filters.severity ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                page: 1,
                severity: e.target.value || undefined,
              })
            }
            options={opt(INCIDENT_SEVERITIES)}
          />
          <Button size="sm" onClick={() => setDialog("new")}>
            <Plus />
            Log incident
          </Button>
        </div>
      }
    >
      <DataTable
        rows={incidents.data?.data}
        loading={incidents.isLoading}
        error={incidents.error}
        onRetry={() => void incidents.refetch()}
        rowKey={(i) => i.incident_id}
        onRowClick={(i) => setDialog(i)}
        empty={<Empty title="No incidents" />}
        columns={[
          {
            header: "Incident",
            cell: (i) => (
              <span>
                <span className="font-medium">{i.incident_code}</span>
                <small className="block text-muted-foreground">{i.title}</small>
              </span>
            ),
          },
          { header: "Severity", cell: (i) => <Status>{i.severity}</Status> },
          {
            header: "Owner",
            cell: (i) =>
              i.owner_user_id ? nameOf(i.owner_user_id) : "Owner pending",
          },
          { header: "Status", cell: (i) => <Status>{i.status}</Status> },
          { header: "Detected", cell: (i) => dateTime(i.detected_at) },
          {
            header: "Backup reference",
            cell: (i) => i.backup_reference ?? "—",
          },
        ]}
      />
      <Pagination
        meta={incidents.data?.meta}
        onPage={(page) => setFilters({ ...filters, page })}
      />
      <IncidentDialog incident={dialog} onClose={() => setDialog(null)} />
    </Section>
  );
}

type IncidentValues = {
  title: string;
  description: string;
  severity: string;
  status: string;
  owner_user_id: string;
  root_cause: string;
  backup_reference: string;
};

function IncidentDialog({
  incident,
  onClose,
}: {
  incident: Incident | "new" | null;
  onClose: () => void;
}) {
  const existing = incident && incident !== "new" ? incident : null;
  const staff = useStaff(undefined, [
    "FOUNDER_CEO",
    "SUPER_ADMIN",
    "BRANCH_MANAGER",
  ]);
  const defaults = (): IncidentValues => ({
    title: existing?.title ?? "",
    description: existing?.description ?? "",
    severity: existing?.severity ?? "Not Set",
    status: existing?.status ?? "Open",
    owner_user_id: existing?.owner_user_id
      ? String(existing.owner_user_id)
      : "",
    root_cause: existing?.root_cause ?? "",
    backup_reference: existing?.backup_reference ?? "",
  });
  const form = useForm<IncidentValues>({ defaultValues: defaults() });
  const { register, handleSubmit, formState, reset } = form;
  useEffect(() => {
    if (incident) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident]);
  const save = useApiMutation(
    (v: IncidentValues) => {
      const body: Partial<Incident> = {
        title: v.title.trim(),
        description: v.description || null,
        severity: v.severity,
        status: v.status,
        owner_user_id: v.owner_user_id ? Number(v.owner_user_id) : null,
        root_cause: v.root_cause || null,
        backup_reference: v.backup_reference || null,
      };
      return existing
        ? adminApi.updateIncident(existing.incident_id, body)
        : adminApi.createIncident(body);
    },
    {
      success: (i) => `${i.incident_code} saved`,
      invalidate: [adminKeys.incidents],
      silentValidation: true,
      onSuccess: onClose,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <Dialog open={Boolean(incident)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? `${existing.incident_code} · ${existing.title}`
              : "Log incident"}
          </DialogTitle>
          {existing && (
            <DialogDescription>
              Detected {dateTime(existing.detected_at)}
              {existing.resolved_at
                ? ` · resolved ${dateTime(existing.resolved_at)}`
                : ""}
            </DialogDescription>
          )}
        </DialogHeader>
        <form
          id="incident-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={handleSubmit((v) => save.mutate(v))}
        >
          <Field
            label="Title"
            htmlFor="in-title"
            error={formState.errors.title?.message}
            className="sm:col-span-2"
          >
            <Input
              id="in-title"
              {...register("title", { required: "Required" })}
            />
          </Field>
          <Field label="Severity" htmlFor="in-sev">
            <NativeSelect
              id="in-sev"
              options={opt(INCIDENT_SEVERITIES)}
              {...register("severity")}
            />
          </Field>
          <Field label="Status" htmlFor="in-status">
            <NativeSelect
              id="in-status"
              options={opt(INCIDENT_STATUSES)}
              {...register("status")}
            />
          </Field>
          <Field label="Owner" htmlFor="in-owner">
            <NativeSelect
              id="in-owner"
              placeholder="Owner pending"
              options={(staff.data ?? []).map((s) => ({
                value: s.user_id,
                label: s.full_name,
              }))}
              {...register("owner_user_id")}
            />
          </Field>
          <Field label="Backup reference" htmlFor="in-backup">
            <Input id="in-backup" {...register("backup_reference")} />
          </Field>
          <Field
            label="Description"
            htmlFor="in-desc"
            className="sm:col-span-2"
          >
            <Textarea id="in-desc" {...register("description")} />
          </Field>
          <Field label="Root cause" htmlFor="in-root" className="sm:col-span-2">
            <Textarea id="in-root" {...register("root_cause")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="incident-form" disabled={save.isPending}>
            Save incident
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- security: sessions & deletion requests

export function SecurityTab() {
  const sessions = useQuery({
    queryKey: adminKeys.sessions,
    queryFn: () => adminApi.sessions(),
  });
  const settings = useQuery({
    queryKey: adminKeys.settings,
    queryFn: adminApi.settings,
  });
  const setting = (key: string) =>
    settings.data?.find((s) => s.key === key)?.value;
  const [shown, setShown] = useState(20);
  const revoke = useApiMutation(adminApi.revokeSession, {
    success: "Session signed out",
    invalidate: [adminKeys.sessions],
  });
  return (
    <div className="space-y-4">
      <Section
        title="Active sessions"
        subtitle={
          settings.data
            ? `Inactivity timeout ${setting("session_idle_minutes")} min · maximum session ${setting("session_max_hours")} h · fresh sign-in for sensitive actions within ${setting("fresh_auth_minutes")} min`
            : undefined
        }
      >
        <DataTable
          rows={sessions.data?.slice(0, shown)}
          loading={sessions.isLoading}
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
          rowKey={(s) => s.session_id}
          empty={<Empty title="No active sessions" />}
          columns={[
            {
              header: "User",
              cell: (s) => (
                <span>
                  <span className="font-medium">{s.user.full_name}</span>
                  <small className="block text-muted-foreground">
                    {s.user.email}
                  </small>
                </span>
              ),
            },
            { header: "Signed in", cell: (s) => dateTime(s.created_at) },
            { header: "Last seen", cell: (s) => dateTime(s.last_seen_at) },
            { header: "Expires", cell: (s) => dateTime(s.expires_at) },
            {
              header: "IP / device",
              cell: (s) => (
                <span className="break-all text-xs">
                  {[s.ip_address, s.user_agent].filter(Boolean).join(" · ") ||
                    "—"}
                </span>
              ),
            },
            {
              header: "Actions",
              cell: (s) =>
                s.current ? (
                  <Status kind="good">This session</Status>
                ) : (
                  <ConfirmAction
                    trigger={
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Sign out ${s.user.full_name} session`}
                      >
                        Sign out
                      </Button>
                    }
                    title={`Sign out ${s.user.full_name}?`}
                    description="This session ends immediately."
                    action="Sign out"
                    destructive
                    onConfirm={() => revoke.mutateAsync(s.session_id)}
                  />
                ),
            },
          ]}
        />
        {sessions.data && sessions.data.length > shown && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {shown} of {sessions.data.length} sessions (most recent
              first)
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShown(shown + 50)}
            >
              Show more
            </Button>
          </div>
        )}
      </Section>
      <DeletionRequests />
    </div>
  );
}

function DeletionRequests() {
  const { profile } = useAuth();
  const nameOf = useUserNames();
  const [filters, setFilters] = useState<{ page: number; status?: string }>({
    page: 1,
  });
  const rows = useQuery({
    queryKey: [...adminKeys.deletions, filters],
    queryFn: () => adminApi.deletions(filters),
  });
  const form = useForm({
    defaultValues: { entity_type: "saved_view", entity_id: "", reason: "" },
  });
  const { register, handleSubmit, formState, reset } = form;
  const invalidate = [adminKeys.deletions, adminKeys.audit];
  const request = useApiMutation(
    (v: { entity_type: string; entity_id: string; reason: string }) =>
      adminApi.requestDeletion({
        entity_type: v.entity_type,
        entity_id: Number(v.entity_id),
        reason: v.reason.trim(),
      }),
    {
      success: "Deletion requested · an independent admin must approve it",
      invalidate,
      silentValidation: true,
      onSuccess: () => reset(),
      onError: (e) => applyServerErrors(form, e),
    },
  );
  const approve = useApiMutation(adminApi.approveDeletion, {
    success: "Deletion approved",
    invalidate,
  });
  const reject = useApiMutation(adminApi.rejectDeletion, {
    success: "Deletion rejected",
    invalidate,
  });
  const execute = useApiMutation(adminApi.executeDeletion, {
    success: "Record deleted",
    invalidate,
  });
  const me = profile?.user.user_id;
  return (
    <Section
      title="Deletion requests"
      subtitle="Sensitive deletion needs an independent approver (never the requester), then execution"
      action={
        <NativeSelect
          aria-label="Deletion status filter"
          className="h-8 w-36"
          placeholder="Any status"
          value={filters.status ?? ""}
          onChange={(e) =>
            setFilters({ page: 1, status: e.target.value || undefined })
          }
          options={opt(DELETION_STATUSES)}
        />
      }
    >
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[170px_120px_1fr_auto] sm:items-end"
        onSubmit={handleSubmit((v) => request.mutate(v))}
      >
        <Field
          label="Record type"
          htmlFor="dr-type"
          error={formState.errors.entity_type?.message}
        >
          <NativeSelect
            id="dr-type"
            options={DELETABLE_TYPES.map((t) => ({
              value: t,
              label: t.replace(/_/g, " "),
            }))}
            {...register("entity_type")}
          />
        </Field>
        <Field
          label="Record ID"
          htmlFor="dr-id"
          error={formState.errors.entity_id?.message}
        >
          <Input
            id="dr-id"
            type="number"
            min={1}
            {...register("entity_id", { required: "Required" })}
          />
        </Field>
        <Field
          label="Deletion reason"
          htmlFor="dr-reason"
          error={formState.errors.reason?.message}
        >
          <Input
            id="dr-reason"
            {...register("reason", { required: "Required" })}
          />
        </Field>
        <Button type="submit" disabled={request.isPending}>
          Request deletion
        </Button>
      </form>
      <DataTable
        rows={rows.data?.data}
        loading={rows.isLoading}
        error={rows.error}
        onRetry={() => void rows.refetch()}
        rowKey={(r) => r.request_id}
        empty={<Empty title="No deletion requests" />}
        columns={[
          { header: "Request", cell: (r) => `#${r.request_id}` },
          {
            header: "Record",
            cell: (r) => `${r.entity_type.replace(/_/g, " ")} #${r.entity_id}`,
          },
          { header: "Reason", cell: (r) => r.reason },
          {
            header: "Requested",
            cell: (r) =>
              `${nameOf(r.requested_by)} · ${dateTime(r.requested_at)}`,
          },
          { header: "Status", cell: (r) => <Status>{r.status}</Status> },
          {
            header: "Decided",
            cell: (r) =>
              r.decided_by
                ? `${nameOf(r.decided_by)} · ${dateTime(r.decided_at)}`
                : "—",
          },
          {
            header: "Actions",
            cell: (r) =>
              r.status === "Pending" ? (
                r.requested_by === me ? (
                  <span className="text-xs text-muted-foreground">
                    Awaiting another admin
                  </span>
                ) : (
                  <span className="flex gap-2">
                    <ConfirmAction
                      trigger={
                        <Button
                          size="sm"
                          aria-label={`Approve deletion ${r.request_id}`}
                        >
                          Approve
                        </Button>
                      }
                      title={`Approve deleting ${r.entity_type} #${r.entity_id}?`}
                      description={r.reason}
                      action="Approve"
                      onConfirm={() => approve.mutateAsync(r.request_id)}
                    />
                    <ConfirmAction
                      trigger={
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Reject deletion ${r.request_id}`}
                        >
                          Reject
                        </Button>
                      }
                      title={`Reject deletion request #${r.request_id}?`}
                      action="Reject"
                      destructive
                      onConfirm={() => reject.mutateAsync(r.request_id)}
                    />
                  </span>
                )
              ) : r.status === "Approved" ? (
                <ConfirmAction
                  trigger={
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label={`Execute deletion ${r.request_id}`}
                    >
                      Execute
                    </Button>
                  }
                  title={`Permanently delete ${r.entity_type} #${r.entity_id}?`}
                  description="This cannot be undone. The audit log keeps a snapshot."
                  action="Delete permanently"
                  destructive
                  onConfirm={() => execute.mutateAsync(r.request_id)}
                />
              ) : (
                "—"
              ),
          },
        ]}
      />
      <Pagination
        meta={rows.data?.meta}
        onPage={(page) => setFilters({ ...filters, page })}
      />
    </Section>
  );
}

// ---------------------------------------------------------------- audit log

export function AuditTab() {
  const nameOf = useUserNames();
  const [filters, setFilters] = useState<AuditFilters>({ page: 1 });
  const [draft, setDraft] = useState({
    entity_type: "",
    entity_id: "",
    action: "",
  });
  const rows = useQuery({
    queryKey: [...adminKeys.audit, filters],
    queryFn: () => adminApi.auditLog(filters),
  });
  return (
    <Section
      title="Audit log"
      subtitle="Append-only record of sensitive actions"
    >
      <form
        className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({
            page: 1,
            entity_type: draft.entity_type || undefined,
            entity_id: draft.entity_id || undefined,
            action: draft.action || undefined,
          });
        }}
      >
        <Field label="Action" htmlFor="au-action">
          <Input
            id="au-action"
            placeholder="e.g. LOGIN, USER_CREATED"
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          />
        </Field>
        <Field label="Entity type" htmlFor="au-type">
          <Input
            id="au-type"
            placeholder="e.g. user, offer, lead"
            value={draft.entity_type}
            onChange={(e) =>
              setDraft({ ...draft, entity_type: e.target.value })
            }
          />
        </Field>
        <Field label="Entity ID" htmlFor="au-id">
          <Input
            id="au-id"
            value={draft.entity_id}
            onChange={(e) => setDraft({ ...draft, entity_id: e.target.value })}
          />
        </Field>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <DataTable
        rows={rows.data?.data}
        loading={rows.isLoading}
        error={rows.error}
        onRetry={() => void rows.refetch()}
        rowKey={(r) => r.audit_id}
        empty={<Empty title="No audit entries match" />}
        columns={[
          { header: "When", cell: (r) => dateTime(r.occurred_at) },
          { header: "Actor", cell: (r) => nameOf(r.actor_user_id) },
          {
            header: "Action",
            cell: (r) => <span className="font-mono text-xs">{r.action}</span>,
          },
          {
            header: "Record",
            cell: (r) =>
              `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ""}`,
          },
          { header: "Reason", cell: (r) => r.reason ?? "—" },
          {
            header: "Change",
            cell: (r) =>
              r.old_values || r.new_values ? (
                <details className="max-w-md text-xs">
                  <summary className="cursor-pointer text-primary">
                    View
                  </summary>
                  {r.old_values != null && (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                      old: {JSON.stringify(r.old_values, null, 1)}
                    </pre>
                  )}
                  {r.new_values != null && (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                      new: {JSON.stringify(r.new_values, null, 1)}
                    </pre>
                  )}
                </details>
              ) : (
                "—"
              ),
          },
          { header: "IP", cell: (r) => r.ip_address ?? "—" },
        ]}
      />
      <Pagination
        meta={rows.data?.meta}
        onPage={(page) => setFilters({ ...filters, page })}
      />
    </Section>
  );
}
