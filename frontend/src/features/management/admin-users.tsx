/** Admin → Users & Access: list, create (chosen or generated temporary password, copy / CSV download), edit, deactivate, reset password, grant / revoke scopes. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Copy, Download, KeyRound, Plus, ShieldPlus, Shuffle, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  adminApi,
  adminKeys,
  type AdminUser,
  type UserFilters,
} from "@/api/admin";
import { useBranches, useRoles } from "@/api/reference";
import type { RoleCode } from "@/api/types";
import { useAuth } from "@/auth/auth";
import { Badge } from "@/components/ui/badge";
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
import { Field, NativeSelect, applyServerErrors } from "@/components/crm/forms";
import {
  ConfirmAction,
  DataTable,
  Empty,
  ErrorPanel,
  Facts,
  LoadingRows,
  Pagination,
  Section,
  Status,
  Warning,
} from "@/components/crm/ui";
import { dateTime, fromLocalInput } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

function useBranchOptions() {
  const branches = useBranches();
  return (branches.data ?? []).map((b) => ({
    value: b.branch_id,
    label: b.branch_name,
  }));
}

/** Credentials shown once after creating a user or resetting a password. */
type Secret = {
  title: string;
  email: string;
  password: string;
  name?: string;
  phone?: string | null;
  role?: string;
  branch?: string;
};

/** A random 14-character password with upper, lower, digit and symbol (no look-alike characters). */
function generatePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%*?"];
  const all = sets.join("");
  const pick = (chars: string) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const chars = [pick(sets[0]), ...sets.map(pick), ...Array.from({ length: 9 }, () => pick(all))];
  // shuffle all but the first, so it always starts with a letter (safe to paste into a spreadsheet)
  for (let i = chars.length - 1; i > 1; i--) {
    const j = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % i);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function credentialRows(secret: Secret): [string, string][] {
  return [
    ["Name", secret.name ?? ""],
    ["Email", secret.email],
    ["Mobile", secret.phone ?? ""],
    ["Role", secret.role ?? ""],
    ["Branch", secret.branch ?? ""],
    ["Temporary password", secret.password],
    ["Sign-in", window.location.origin],
  ].filter(([, v]) => v !== "") as [string, string][];
}

