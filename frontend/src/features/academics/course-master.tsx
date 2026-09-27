import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers, MapPin, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { COURSE_STATUSES, courseKeys, coursesApi, type Course, type CourseFilters, type Installment, type PaymentPlan } from "@/api/courses";
import { useBranches } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, Metric, PageHead, Pagination, Section, Status } from "@/components/crm/ui";
import { money, sumMoney } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FormDialog } from "./shared";

export type CourseSearch = Omit<CourseFilters, "per_page" | "branch_id">;

export function CourseMaster({ search, onSearch }: { search: CourseSearch; onSearch: (s: CourseSearch) => void }) {
  const { isAdmin } = useAuth();
  const branchId = useBranchFilter();
  const [text, setText] = useState(search.q ?? "");
  const filters: CourseFilters = { ...search, branch_id: branchId, per_page: 25 };
  const courses = useQuery({ queryKey: courseKeys.list(filters), queryFn: () => coursesApi.list(filters), placeholderData: (p) => p });
  const count = (f: CourseFilters) => ({ queryKey: courseKeys.list({ ...f, branch_id: branchId, per_page: 1 }), queryFn: () => coursesApi.list({ ...f, branch_id: branchId, per_page: 1 }) });
  const active = useQuery(count({ status: "Active" }));
  const standalone = useQuery(count({ status: "Active", type: "standalone" }));
  const combos = useQuery(count({ status: "Active", type: "combo" }));
  const set = (patch: Partial<CourseSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const k of Object.keys(next) as (keyof CourseSearch)[]) if (next[k] === "" || next[k] === undefined) delete next[k];
    onSearch(next);
  };

  return (
    <>
      <PageHead
        title="Course Master"
        description={isAdmin ? "Approved courses and combos, branch availability and payment plans." : "Approved courses and combos · read-only"}
        actions={isAdmin ? <CourseDialog /> : undefined}
      />
      <div className="grid grid-cols-3 gap-3">
        <Metric label="Active records" value={active.data?.meta.total ?? "—"} loading={active.isLoading} />
        <Metric label="Standalone" value={standalone.data?.meta.total ?? "—"} loading={standalone.isLoading} />
        <Metric label="Combos" value={combos.data?.meta.total ?? "—"} loading={combos.isLoading} />
      </div>
      <Section title="Courses" subtitle="Same standard fee at every branch offering the course" className="mt-4">
        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_10rem_10rem_12rem] lg:items-end">
          <form
            className="relative min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search code or title — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search courses" />
          </form>
          <Field label="Type" htmlFor="cm-type">
            <NativeSelect
              id="cm-type"
              value={search.type ?? ""}
              placeholder="Any"
              options={[
                { value: "standalone", label: "Standalone" },
                { value: "combo", label: "Combo" },
              ]}
              onChange={(e) => set({ type: (e.target.value || undefined) as CourseSearch["type"] })}
            />
          </Field>
          <Field label="Status" htmlFor="cm-status">
            <NativeSelect id="cm-status" value={search.status ?? ""} placeholder="Any" options={COURSE_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ status: e.target.value })} />
          </Field>
          <Field label="Category" htmlFor="cm-cat">
            <Input id="cm-cat" defaultValue={search.category ?? ""} placeholder="Any" onBlur={(e) => set({ category: e.target.value.trim() || undefined })} onKeyDown={(e) => e.key === "Enter" && set({ category: e.currentTarget.value.trim() || undefined })} />
          </Field>
        </div>
        <DataTable
          rows={courses.data?.data}
          loading={courses.isLoading}
          error={courses.error}
          onRetry={() => void courses.refetch()}
          rowKey={(c) => c.course_id}
          empty={<Empty title="No courses match" />}
          columns={[
            { header: "Code", cell: (c) => <b>{c.course_code}</b> },
            { header: "Course", cell: (c) => <span className="block max-w-72 truncate" title={c.course_title}>{c.course_title}</span> },
            { header: "Category", cell: (c) => c.category },
            { header: "Standard fee / package", cell: (c) => money(c.standard_fee) },
            { header: "Type", cell: (c) => (c.is_combo ? `Combo · ${c.components.length} courses` : "Standalone") },
            { header: "Branches", cell: (c) => c.branches.join(" · ") || "—" },
            { header: "Status", cell: (c) => <Status>{c.status}</Status> },
            {
              header: "",
              cell: (c) =>
                isAdmin ? (
                  <div className="flex gap-1">
                    <CourseDialog course={c} />
                    <BranchesDialog course={c} />
                    {c.is_combo && <ComponentsDialog course={c} />}
                  </div>
                ) : null,
            },
          ]}
        />
        <Pagination meta={courses.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </Section>
      <PaymentPlans />
    </>
  );
}

