/**
 * Form helpers. Forms use react-hook-form; server validation errors (`error.details`) are mapped onto
 * fields with `applyServerErrors`. Selects are native <select> elements styled like inputs — simple to
 * register, accessible, and easy to drive in Playwright.
 */
import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";
import { get, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { LEAD_OWNER_ROLES, useBranches, useCourses, useLookups, useStaff, type Lookups } from "@/api/reference";
import type { RoleCode } from "@/api/types";
import { useAuth } from "@/auth/auth";
import { cn } from "@/lib/utils";

type FieldProps = {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
};

export function Field(props: FieldProps) {
  const { label, error, hint, children, className, htmlFor } = props;
  // Marks fields that render an error message, so applyServerErrors knows which inputs can show one.
  return (
    <div className={cn("field", className)} data-shows-errors={"error" in props ? "" : undefined}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** True when `name` is registered, its input is on screen, and it sits in a <Field> that renders errors. */
function showsError<T extends FieldValues>(form: UseFormReturn<T>, name: string): boolean {
  if (!form.control._names.mount.has(name)) return false;
  const f = (get(form.control._fields, name) as { _f?: { ref?: unknown; refs?: unknown[] } } | undefined)?._f;
  const el = [f?.ref, ...(f?.refs ?? [])].find((r): r is Element => r instanceof Element);
  return !!el?.isConnected && !!el.closest(".field")?.hasAttribute("data-shows-errors");
}

/**
 * Copies `{ details: { field: [msg] } }` from a 400 onto the form's fields; returns true when anything was
 * mapped. Errors for fields that can't display them (not in this dialog, hidden, or in a <Field> without an
 * `error` prop) are toasted instead, so a rejected submit is never silent.
 */
export function applyServerErrors<T extends FieldValues>(form: UseFormReturn<T>, error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.details) return false;
  let mapped = false;
  const unmapped: string[] = [];
  for (const [field, messages] of Object.entries(error.details)) {
    const message = Array.isArray(messages) ? messages.join(", ") : String(messages);
    const name = field.replace(/^person\./, "");
    if (showsError(form, name)) {
      form.setError(name as Path<T>, { type: "server", message });
      mapped = true;
    } else {
      unmapped.push(message);
    }
  }
  if (unmapped.length) toast.error(error.message, { description: unmapped.join(" · ") });
  return mapped;
}

export const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string };

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps & { options: { value: string | number; label: string }[] }>(
  function NativeSelect({ options, placeholder, className, ...props }, ref) {
    return (
      <select ref={ref} className={cn(selectClass, className)} {...props}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
);

/**
 * Stand-in while a select's options load. The real <select> mounts once its options exist, so
 * react-hook-form sets its value then; mounting it empty would leave the first option showing.
 */
function LoadingSelect({ id, className }: { id?: string | undefined; className?: string | undefined }) {
  return (
    <select id={id} className={cn(selectClass, className)} disabled aria-busy="true">
      <option>Loading…</option>
    </select>
  );
}

type LookupKey = Exclude<keyof Lookups, "enums">;

export const LookupSelect = forwardRef<HTMLSelectElement, NativeSelectProps & { lookup: LookupKey }>(function LookupSelect(
  { lookup, placeholder = "Select…", ...props },
  ref,
) {
  const { data, isLoading } = useLookups();
  if (isLoading) return <LoadingSelect id={props.id} className={props.className} />;
  const options = (data?.[lookup] ?? []).filter((o) => o.is_active).map((o) => ({ value: o.id, label: o.label }));
  return <NativeSelect ref={ref} options={options} placeholder={placeholder} {...props} />;
});

/** Options from /lookups → enums (e.g. "lead_stages", "task_statuses"). */
export const EnumSelect = forwardRef<HTMLSelectElement, NativeSelectProps & { name: string; enumKey: string }>(function EnumSelect(
  { enumKey, placeholder = "Select…", ...props },
  ref,
) {
  const { data, isLoading } = useLookups();
  if (isLoading) return <LoadingSelect id={props.id} className={props.className} />;
  const options = (data?.enums[enumKey] ?? []).map((v) => ({ value: v, label: v }));
  return <NativeSelect ref={ref} options={options} placeholder={placeholder} {...props} />;
});

/** Branches the user may act in (a single allowed branch is preselected by the caller). */
export const BranchSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function BranchSelect(
  { placeholder = "Select branch…", ...props },
  ref,
) {
  const { branches } = useAuth();
  const options = branches.map((b) => ({ value: b.branch_id, label: b.branch_name }));
  return <NativeSelect ref={ref} options={options} placeholder={branches.length > 1 ? placeholder : undefined} {...props} />;
});

export const CourseSelect = forwardRef<HTMLSelectElement, NativeSelectProps & { branchCode?: string | undefined }>(function CourseSelect(
  { branchCode, placeholder = "Select course…", ...props },
  ref,
) {
  const { data, isLoading } = useCourses();
  if (isLoading) return <LoadingSelect id={props.id} className={props.className} />;
  const options = (data ?? [])
    .filter((c) => !branchCode || c.branches.includes(branchCode))
    .map((c) => ({ value: c.course_id, label: `${c.course_title} (${c.course_code})` }));
  return <NativeSelect ref={ref} options={options} placeholder={placeholder} {...props} />;
});

/** Staff at a branch with the given roles (defaults to lead owners: Sales, Front Office, Branch Manager). */
export const StaffSelect = forwardRef<HTMLSelectElement, NativeSelectProps & { branchId?: number | undefined; roles?: RoleCode[] }>(
  function StaffSelect({ branchId, roles = LEAD_OWNER_ROLES, placeholder = "Select…", ...props }, ref) {
    const { data, isLoading } = useStaff(branchId, roles);
    if (isLoading) return <LoadingSelect id={props.id} className={props.className} />;
    const options = (data ?? []).map((s) => ({ value: s.user_id, label: s.full_name }));
    return <NativeSelect ref={ref} options={options} placeholder={placeholder} {...props} />;
  },
);

export function useBranchCode(branchId: number | string | undefined | null) {
  const { data } = useBranches();
  return data?.find((b) => b.branch_id === Number(branchId))?.branch_code;
}

/** Turn "" into null and numeric strings into numbers for API bodies. */
export function cleanBody<T extends Record<string, unknown>>(values: T, numeric: (keyof T)[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === "" || value === undefined) continue;
    out[key] = numeric.includes(key as keyof T) && value !== null ? Number(value) : value;
  }
  return out;
}