/** Quote a CSV cell; text cells that a spreadsheet would run as a formula get a leading apostrophe (never the password). */
function csvCell(value: string, isPassword = false): string {
  const safe = !isPassword && /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function downloadCredentials(secret: Secret) {
  const rows = credentialRows(secret);
  const csv = [rows.map(([k]) => csvCell(k)).join(","), rows.map(([k, v]) => csvCell(v, k === "Temporary password")).join(",")].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv + "\r\n"], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `nipuna-login-${secret.email.split("@")[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function scopeText(s: { role_name: string; branch_code: string | null }) {
  return `${s.role_name} · ${s.branch_code ?? "All branches"}`;
}

export function UsersTab() {
  const roles = useRoles();
  const branchOptions = useBranchOptions();
  const [filters, setFilters] = useState<UserFilters>({ page: 1 });
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const users = useQuery({
    queryKey: adminKeys.userList(filters),
    queryFn: () => adminApi.users(filters),
  });
  const set = (patch: Partial<UserFilters>) =>
    setFilters({ ...filters, ...patch, page: 1 });

  return (
    <div className="space-y-4">
      <Section
        title="Users & Access"
        subtitle="Combined role + branch scopes never union into another role · sensitive changes ask for your password"
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <UserPlus />
            New user
          </Button>
        }
      >
        <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search users" htmlFor="u-q">
            <Input
              id="u-q"
              placeholder="Name or email"
              value={filters.q ?? ""}
              onChange={(e) => set({ q: e.target.value || undefined })}
            />
          </Field>
          <Field label="Role" htmlFor="u-role">
            <NativeSelect
              id="u-role"
              placeholder="Any role"
              value={filters.role ?? ""}
              onChange={(e) => set({ role: e.target.value || undefined })}
              options={(roles.data ?? []).map((r) => ({
                value: r.role_code,
                label: r.role_name,
              }))}
            />
          </Field>
          <Field label="Branch" htmlFor="u-branch">
            <NativeSelect
              id="u-branch"
              placeholder="Any branch"
              value={filters.branch_id ?? ""}
              onChange={(e) =>
                set({
                  branch_id: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              options={branchOptions}
            />
          </Field>
          <Field label="Status" htmlFor="u-active">
            <NativeSelect
              id="u-active"
              placeholder="Any status"
              value={
                filters.is_active === undefined ? "" : String(filters.is_active)
              }
              onChange={(e) =>
                set({
                  is_active:
                    e.target.value === ""
                      ? undefined
                      : e.target.value === "true",
                })
              }
              options={[
                { value: "true", label: "Active" },
                { value: "false", label: "Inactive" },
              ]}
            />
          </Field>
        </div>
        <DataTable
          rows={users.data?.data}
          loading={users.isLoading}
          error={users.error}
          onRetry={() => void users.refetch()}
          rowKey={(u) => u.user_id}
          onRowClick={(u) => setSelected(u.user_id)}
          empty={<Empty title="No users match these filters" />}
          columns={[
            {
              header: "User",
              cell: (u) => (
                <button
                  type="button"
                  className="text-left font-semibold text-primary"
                  onClick={() => setSelected(u.user_id)}
                >
                  {u.full_name}
                  <small className="block font-normal text-muted-foreground">
                    {u.email}
                  </small>
                </button>
              ),
            },
            {
              header: "Roles & scope",
              cell: (u) => (
                <span className="flex flex-wrap gap-1">
                  {u.scopes.map((s) => (
                    <Badge key={s.scope_id} variant="outline">
                      {scopeText(s)}
                      {s.expires_at && ` · until ${dateTime(s.expires_at)}`}
                    </Badge>
                  ))}
                </span>
              ),
            },
            {
              header: "Status",
              cell: (u) => (
                <span className="flex flex-wrap gap-1">
                  <Status kind={u.is_active ? "good" : "neutral"}>
                    {u.is_active ? "Active" : "Inactive"}
                  </Status>
                  {u.is_locked && <Status kind="danger">Locked</Status>}
                  {u.must_change_password && (
                    <Status kind="warn">Must change password</Status>
                  )}
                  {u.is_recovery_account && (
                    <Status kind="warn">Recovery account</Status>
                  )}
                </span>
              ),
            },
            { header: "Last login", cell: (u) => dateTime(u.last_login_at) },
          ]}
        />
        <Pagination
          meta={users.data?.meta}
          onPage={(page) => setFilters({ ...filters, page })}
        />
      </Section>
      {selected !== null && <UserDetail id={selected} onSecret={setSecret} />}
      <NewUserDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(u, password, access) => {
          setSelected(u.user_id);
          setSecret({ title: "User created", email: u.email, password, name: u.full_name, phone: u.phone, ...access });
        }}
      />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function SecretDialog({
  secret,
  onClose,
}: {
  secret: Secret | null;
  onClose: () => void;
}) {
  const copy = (text: string, what: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(`${what} copied`),
      () => toast.error("Copy failed — select and copy by hand"),
    );
  const rows = secret ? credentialRows(secret) : [];
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret?.title}</DialogTitle>
          <DialogDescription>
            Share these credentials with {secret?.email} securely. The password is
            shown only once; they must change it at first sign-in.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rows
            .filter(([k]) => k !== "Temporary password")
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
        </dl>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-base"
            aria-label="Temporary password"
          >
            {secret?.password}
          </code>
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy password"
            onClick={() => copy(secret?.password ?? "", "Password")}
          >
            <Copy />
          </Button>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => copy(rows.map(([k, v]) => `${k}: ${v}`).join("\n"), "Credentials")}
            >
              <Copy /> Copy credentials
            </Button>
            <Button variant="outline" onClick={() => secret && downloadCredentials(secret)}>
              <Download /> Download CSV
            </Button>
          </div>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type NewUserValues = {
  full_name: string;
  email: string;
  phone: string;
  role_code: string;
  branch_id: string;
  expires_at: string;
  password: string;
  is_recovery_account: boolean;
};

function NewUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (u: AdminUser, password: string, access: { role?: string; branch?: string }) => void;
}) {
  const { hasRole } = useAuth();
  const roles = useRoles();
  const branchOptions = useBranchOptions();
  const form = useForm<NewUserValues>({
    defaultValues: {
      full_name: "",
      email: "",
      phone: "",
      role_code: "",
      branch_id: "",
      expires_at: "",
      password: "",
      is_recovery_account: false,
    },
  });
  const { register, handleSubmit, formState, reset, watch, setValue } = form;
  const [showPassword, setShowPassword] = useState(false);
  const role = (roles.data ?? []).find((r) => r.role_code === watch("role_code"));
  // Company-wide roles (Founder, Super Admin, …) have no branch; the DB rejects a branch on them
  const needsBranch = Boolean(role && !role.is_company_wide);
  useEffect(() => {
    if (!needsBranch) setValue("branch_id", "");
  }, [needsBranch, setValue]);
  useEffect(() => {
    if (open) {
      reset();
      setShowPassword(false);
    }
  }, [open, reset]);
  const create = useApiMutation(adminApi.createUser, {
    invalidate: [adminKeys.users, ["staff"]],
    silentValidation: true,
    success: (r) => `${r.user.full_name} created`,
    onSuccess: (r) => {
      onOpenChange(false);
      const scope = r.user.scopes?.[0];
      onCreated(r.user, r.temporary_password, {
        role: role?.role_name ?? scope?.role_name,
        branch: branchOptions.find((b) => String(b.value) === form.getValues("branch_id"))?.label ?? "All branches",
      });
    },
    onError: (e) => applyServerErrors(form, e),
  });
  const submit = handleSubmit((v) =>
    create.mutate({
      full_name: v.full_name.trim(),
      email: v.email.trim(),
      phone: v.phone.trim(),
      password: v.password || null,
      is_recovery_account: v.is_recovery_account,
      scopes: [
        {
          role_code: v.role_code as RoleCode,
          branch_id: v.branch_id ? Number(v.branch_id) : null,
          expires_at: fromLocalInput(v.expires_at),
        },
      ],
    }),
  );
  const err = (k: keyof NewUserValues) =>
    formState.errors[k]?.message ??
    (k === "role_code"
      ? (formState.errors as Record<string, { message?: string }>)["scopes"]
          ?.message
      : undefined);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Set a password or generate one (leave blank to let the system pick).
            It is shown once to copy or download; the user must change it at
            first sign-in. More role scopes can be granted afterwards.
          </DialogDescription>
        </DialogHeader>
        <form
          id="new-user-form"
          onSubmit={submit}
          className="grid gap-3 sm:grid-cols-2"
        >
          <Field label="Full name" htmlFor="nu-name" error={err("full_name")}>
            <Input
              id="nu-name"
              {...register("full_name", { required: "Required" })}
            />
          </Field>
          <Field label="Email" htmlFor="nu-email" error={err("email")}>
            <Input
              id="nu-email"
              type="email"
              {...register("email", { required: "Required" })}
            />
          </Field>
          <Field
            label="Mobile"
            htmlFor="nu-phone"
            error={err("phone")}
            hint="Used for the WhatsApp code when they forget their password"
          >
            <Input id="nu-phone" inputMode="tel" placeholder="98765 43210" {...register("phone", { required: "Required" })} />
          </Field>
          <Field label="Role" htmlFor="nu-role" error={err("role_code")}>
            <NativeSelect
              id="nu-role"
              placeholder="Select role…"
              options={(roles.data ?? [])
                .filter((r) => r.role_code !== "STUDENT")
                .map((r) => ({ value: r.role_code, label: r.role_name }))}
              {...register("role_code", { required: "Required" })}
            />
          </Field>
          {needsBranch ? (
            <Field label="Branch" htmlFor="nu-branch" error={err("branch_id")}>
              <NativeSelect
                id="nu-branch"
                placeholder="Select branch…"
                options={branchOptions}
                {...register("branch_id", { required: "Required for this role" })}
              />
            </Field>
          ) : (
            <Field label="Branch" htmlFor="nu-branch-all">
              <Input id="nu-branch-all" disabled value={role ? "All branches (company-wide role)" : "Pick a role first"} readOnly />
            </Field>
          )}
          <Field
            label="Password (optional)"
            htmlFor="nu-password"
            error={err("password")}
            hint="Blank = generated by the system"
            className="sm:col-span-2"
          >
            <div className="flex gap-2">
              <Input
                id="nu-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                className="font-mono"
                {...register("password", { minLength: { value: 10, message: "At least 10 characters" } })}
              />
              <Button type="button" variant="outline" onClick={() => setShowPassword((s) => !s)}>
                {showPassword ? "Hide" : "Show"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setValue("password", generatePassword(), { shouldValidate: true });
                  setShowPassword(true);
                }}
              >
                <Shuffle /> Generate
              </Button>
            </div>
          </Field>
          <Field
            label="Access expires (optional, IST)"
            htmlFor="nu-expires"
            error={err("expires_at")}
          >
            <Input
              id="nu-expires"
              type="datetime-local"
              {...register("expires_at")}
            />
          </Field>
          {hasRole("FOUNDER_CEO") && (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" {...register("is_recovery_account")} />
              Emergency / recovery account
            </label>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-user-form"
            disabled={create.isPending}
          >
            Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserDetail({
  id,
  onSecret,
}: {
  id: number;
  onSecret: (s: { title: string; email: string; password: string }) => void;
}) {
  const { profile } = useAuth();
  const user = useQuery({
    queryKey: [...adminKeys.users, "detail", id],
    queryFn: () => adminApi.user(id),
  });
  const scopes = useQuery({
    queryKey: adminKeys.scopes(id),
    queryFn: () => adminApi.scopes(id),
  });
  const [editing, setEditing] = useState(false);
  const [granting, setGranting] = useState(false);
  const invalidate = [adminKeys.users, ["staff"]];
  const setActive = useApiMutation(
    (is_active: boolean) => adminApi.updateUser(id, { is_active }),
    {
      success: (u) =>
        `${u.full_name} ${u.is_active ? "reactivated" : "deactivated"}`,
      invalidate,
    },
  );
  const reset = useApiMutation(() => adminApi.resetPassword(id), {
    success: "Password reset — all sessions signed out",
    invalidate,
    onSuccess: (r) =>
      onSecret({
        title: "Password reset",
        email: r.user.email,
        password: r.temporary_password,
      }),
  });
  const revoke = useApiMutation(
    (scopeId: number) => adminApi.revokeScope(id, scopeId),
    { success: "Access revoked", invalidate },
  );

  if (user.isLoading)
    return (
      <Section title="User">
        <LoadingRows rows={4} />
      </Section>
    );
  if (user.error)
    return (
      <Section title="User">
        <ErrorPanel error={user.error} onRetry={() => void user.refetch()} />
      </Section>
    );
  const u = user.data!;
  const self = profile?.user.user_id === u.user_id;

  return (
    <Section
      title={u.full_name}
      subtitle={u.email}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <ConfirmAction
            trigger={
              <Button size="sm" variant="outline">
                <KeyRound />
                Reset password
              </Button>
            }
            title={`Reset password for ${u.full_name}?`}
            description="A new temporary password is generated and every active session of this user is signed out."
            action="Reset password"
            onConfirm={() => reset.mutateAsync(undefined)}
          />
          {!self &&
            (u.is_active ? (
              <ConfirmAction
                trigger={
                  <Button size="sm" variant="destructive">
                    Deactivate
                  </Button>
                }
                title={`Deactivate ${u.full_name}?`}
                description="They are signed out and can no longer sign in. Their records stay."
                action="Deactivate"
                destructive
                onConfirm={() => setActive.mutateAsync(false)}
              />
            ) : (
              <Button
                size="sm"
                onClick={() => setActive.mutate(true)}
                disabled={setActive.isPending}
              >
                Reactivate
              </Button>
            ))}
        </div>
      }
    >
      {self && (
        <div className="mb-3">
          <Warning>
            This is your own account — you can't deactivate yourself or change
            your own access.
          </Warning>
        </div>
      )}
      <Facts
        columns={3}
        items={[
          ["Phone", u.phone ?? "—"],
          ["Status", u.is_active ? "Active" : "Inactive"],
          ["Locked", u.is_locked ? "Yes" : "No"],
          ["Must change password", u.must_change_password ? "Yes" : "No"],
          ["Last login", dateTime(u.last_login_at)],
          ["Created", dateTime(u.created_at)],
        ]}
      />
      <div className="mb-2 mt-5 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Role scopes</h3>
        {!self && (
          <Button size="sm" variant="outline" onClick={() => setGranting(true)}>
            <ShieldPlus />
            Grant access
          </Button>
        )}
      </div>
      <DataTable
        rows={scopes.data}
        loading={scopes.isLoading}
        error={scopes.error}
        rowKey={(s) => s.scope_id}
        columns={[
          { header: "Role", cell: (s) => s.role_name },
          { header: "Branch", cell: (s) => s.branch_code ?? "All branches" },
          { header: "Granted", cell: (s) => dateTime(s.granted_at) },
          {
            header: "Expires",
            cell: (s) => (s.expires_at ? dateTime(s.expires_at) : "—"),
          },
          {
            header: "Status",
            cell: (s) => (
              <Status kind={s.status === "active" ? "good" : "neutral"}>
                {s.status}
              </Status>
            ),
          },
          {
            header: "Actions",
            cell: (s) =>
              s.status === "active" && !self ? (
                <ConfirmAction
                  trigger={
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Revoke ${s.role_name} ${s.branch_code ?? "all branches"}`}
                    >
                      Revoke
                    </Button>
                  }
                  title={`Revoke ${scopeText(s)}?`}
                  action="Revoke"
                  destructive
                  onConfirm={() => revoke.mutateAsync(s.scope_id)}
                />
              ) : (
                "—"
              ),
          },
        ]}
      />
      <EditUserDialog open={editing} onOpenChange={setEditing} user={u} />
      <GrantScopeDialog
        open={granting}
        onOpenChange={setGranting}
        userId={u.user_id}
      />
    </Section>
  );
}

function EditUserDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: AdminUser;
}) {
  const form = useForm({
    defaultValues: {
      full_name: user.full_name,
      email: user.email,
      phone: user.phone ?? "",
    },
  });
  const { register, handleSubmit, formState, reset } = form;
  useEffect(() => {
    if (open)
      reset({
        full_name: user.full_name,
        email: user.email,
        phone: user.phone ?? "",
      });
  }, [open, user, reset]);
  const save = useApiMutation(
    (body: { full_name: string; email: string; phone: string | null }) =>
      adminApi.updateUser(user.user_id, body),
    {
      success: "User updated",
      invalidate: [adminKeys.users, ["staff"]],
      silentValidation: true,
      onSuccess: () => onOpenChange(false),
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {user.full_name}</DialogTitle>
        </DialogHeader>
        <form
          id="edit-user-form"
          className="space-y-3"
          onSubmit={handleSubmit((v) =>
            save.mutate({
              full_name: v.full_name.trim(),
              email: v.email.trim(),
              phone: v.phone || null,
            }),
          )}
        >
          <Field
            label="Full name"
            htmlFor="eu-name"
            error={formState.errors.full_name?.message}
          >
            <Input
              id="eu-name"
              {...register("full_name", { required: "Required" })}
            />
          </Field>
          <Field
            label="Email"
            htmlFor="eu-email"
            error={formState.errors.email?.message}
          >
            <Input
              id="eu-email"
              type="email"
              {...register("email", { required: "Required" })}
            />
          </Field>
          <Field
            label="Phone"
            htmlFor="eu-phone"
            error={formState.errors.phone?.message}
          >
            <Input id="eu-phone" {...register("phone")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-user-form" disabled={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantScopeDialog({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: number;
}) {
  const roles = useRoles();
  const branchOptions = useBranchOptions();
  const form = useForm({
    defaultValues: { role_code: "", branch_id: "", expires_at: "" },
  });
  const { register, handleSubmit, formState, reset } = form;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const grant = useApiMutation(
    (v: { role_code: string; branch_id: string; expires_at: string }) =>
      adminApi.grantScope(userId, {
        role_code: v.role_code as RoleCode,
        branch_id: v.branch_id ? Number(v.branch_id) : null,
        expires_at: fromLocalInput(v.expires_at),
      }),
    {
      success: (s) => `${s.role_name} access granted`,
      invalidate: [adminKeys.users, ["staff"]],
      silentValidation: true,
      onSuccess: () => onOpenChange(false),
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant access</DialogTitle>
          <DialogDescription>
            Temporary access expires automatically at the chosen time.
          </DialogDescription>
        </DialogHeader>
        <form
          id="grant-form"
          className="space-y-3"
          onSubmit={handleSubmit((v) => grant.mutate(v))}
        >
          <Field
            label="Role"
            htmlFor="gs-role"
            error={formState.errors.role_code?.message}
          >
            <NativeSelect
              id="gs-role"
              placeholder="Select role…"
              options={(roles.data ?? [])
                .filter((r) => r.role_code !== "STUDENT")
                .map((r) => ({ value: r.role_code, label: r.role_name }))}
              {...register("role_code", { required: "Required" })}
            />
          </Field>
          <Field
            label="Branch scope"
            htmlFor="gs-branch"
            error={formState.errors.branch_id?.message}
            hint="Blank = all branches"
          >
            <NativeSelect
              id="gs-branch"
              placeholder="All branches"
              options={branchOptions}
              {...register("branch_id")}
            />
          </Field>
          <Field
            label="Expires (optional, IST)"
            htmlFor="gs-expires"
            error={formState.errors.expires_at?.message}
          >
            <Input
              id="gs-expires"
              type="datetime-local"
              {...register("expires_at")}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="grant-form" disabled={grant.isPending}>
            <Plus />
            Grant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