function CourseDialog({ course }: { course?: Course }) {
  const branches = useBranches();
  const blank = { course_code: "", course_title: "", category: "", standard_fee: "", is_combo: false, status: "Active", branch_ids: [] as number[] };
  const [f, setF] = useState(blank);
  const save = useApiMutation(
    () =>
      course
        ? coursesApi.update(course.course_id, {
            ...(f.course_title !== course.course_title ? { course_title: f.course_title.trim() } : {}),
            ...(f.category !== course.category ? { category: f.category.trim() } : {}),
            ...(Number(f.standard_fee) !== Number(course.standard_fee) ? { standard_fee: f.standard_fee.trim() } : {}),
            ...(f.status !== course.status ? { status: f.status } : {}),
          })
        : coursesApi.create({ ...f, course_code: f.course_code.trim(), course_title: f.course_title.trim(), category: f.category.trim(), standard_fee: f.standard_fee.trim() }),
    { success: (c) => `${c.course_code} ${course ? "updated" : "created"}`, invalidate: [courseKeys.all] },
  );
  return (
    <FormDialog
      title={course ? `Edit ${course.course_code}` : "New course"}
      description={course ? "Code and combo type can't change." : "Standard fee is the same at every branch."}
      disabled={!f.course_title.trim() || !f.category.trim() || !f.standard_fee.trim() || (!course && !f.course_code.trim())}
      onOpen={() =>
        setF(course ? { course_code: course.course_code, course_title: course.course_title, category: course.category, standard_fee: String(Number(course.standard_fee)), is_combo: course.is_combo, status: course.status, branch_ids: [] } : blank)
      }
      onSubmit={() => save.mutateAsync(undefined)}
      submitLabel={course ? "Save course" : "Create course"}
      trigger={
        course ? (
          <Button size="sm" variant="ghost" title={`Edit ${course.course_code}`}>
            <Pencil />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus />
            New course
          </Button>
        )
      }
    >
      {!course && (
        <Field label="Course code" htmlFor="c-code" hint="e.g. NIT-CRS-060">
          <Input id="c-code" value={f.course_code} onChange={(e) => setF({ ...f, course_code: e.target.value.toUpperCase() })} />
        </Field>
      )}
      <Field label="Course title" htmlFor="c-title">
        <Input id="c-title" value={f.course_title} onChange={(e) => setF({ ...f, course_title: e.target.value })} />
      </Field>
      <Field label="Category" htmlFor="c-cat">
        <Input id="c-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
      </Field>
      <Field label="Standard fee (₹)" htmlFor="c-fee">
        <Input id="c-fee" inputMode="decimal" value={f.standard_fee} onChange={(e) => setF({ ...f, standard_fee: e.target.value })} />
      </Field>
      <Field label="Course status" htmlFor="c-status">
        <NativeSelect id="c-status" value={f.status} options={COURSE_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => setF({ ...f, status: e.target.value })} />
      </Field>
      {!course && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.is_combo} onChange={(e) => setF({ ...f, is_combo: e.target.checked })} />
            Combo package (components set after creating)
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Offered at</legend>
            {(branches.data ?? []).map((b) => (
              <label key={b.branch_id} className="mr-4 inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.branch_ids.includes(b.branch_id)}
                  onChange={(e) => setF({ ...f, branch_ids: e.target.checked ? [...f.branch_ids, b.branch_id] : f.branch_ids.filter((x) => x !== b.branch_id) })}
                />
                {b.branch_name}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </FormDialog>
  );
}

function BranchesDialog({ course }: { course: Course }) {
  const branches = useBranches();
  const [ids, setIds] = useState<number[]>([]);
  const save = useApiMutation(() => coursesApi.setBranches(course.course_id, ids), { success: `Branch availability saved for ${course.course_code}`, invalidate: [courseKeys.all] });
  return (
    <FormDialog
      title={`Branch availability · ${course.course_code}`}
      description={course.course_title}
      onOpen={() => setIds((branches.data ?? []).filter((b) => course.branches.includes(b.branch_code)).map((b) => b.branch_id))}
      onSubmit={() => save.mutateAsync(undefined)}
      trigger={
        <Button size="sm" variant="ghost" title={`Branches for ${course.course_code}`}>
          <MapPin />
          Branches
        </Button>
      }
    >
      <fieldset className="space-y-2 text-sm">
        <legend className="sr-only">Branches offering this course</legend>
        {(branches.data ?? []).map((b) => (
          <label key={b.branch_id} className="flex items-center gap-2">
            <input type="checkbox" checked={ids.includes(b.branch_id)} onChange={(e) => setIds(e.target.checked ? [...ids, b.branch_id] : ids.filter((x) => x !== b.branch_id))} />
            {b.branch_name} ({b.branch_code})
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}

function ComponentsDialog({ course }: { course: Course }) {
  const standalone = useQuery({ queryKey: courseKeys.list({ type: "standalone", status: "Active", per_page: 100 }), queryFn: () => coursesApi.list({ type: "standalone", status: "Active", per_page: 100 }) });
  const [rows, setRows] = useState<{ course_id: number; is_bonus: boolean }[]>([]);
  const [pick, setPick] = useState("");
  const save = useApiMutation(() => coursesApi.setComponents(course.course_id, rows.map((r, i) => ({ ...r, sort_order: i }))), {
    success: `Components saved for ${course.course_code}`,
    invalidate: [courseKeys.all],
  });
  const title = (id: number) => standalone.data?.data.find((c) => c.course_id === id)?.course_title ?? course.components.find((c) => c.course_id === id)?.course_title ?? `#${id}`;
  return (
    <FormDialog
      title={`Combo components · ${course.course_code}`}
      description="Standalone courses only; mark bonus courses."
      disabled={!rows.length}
      onOpen={() => setRows(course.components.map((c) => ({ course_id: c.course_id, is_bonus: c.is_bonus })))}
      onSubmit={() => save.mutateAsync(undefined)}
      wide
      trigger={
        <Button size="sm" variant="ghost">
          <Layers />
          Components
        </Button>
      }
    >
      <ul className="space-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.course_id} className="flex items-center justify-between gap-2 rounded-md border p-2">
            <span className="min-w-0 truncate">{title(r.course_id)}</span>
            <span className="flex shrink-0 items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={r.is_bonus} onChange={(e) => setRows(rows.map((x) => (x.course_id === r.course_id ? { ...x, is_bonus: e.target.checked } : x)))} />
                Bonus
              </label>
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${title(r.course_id)}`} onClick={() => setRows(rows.filter((x) => x.course_id !== r.course_id))}>
                <Trash2 />
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-2">
        <Field label="Add component" htmlFor="cc-pick" className="flex-1">
          <NativeSelect
            id="cc-pick"
            value={pick}
            placeholder="Choose course…"
            options={(standalone.data?.data ?? []).filter((c) => !rows.some((r) => r.course_id === c.course_id)).map((c) => ({ value: c.course_id, label: `${c.course_title} (${c.course_code})` }))}
            onChange={(e) => setPick(e.target.value)}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={!pick}
          onClick={() => {
            setRows([...rows, { course_id: Number(pick), is_bonus: false }]);
            setPick("");
          }}
        >
          Add
        </Button>
      </div>
    </FormDialog>
  );
}

// ---------------------------------------------------------------- payment plans

function PaymentPlans() {
  const { isAdmin } = useAuth();
  const plans = useQuery({ queryKey: courseKeys.plans(isAdmin), queryFn: () => coursesApi.plans(isAdmin) });
  return (
    <Section title="Payment plans" subtitle="Instalment percentages and due-day windows used by fee discussions" className="mt-4" action={isAdmin ? <PlanDialog /> : undefined}>
      <DataTable
        rows={plans.data}
        loading={plans.isLoading}
        error={plans.error}
        onRetry={() => void plans.refetch()}
        rowKey={(p) => p.payment_plan_id}
        empty={<Empty title="No payment plans" />}
        columns={[
          { header: "Code", cell: (p) => <b>{p.plan_code}</b> },
          { header: "Plan", cell: (p) => p.plan_name },
          {
            header: "Instalments",
            cell: (p) => (
              <span className="block max-w-96 whitespace-normal text-xs">
                {p.installments
                  .map((i) => `#${i.installment_no}: ${Number(i.percent_of_fee)}% · day ${i.due_days_after_admission}${i.due_days_min !== null && i.due_days_max !== null && i.due_days_min !== i.due_days_max ? ` (${i.due_days_min}–${i.due_days_max})` : ""}`)
                  .join(" · ")}
              </span>
            ),
          },
          { header: "Description", cell: (p) => <span className="block max-w-64 truncate" title={p.description ?? ""}>{p.description ?? "—"}</span> },
          { header: "Status", cell: (p) => <Status>{p.is_active ? "Active" : "Inactive"}</Status> },
          { header: "", cell: (p) => (isAdmin ? <PlanDialog plan={p} /> : null) },
        ]}
      />
    </Section>
  );
}

type InstallmentForm = { percent_of_fee: string; due_days_after_admission: string; due_days_min: string; due_days_max: string };

function PlanDialog({ plan }: { plan?: PaymentPlan }) {
  const blankRow: InstallmentForm = { percent_of_fee: "", due_days_after_admission: "0", due_days_min: "", due_days_max: "" };
  const [f, setF] = useState({ plan_code: "", plan_name: "", description: "", is_active: true, installments: [blankRow] });
  const toBody = (): Installment[] =>
    f.installments.map((i) => ({
      percent_of_fee: i.percent_of_fee.trim(),
      due_days_after_admission: Number(i.due_days_after_admission || 0),
      ...(i.due_days_min !== "" ? { due_days_min: Number(i.due_days_min) } : {}),
      ...(i.due_days_max !== "" ? { due_days_max: Number(i.due_days_max) } : {}),
    }));
  const total = sumMoney(f.installments.map((i) => i.percent_of_fee || "0"));
  const save = useApiMutation(
    () =>
      plan
        ? coursesApi.updatePlan(plan.payment_plan_id, { plan_name: f.plan_name.trim(), description: f.description.trim() || null, is_active: f.is_active, installments: toBody() })
        : coursesApi.createPlan({ plan_code: f.plan_code.trim(), plan_name: f.plan_name.trim(), description: f.description.trim() || null, installments: toBody() }),
    { success: (p) => `Payment plan ${p.plan_code} saved`, invalidate: [["payment-plans"]] },
  );
  const setRow = (i: number, patch: Partial<InstallmentForm>) => setF({ ...f, installments: f.installments.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <FormDialog
      title={plan ? `Edit ${plan.plan_code}` : "New payment plan"}
      description="Instalment percentages must total 100%."
      wide
      disabled={!f.plan_name.trim() || (!plan && !f.plan_code.trim()) || f.installments.some((i) => !i.percent_of_fee.trim())}
      onOpen={() =>
        setF(
          plan
            ? {
                plan_code: plan.plan_code,
                plan_name: plan.plan_name,
                description: plan.description ?? "",
                is_active: plan.is_active,
                installments: plan.installments.map((i) => ({
                  percent_of_fee: String(Number(i.percent_of_fee)),
                  due_days_after_admission: String(i.due_days_after_admission),
                  due_days_min: i.due_days_min == null ? "" : String(i.due_days_min),
                  due_days_max: i.due_days_max == null ? "" : String(i.due_days_max),
                })),
              }
            : { plan_code: "", plan_name: "", description: "", is_active: true, installments: [blankRow] },
        )
      }
      onSubmit={() => save.mutateAsync(undefined)}
      submitLabel="Save plan"
      trigger={
        plan ? (
          <Button size="sm" variant="ghost">
            <Pencil />
            Edit
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Plus />
            New plan
          </Button>
        )
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!plan && (
          <Field label="Plan code" htmlFor="pp-code" hint="e.g. THREE_INSTALMENTS">
            <Input id="pp-code" value={f.plan_code} onChange={(e) => setF({ ...f, plan_code: e.target.value.toUpperCase() })} />
          </Field>
        )}
        <Field label="Plan name" htmlFor="pp-name">
          <Input id="pp-name" value={f.plan_name} onChange={(e) => setF({ ...f, plan_name: e.target.value })} />
        </Field>
      </div>
      <Field label="Plan description" htmlFor="pp-desc">
        <Textarea id="pp-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      {plan && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />
          Active (available for new fee discussions)
        </label>
      )}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase text-muted-foreground">Instalments · total {Number(total)}%</div>
        {f.installments.map((r, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
            <Field label={`#${i + 1} % of fee`} htmlFor={`pi-pct-${i}`}>
              <Input id={`pi-pct-${i}`} inputMode="decimal" value={r.percent_of_fee} onChange={(e) => setRow(i, { percent_of_fee: e.target.value })} />
            </Field>
            <Field label="Due day" htmlFor={`pi-day-${i}`}>
              <Input id={`pi-day-${i}`} type="number" min={0} value={r.due_days_after_admission} onChange={(e) => setRow(i, { due_days_after_admission: e.target.value })} />
            </Field>
            <Field label="Earliest day" htmlFor={`pi-min-${i}`}>
              <Input id={`pi-min-${i}`} type="number" min={0} value={r.due_days_min} onChange={(e) => setRow(i, { due_days_min: e.target.value })} />
            </Field>
            <Field label="Latest day" htmlFor={`pi-max-${i}`}>
              <Input id={`pi-max-${i}`} type="number" min={0} value={r.due_days_max} onChange={(e) => setRow(i, { due_days_max: e.target.value })} />
            </Field>
            <Button type="button" size="icon" variant="ghost" aria-label={`Remove instalment ${i + 1}`} disabled={f.installments.length === 1} onClick={() => setF({ ...f, installments: f.installments.filter((_, j) => j !== i) })}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => setF({ ...f, installments: [...f.installments, blankRow] })}>
          <Plus />
          Add instalment
        </Button>
      </div>
    </FormDialog>
  );
}
