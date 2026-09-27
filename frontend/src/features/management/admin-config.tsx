/** Admin configuration tabs: settings, branches (details / shifts / holidays), lookups, concession limits,
 * notification rules and branch channels. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Plus, Save, Trash2 } from "lucide-react";
import {
  INTEGRATION_MODES,
  LOOKUP_TYPES,
  adminApi,
  adminKeys,
  useSettings,
  type BranchChannel,
  type ConcessionLimit,
  type LookupRow,
  type NotificationRule,
  type Setting,
  type Shift,
} from "@/api/admin";
import { useBranches, useRoles, type Branch } from "@/api/reference";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  LookupSelect,
  NativeSelect,
  applyServerErrors,
} from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, Section } from "@/components/crm/ui";
import { date, dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

// ---------------------------------------------------------------- settings

export function SettingsTab() {
  const settings = useSettings();
  return (
    <Section
      title="System settings"
      subtitle="Each setting keeps its type · saving asks for your password"
    >
      <DataTable
        rows={settings.data}
        loading={settings.isLoading}
        error={settings.error}
        onRetry={() => void settings.refetch()}
        rowKey={(s) => s.key}
        columns={[
          {
            header: "Setting",
            cell: (s) => (
              <span>
                <span className="font-medium">{s.description ?? s.key}</span>
                <small className="block font-mono text-muted-foreground">
                  {s.key}
                </small>
              </span>
            ),
          },
          { header: "Value", cell: (s) => <SettingEditor setting={s} /> },
          { header: "Updated", cell: (s) => dateTime(s.updated_at) },
        ]}
      />
    </Section>
  );
}

function SettingEditor({ setting }: { setting: Setting }) {
  const [value, setValue] = useState(String(setting.value));
  useEffect(() => setValue(String(setting.value)), [setting.value]);
  const save = useApiMutation(
    (v: string | number | boolean) =>
      adminApi.updateSettings({ [setting.key]: v }),
    {
      success: "Setting saved",
      invalidate: [adminKeys.settings],
    },
  );
  const typed = (): string | number | boolean =>
    typeof setting.value === "number"
      ? Number(value)
      : typeof setting.value === "boolean"
        ? value === "true"
        : value;
  const changed = String(setting.value) !== value;
  if (typeof setting.value === "boolean")
    return (
      <Switch
        checked={setting.value}
        onCheckedChange={(v) => save.mutate(v)}
        aria-label={setting.key}
      />
    );
  return (
    <div className="flex min-w-48 gap-2">
      <Input
        aria-label={setting.key}
        className="h-8"
        type={typeof setting.value === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || save.isPending}
        onClick={() => save.mutate(typed())}
        aria-label={`Save ${setting.key}`}
      >
        <Save />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- branches

const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export function BranchesTab() {
  const branches = useBranches();
  const [branchId, setBranchId] = useState<number | null>(null);
  const current =
    branches.data?.find((b) => b.branch_id === branchId) ?? branches.data?.[0];
  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <Field label="Branch" htmlFor="br-select">
          <NativeSelect
            id="br-select"
            value={current?.branch_id ?? ""}
            onChange={(e) => setBranchId(Number(e.target.value))}
            options={(branches.data ?? []).map((b) => ({
              value: b.branch_id,
              label: `${b.branch_name} (${b.branch_code})`,
            }))}
          />
        </Field>
      </div>
      {current && (
        <div className="grid gap-4 lg:grid-cols-2">
          <BranchDetails branch={current} />
          <ShiftsEditor branchId={current.branch_id} />
        </div>
      )}
      <HolidaysSection />
    </div>
  );
}

function BranchDetails({ branch }: { branch: Branch }) {
  const defaults = {
    branch_name: branch.branch_name,
    city: branch.city ?? "",
    address: branch.address ?? "",
    phone: branch.phone ?? "",
    email: branch.email ?? "",
  };
  const form = useForm({ defaultValues: defaults });
  const { register, handleSubmit, formState, reset } = form;
  useEffect(() => reset(defaults), [branch.branch_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useApiMutation(
    (v: typeof defaults) =>
      adminApi.updateBranch(branch.branch_id, {
        branch_name: v.branch_name,
        city: v.city,
        address: v.address || null,
        phone: v.phone || null,
        email: v.email || null,
      }),
    {
      success: "Branch details saved",
      invalidate: [["branches"]],
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <Section
      title="Branch details"
      subtitle={`${branch.branch_code} · receipt prefix ${branch.receipt_prefix}`}
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={handleSubmit((v) => save.mutate(v))}
      >
        <Field
          label="Branch name"
          htmlFor="bd-name"
          error={formState.errors.branch_name?.message}
        >
          <Input
            id="bd-name"
            {...register("branch_name", { required: "Required" })}
          />
        </Field>
        <Field
          label="City"
          htmlFor="bd-city"
          error={formState.errors.city?.message}
        >
          <Input id="bd-city" {...register("city", { required: "Required" })} />
        </Field>
        <Field label="Address" htmlFor="bd-address" className="sm:col-span-2">
          <Input id="bd-address" {...register("address")} />
        </Field>
        <Field
          label="Branch phone"
          htmlFor="bd-phone"
          error={formState.errors.phone?.message}
        >
          <Input id="bd-phone" {...register("phone")} />
        </Field>
        <Field
          label="Branch email"
          htmlFor="bd-email"
          error={formState.errors.email?.message}
        >
          <Input id="bd-email" type="email" {...register("email")} />
        </Field>
        <div className="sm:col-span-2">
          <Button
            type="submit"
            size="sm"
            disabled={save.isPending || !formState.isDirty}
          >
            Save details
          </Button>
        </div>
      </form>
    </Section>
  );
}

type ShiftRow = { open: boolean; opens_at: string; closes_at: string };

function ShiftsEditor({ branchId }: { branchId: number }) {
  const shifts = useQuery({
    queryKey: adminKeys.shifts(branchId),
    queryFn: () => adminApi.shifts(branchId),
  });
  const [rows, setRows] = useState<ShiftRow[]>([]);
  useEffect(() => {
    if (shifts.data)
      setRows(
        DAY_NAMES.map((_, i) => {
          const s = shifts.data.find((x) => x.day_of_week === i + 1);
          return s
            ? { open: true, opens_at: s.opens_at, closes_at: s.closes_at }
            : { open: false, opens_at: "09:00", closes_at: "19:00" };
        }),
      );
  }, [shifts.data]);
  const save = useApiMutation(
    () =>
      adminApi.replaceShifts(
        branchId,
        rows.flatMap((r, i): Shift[] =>
          r.open
            ? [
                {
                  day_of_week: i + 1,
                  opens_at: r.opens_at,
                  closes_at: r.closes_at,
                },
              ]
            : [],
        ),
      ),
    {
      success: "Shifts saved · SLA staffed-time uses these hours",
      invalidate: [adminKeys.shifts(branchId)],
    },
  );
  const set = (i: number, patch: Partial<ShiftRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Section
      title="Shifts / staffed hours"
      subtitle="Used for SLA staffed-time calculations"
    >
      {shifts.isLoading ? null : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div
              key={DAY_NAMES[i]}
              className="grid grid-cols-[110px_auto_1fr_1fr] items-center gap-2 text-sm"
            >
              <span className="font-medium">{DAY_NAMES[i]}</span>
              <Switch
                checked={r.open}
                onCheckedChange={(v) => set(i, { open: v })}
                aria-label={`${DAY_NAMES[i]} open`}
              />
              <Input
                type="time"
                className="h-8"
                disabled={!r.open}
                value={r.opens_at}
                onChange={(e) => set(i, { opens_at: e.target.value })}
                aria-label={`${DAY_NAMES[i]} opens`}
              />
              <Input
                type="time"
                className="h-8"
                disabled={!r.open}
                value={r.closes_at}
                onChange={(e) => set(i, { closes_at: e.target.value })}
                aria-label={`${DAY_NAMES[i]} closes`}
              />
            </div>
          ))}
          <Button
            size="sm"
            className="mt-2"
            onClick={() => save.mutate(undefined)}
            disabled={save.isPending}
          >
            Save shifts
          </Button>
        </div>
      )}
    </Section>
  );
}

function HolidaysSection() {
  const branches = useBranches();
  const [year, setYear] = useState(new Date().getFullYear());
  const holidays = useQuery({
    queryKey: [...adminKeys.holidays, year],
    queryFn: () => adminApi.holidays({ year }),
  });
  const form = useForm({
    defaultValues: { holiday_date: "", name: "", branch_id: "" },
  });
  const { register, handleSubmit, formState, reset } = form;
  const create = useApiMutation(adminApi.createHoliday, {
    success: "Holiday added",
    invalidate: [adminKeys.holidays],
    silentValidation: true,
    onSuccess: () => reset(),
    onError: (e) => applyServerErrors(form, e),
  });
  const remove = useApiMutation(adminApi.deleteHoliday, {
    success: "Holiday removed",
    invalidate: [adminKeys.holidays],
  });
  const branchName = (id: number | null) =>
    id === null
      ? "All branches"
      : (branches.data?.find((b) => b.branch_id === id)?.branch_name ?? id);
  return (
    <Section
      title="Holidays"
      subtitle="Excluded from SLA staffed time"
      action={
        <NativeSelect
          aria-label="Year"
          className="h-8 w-28"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          options={[year - 1, year, year + 1].map((y) => ({
            value: y,
            label: String(y),
          }))}
        />
      }
    >
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[160px_1fr_180px_auto] sm:items-end"
        onSubmit={handleSubmit((v) =>
          create.mutate({
            holiday_date: v.holiday_date,
            name: v.name.trim(),
            branch_id: v.branch_id ? Number(v.branch_id) : null,
          }),
        )}
      >
        <Field
          label="Holiday date"
          htmlFor="hd-date"
          error={formState.errors.holiday_date?.message}
        >
          <Input
            id="hd-date"
            type="date"
            {...register("holiday_date", { required: "Required" })}
          />
        </Field>
        <Field
          label="Holiday name"
          htmlFor="hd-name"
          error={formState.errors.name?.message}
        >
          <Input id="hd-name" {...register("name", { required: "Required" })} />
        </Field>
        <Field label="Applies to" htmlFor="hd-branch">
          <NativeSelect
            id="hd-branch"
            placeholder="All branches"
            options={(branches.data ?? []).map((b) => ({
              value: b.branch_id,
              label: b.branch_name,
            }))}
            {...register("branch_id")}
          />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          <Plus />
          Add holiday
        </Button>
      </form>
      <DataTable
        rows={holidays.data}
        loading={holidays.isLoading}
        error={holidays.error}
        rowKey={(h) => h.holiday_id}
        empty={<Empty title={`No holidays recorded for ${year}`} />}
        columns={[
          { header: "Date", cell: (h) => date(h.holiday_date) },
          { header: "Name", cell: (h) => h.name },
          { header: "Branch", cell: (h) => branchName(h.branch_id) },
          {
            header: "Actions",
            cell: (h) => (
              <ConfirmAction
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove holiday ${h.name}`}
                  >
                    <Trash2 />
                  </Button>
                }
                title={`Remove ${h.name}?`}
                action="Remove"
                destructive
                onConfirm={() => remove.mutateAsync(h.holiday_id)}
              />
            ),
          },
        ]}
      />
    </Section>
  );
}

// ---------------------------------------------------------------- lookups

export function LookupsTab() {
  const [type, setType] = useState(LOOKUP_TYPES[0]!.type);
  const meta = LOOKUP_TYPES.find((t) => t.type === type)!;
  const rows = useQuery({
    queryKey: adminKeys.lookup(type),
    queryFn: () => adminApi.lookup(type),
  });
  const form = useForm({
    defaultValues: { code: "", label: "", sort_order: "0" },
  });
  const { register, handleSubmit, formState, reset } = form;
  const create = useApiMutation(
    (v: { code: string; label: string; sort_order: string }) =>
      adminApi.createLookup(type, {
        code: v.code.trim(),
        label: v.label.trim(),
        sort_order: Number(v.sort_order || 0),
      }),
    {
      success: (r) => `${r.label} added`,
      invalidate: [["lookups"]],
      silentValidation: true,
      onSuccess: () => reset(),
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <Section
      title="Lookups"
      subtitle="Dropdown values used across the CRM · deactivate instead of deleting"
      action={
        <NativeSelect
          aria-label="Lookup type"
          className="h-8 w-52"
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={LOOKUP_TYPES.map((t) => ({ value: t.type, label: t.label }))}
        />
      }
    >
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[180px_1fr_110px_auto] sm:items-end"
        onSubmit={handleSubmit((v) => create.mutate(v))}
      >
        <Field
          label="Code"
          htmlFor="lk-code"
          error={formState.errors.code?.message}
          hint="CAPITALS_AND_UNDERSCORES"
        >
          <Input id="lk-code" {...register("code", { required: "Required" })} />
        </Field>
        <Field
          label="Label"
          htmlFor="lk-label"
          error={formState.errors.label?.message}
        >
          <Input
            id="lk-label"
            {...register("label", { required: "Required" })}
          />
        </Field>
        <Field label="Sort order" htmlFor="lk-sort">
          <Input
            id="lk-sort"
            type="number"
            min={0}
            {...register("sort_order")}
          />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          <Plus />
          Add value
        </Button>
      </form>
      <DataTable
        rows={rows.data}
        loading={rows.isLoading}
        error={rows.error}
        rowKey={(r) => r.id}
        empty={<Empty title="No values" />}
        columns={[
          {
            header: "Code",
            cell: (r) => <span className="font-mono text-xs">{r.code}</span>,
          },
          {
            header: "Label / order",
            cell: (r) => <LookupEditor type={type} row={r} />,
          },
          ...meta.extras.map((extra) => ({
            header: extra.replace(/_/g, " "),
            cell: (r: LookupRow) => (
              <LookupFlag type={type} row={r} field={extra} />
            ),
          })),
          {
            header: "Active",
            cell: (r) => <LookupFlag type={type} row={r} field="is_active" />,
          },
        ]}
      />
    </Section>
  );
}

function LookupEditor({ type, row }: { type: string; row: LookupRow }) {
  const [label, setLabel] = useState(row.label);
  const [order, setOrder] = useState(String(row.sort_order));
  useEffect(() => {
    setLabel(row.label);
    setOrder(String(row.sort_order));
  }, [row.label, row.sort_order]);
  const save = useApiMutation(
    () =>
      adminApi.updateLookup(type, row.id, {
        label: label.trim(),
        sort_order: Number(order || 0),
      }),
    {
      success: "Saved",
      invalidate: [["lookups"]],
    },
  );
  const changed = label !== row.label || order !== String(row.sort_order);
  return (
    <div className="flex min-w-64 gap-2">
      <Input
        className="h-8"
        aria-label={`Label for ${row.code}`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Input
        className="h-8 w-16"
        type="number"
        min={0}
        aria-label={`Sort order for ${row.code}`}
        value={order}
        onChange={(e) => setOrder(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || !label.trim() || save.isPending}
        onClick={() => save.mutate(undefined)}
        aria-label={`Save ${row.code}`}
      >
        <Save />
      </Button>
    </div>
  );
}

function LookupFlag({
  type,
  row,
  field,
}: {
  type: string;
  row: LookupRow;
  field: string;
}) {
  const save = useApiMutation(
    (v: boolean) => adminApi.updateLookup(type, row.id, { [field]: v }),
    { success: "Saved", invalidate: [["lookups"]] },
  );
  return (
    <Switch
      checked={Boolean(row[field])}
      onCheckedChange={(v) => save.mutate(v)}
      aria-label={`${field} ${row.code}`}
    />
  );
}

// ---------------------------------------------------------------- concession limits

type LimitRow = {
  role_code: string;
  role_name: string;
  max_percent: string;
  max_amount: string;
};

export function FinanceTab() {
  const limits = useQuery({
    queryKey: adminKeys.concession,
    queryFn: adminApi.concessionLimits,
  });
  const roles = useRoles();
  const [rows, setRows] = useState<LimitRow[]>([]);
  const [adding, setAdding] = useState("");
  useEffect(() => {
    if (limits.data)
      setRows(
        limits.data.map((l: ConcessionLimit) => ({
          role_code: l.role_code,
          role_name: l.role_name,
          max_percent: l.max_percent ?? "",
          max_amount: l.max_amount ?? "",
        })),
      );
  }, [limits.data]);
  const save = useApiMutation(
    () =>
      adminApi.replaceConcessionLimits(
        rows.map((r) => ({
          role_code: r.role_code,
          max_percent: r.max_percent || null,
          max_amount: r.max_amount || null,
        })),
      ),
    { success: "Concession limits saved", invalidate: [adminKeys.concession] },
  );
  const set = (i: number, patch: Partial<LimitRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const available = (roles.data ?? []).filter(
    (r) =>
      !rows.some((x) => x.role_code === r.role_code) &&
      r.role_code !== "STUDENT",
  );
  return (
    <Section
      title="Concession limits"
      subtitle="Extra concession a role may approve: the lower of percent and amount · both blank = unlimited · saving asks for your password"
    >
      <div className="table-wrap">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Role</th>
              <th>Max percent</th>
              <th>Max amount (₹)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.role_code}>
                <td className="font-medium">{r.role_name}</td>
                <td>
                  <Input
                    className="h-8"
                    inputMode="decimal"
                    aria-label={`${r.role_name} max percent`}
                    value={r.max_percent}
                    onChange={(e) => set(i, { max_percent: e.target.value })}
                    placeholder="Unlimited"
                  />
                </td>
                <td>
                  <Input
                    className="h-8"
                    inputMode="decimal"
                    aria-label={`${r.role_name} max amount`}
                    value={r.max_amount}
                    onChange={(e) => set(i, { max_amount: e.target.value })}
                    placeholder="Unlimited"
                  />
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${r.role_name}`}
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <NativeSelect
          aria-label="Add role"
          className="h-9 w-56"
          placeholder="Add a role…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          options={available.map((r) => ({
            value: r.role_code,
            label: r.role_name,
          }))}
        />
        <Button
          variant="outline"
          disabled={!adding}
          onClick={() => {
            const role = roles.data?.find((r) => r.role_code === adding);
            if (role)
              setRows([
                ...rows,
                {
                  role_code: role.role_code,
                  role_name: role.role_name,
                  max_percent: "",
                  max_amount: "",
                },
              ]);
            setAdding("");
          }}
        >
          <Plus />
          Add
        </Button>
        <Button
          className="ml-auto"
          onClick={() => save.mutate(undefined)}
          disabled={save.isPending || limits.isLoading}
        >
          Save limits
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- notification rules & channels

export function NotificationsTab() {
  const rules = useQuery({
    queryKey: adminKeys.rules,
    queryFn: adminApi.notificationRules,
  });
  return (
    <div className="space-y-4">
      <Section
        title="Notification rules"
        subtitle="Warn / escalate thresholds per event · external WhatsApp / email depends on integrations"
      >
        <DataTable
          rows={rules.data}
          loading={rules.isLoading}
          error={rules.error}
          onRetry={() => void rules.refetch()}
          rowKey={(r) => r.rule_id}
          empty={<Empty title="No notification rules" />}
          columns={[
            {
              header: "Rule",
              cell: (r) => (
                <span>
                  <span className="font-medium">
                    {r.description ?? r.rule_code}
                  </span>
                  <small className="block text-muted-foreground">
                    {r.rule_code} · {r.category} · to {r.recipient_role}
                  </small>
                </span>
              ),
            },
            { header: "Thresholds", cell: (r) => <RuleEditor rule={r} /> },
            {
              header: "WhatsApp",
              cell: (r) => <RuleFlag rule={r} field="send_whatsapp" />,
            },
            {
              header: "Email",
              cell: (r) => <RuleFlag rule={r} field="send_email" />,
            },
            {
              header: "Active",
              cell: (r) => <RuleFlag rule={r} field="is_active" />,
            },
          ]}
        />
      </Section>
      <ChannelsSection />
    </div>
  );
}

function RuleEditor({ rule }: { rule: NotificationRule }) {
  const [warn, setWarn] = useState(String(rule.warn_after_minutes ?? ""));
  const [esc, setEsc] = useState(String(rule.escalate_after_minutes ?? ""));
  const [to, setTo] = useState(rule.escalate_to_role ?? "");
  const roles = useRoles();
  const save = useApiMutation(
    () =>
      adminApi.updateNotificationRule(rule.rule_id, {
        warn_after_minutes: warn ? Number(warn) : null,
        escalate_after_minutes: esc ? Number(esc) : null,
        escalate_to_role: to || null,
      }),
    { success: "Rule saved", invalidate: [adminKeys.rules] },
  );
  const changed =
    warn !== String(rule.warn_after_minutes ?? "") ||
    esc !== String(rule.escalate_after_minutes ?? "") ||
    to !== (rule.escalate_to_role ?? "");
  return (
    <div className="flex min-w-80 flex-wrap items-center gap-2">
      <Input
        className="h-8 w-20"
        type="number"
        min={1}
        aria-label={`${rule.rule_code} warn after minutes`}
        value={warn}
        onChange={(e) => setWarn(e.target.value)}
        placeholder="Warn"
      />
      <Input
        className="h-8 w-20"
        type="number"
        min={1}
        aria-label={`${rule.rule_code} escalate after minutes`}
        value={esc}
        onChange={(e) => setEsc(e.target.value)}
        placeholder="Escalate"
      />
      <NativeSelect
        className="h-8 w-40"
        aria-label={`${rule.rule_code} escalate to`}
        placeholder="No escalation"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        options={(roles.data ?? []).map((r) => ({
          value: r.role_code,
          label: r.role_name,
        }))}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || save.isPending}
        onClick={() => save.mutate(undefined)}
        aria-label={`Save ${rule.rule_code}`}
      >
        <Save />
      </Button>
    </div>
  );
}

function RuleFlag({
  rule,
  field,
}: {
  rule: NotificationRule;
  field: "send_whatsapp" | "send_email" | "is_active";
}) {
  const save = useApiMutation(
    (v: boolean) =>
      adminApi.updateNotificationRule(rule.rule_id, { [field]: v }),
    { success: "Rule saved", invalidate: [adminKeys.rules] },
  );
  return (
    <Switch
      checked={rule[field]}
      onCheckedChange={(v) => save.mutate(v)}
      aria-label={`${field} ${rule.rule_code}`}
    />
  );
}

function ChannelsSection() {
  const channels = useQuery({
    queryKey: adminKeys.channels,
    queryFn: () => adminApi.channels(),
  });
  const branches = useBranches();
  const form = useForm({
    defaultValues: {
      branch_id: "",
      contact_channel_id: "",
      address: "",
      mode: "Manual",
    },
  });
  const { register, handleSubmit, formState, reset } = form;
  const create = useApiMutation(
    (v: {
      branch_id: string;
      contact_channel_id: string;
      address: string;
      mode: string;
    }) =>
      adminApi.createChannel({
        branch_id: Number(v.branch_id),
        contact_channel_id: Number(v.contact_channel_id),
        address: v.address.trim(),
        mode: v.mode,
      }),
    {
      success: "Channel added",
      invalidate: [adminKeys.channels],
      silentValidation: true,
      onSuccess: () => reset(),
      onError: (e) => applyServerErrors(form, e),
    },
  );
  const toggle = useApiMutation(
    (c: BranchChannel) =>
      adminApi.updateChannel(c.branch_channel_id, { is_active: !c.is_active }),
    { success: "Channel saved", invalidate: [adminKeys.channels] },
  );
  return (
    <Section
      title="Branch communication channels"
      subtitle="WhatsApp numbers, email senders and phone lines per branch"
    >
      <form
        className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.5fr_130px_auto] lg:items-end"
        onSubmit={handleSubmit((v) => create.mutate(v))}
      >
        <Field
          label="Channel branch"
          htmlFor="ch-branch"
          error={formState.errors.branch_id?.message}
        >
          <NativeSelect
            id="ch-branch"
            placeholder="Select branch…"
            options={(branches.data ?? []).map((b) => ({
              value: b.branch_id,
              label: b.branch_name,
            }))}
            {...register("branch_id", { required: "Required" })}
          />
        </Field>
        <Field
          label="Channel"
          htmlFor="ch-channel"
          error={formState.errors.contact_channel_id?.message}
        >
          <LookupSelect
            id="ch-channel"
            lookup="contact_channels"
            {...register("contact_channel_id", { required: "Required" })}
          />
        </Field>
        <Field
          label="Address / number"
          htmlFor="ch-address"
          error={formState.errors.address?.message}
        >
          <Input
            id="ch-address"
            {...register("address", { required: "Required" })}
          />
        </Field>
        <Field label="Mode" htmlFor="ch-mode">
          <NativeSelect
            id="ch-mode"
            options={INTEGRATION_MODES.map((m) => ({ value: m, label: m }))}
            {...register("mode")}
          />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          <Plus />
          Add channel
        </Button>
      </form>
      <DataTable
        rows={channels.data}
        loading={channels.isLoading}
        error={channels.error}
        rowKey={(c) => c.branch_channel_id}
        empty={<Empty title="No branch channels configured" />}
        columns={[
          { header: "Branch", cell: (c) => c.branch.branch_name },
          { header: "Channel", cell: (c) => c.channel },
          {
            header: "Address",
            cell: (c) => <span className="break-all">{c.address}</span>,
          },
          { header: "Mode", cell: (c) => c.mode },
          {
            header: "Active",
            cell: (c) => (
              <Switch
                checked={c.is_active}
                onCheckedChange={() => toggle.mutate(c)}
                aria-label={`Active ${c.channel} ${c.address}`}
              />
            ),
          },
        ]}
      />
    </Section>
  );
}
