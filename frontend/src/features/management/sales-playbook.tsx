/**
 * Sales playbook (CRM AI v2.0): approved knowledge and reply templates, course paths, AI controls per branch,
 * recovery lists and the playbook measures. Admins and Branch Managers maintain knowledge (a BM for their branch);
 * the Branch Manager or an admin approves course paths. Nothing here sends a message.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Plus } from "lucide-react";
import {
  KNOWLEDGE_KINDS,
  RECOVERY_LISTS,
  REPLY_SITUATIONS,
  playbookApi,
  playbookKeys,
  type AiControl,
  type Knowledge,
  type RecoveryListKey,
} from "@/api/playbook";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, CourseSelect, Field, NativeSelect, applyServerErrors, cleanBody } from "@/components/crm/forms";
import { DataTable, Empty, Facts, KpiCard, PageHead, Section, Status, Warning } from "@/components/crm/ui";
import { date, dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export const PLAYBOOK_TABS = ["knowledge", "paths", "controls", "recovery", "measures"] as const;
export type PlaybookTab = (typeof PLAYBOOK_TABS)[number];
const opt = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));
const statusKind = (s: string) => (s === "Approved" ? "good" : s === "Draft" ? "warn" : "neutral");

export function SalesPlaybookPage({ tab, onTab }: { tab: PlaybookTab; onTab: (tab: PlaybookTab) => void }) {
  const { hasRole } = useAuth();
  const manager = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER");
  const tabs: [PlaybookTab, string, boolean][] = [
    ["knowledge", "Knowledge & templates", manager],
    ["paths", "Course paths", manager],
    ["controls", "AI controls", manager],
    ["recovery", "Recovery lists", manager],
    ["measures", "Measures", manager],
  ];
  const visible = tabs.filter(([, , show]) => show);
  const current = visible.some(([t]) => t === tab) ? tab : visible[0]?.[0];
  return (
    <>
      <PageHead title="Sales playbook" description="Approved knowledge, course paths, AI assistance controls, recovery lists and conversion measures" />
      <Tabs value={current} onValueChange={(v) => onTab(v as PlaybookTab)}>
        <TabsList className="mb-4 h-auto max-w-full flex-wrap justify-start">
          {visible.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="knowledge">
          <KnowledgeTab />
        </TabsContent>
        <TabsContent value="paths">
          <PathsTab />
        </TabsContent>
        <TabsContent value="controls">
          <ControlsTab />
        </TabsContent>
        <TabsContent value="recovery">
          <RecoveryTab />
        </TabsContent>
        <TabsContent value="measures">
          <MeasuresTab />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- knowledge

function KnowledgeTab() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("FOUNDER_CEO", "SUPER_ADMIN");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [edit, setEdit] = useState<Knowledge | "new" | null>(null);
  const query = { kind: kind || undefined, status: status || undefined };
  const items = useQuery({ queryKey: playbookKeys.knowledge(query), queryFn: () => playbookApi.knowledge(query) });
  const act = useApiMutation(({ id, to }: { id: number; to: "approve" | "retire" }) => (to === "approve" ? playbookApi.approveKnowledge(id) : playbookApi.retireKnowledge(id)), {
    success: (k) => `${k.title}: ${k.status}`,
    invalidate: [["playbook", "knowledge"]],
  });
  return (
    <Section
      title="Approved sales knowledge"
      subtitle="Staff and AI use only Approved items. Editing an approved item makes a new Draft version that needs approval."
      action={
        <Button size="sm" onClick={() => setEdit("new")}>
          <Plus />
          Add item
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <NativeSelect aria-label="Kind" className="max-w-56" options={[{ value: "", label: "All kinds" }, ...opt(KNOWLEDGE_KINDS)]} value={kind} onChange={(e) => setKind(e.target.value)} />
        <NativeSelect aria-label="Status" className="max-w-40" options={[{ value: "", label: "Any status" }, ...opt(["Draft", "Approved", "Retired"])]} value={status} onChange={(e) => setStatus(e.target.value)} />
      </div>
      <DataTable
        stack
        rows={items.data}
        loading={items.isLoading}
        error={items.error}
        onRetry={() => void items.refetch()}
        rowKey={(k) => k.knowledge_id}
        empty={<Empty title="No knowledge items">Add syllabus links, branch locations, fee rules and reply templates.</Empty>}
        columns={[
          {
            header: "Item",
            cell: (k) => (
              <span className="block max-w-[28rem] whitespace-normal">
                <span className="font-semibold text-foreground">{k.title}</span>
                <small className="block">
                  {k.kind}
                  {k.situation ? ` · ${k.situation}` : ""} · {k.language} · v{k.version}
                </small>
                <small className="block text-muted-foreground">{k.body.slice(0, 140)}</small>
              </span>
            ),
          },
          { header: "Scope", cell: (k) => `${k.course?.course_title ?? "Any course"} · ${k.branch?.branch_name ?? "All branches"}` },
          {
            header: "Status",
            cell: (k) => (
              <span>
                <Status kind={statusKind(k.status)}>{k.status}</Status>
                {k.is_stale && <Status kind="warn">Review due</Status>}
                {k.approved_by && <small className="block">{k.approved_by.full_name} · {date(k.approved_at)}</small>}
              </span>
            ),
          },
          {
            header: "",
            cell: (k) =>
              k.status !== "Retired" &&
              (isAdmin || k.branch) && (
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" onClick={() => setEdit(k)}>
                    Edit
                  </Button>
                  {k.status === "Draft" && (
                    <Button size="sm" onClick={() => act.mutate({ id: k.knowledge_id, to: "approve" })}>
                      Approve
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: k.knowledge_id, to: "retire" })}>
                    Retire
                  </Button>
                </span>
              ),
          },
        ]}
      />
      {edit && <KnowledgeDialog item={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </Section>
  );
}

type KnowledgeValues = { kind: string; title: string; course_id: string; branch_id: string; situation: string; language: string; body: string; link_url: string; review_due_on: string };

function KnowledgeDialog({ item, onClose }: { item: Knowledge | null; onClose: () => void }) {
  const form = useForm<KnowledgeValues>({
    defaultValues: {
      kind: item?.kind ?? "FAQ answer",
      title: item?.title ?? "",
      course_id: item?.course ? String(item.course.course_id) : "",
      branch_id: item?.branch ? String(item.branch.branch_id) : "",
      situation: item?.situation ?? "",
      language: item?.language ?? "English",
      body: item?.body ?? "",
      link_url: item?.link_url ?? "",
      review_due_on: item?.review_due_on ?? "",
    },
  });
  const kind = form.watch("kind");
  const save = useApiMutation(
    (v: KnowledgeValues) => {
      const body = { ...cleanBody(v, ["course_id", "branch_id"]), course_id: v.course_id ? Number(v.course_id) : null, branch_id: v.branch_id ? Number(v.branch_id) : null, situation: v.kind === "Reply template" ? v.situation : null, link_url: v.link_url || null, review_due_on: v.review_due_on || null };
      return item ? playbookApi.updateKnowledge(item.knowledge_id, body) : playbookApi.createKnowledge(body);
    },
    { success: "Saved as Draft — approve it to make it available", invalidate: [["playbook", "knowledge"]], silentValidation: true, onSuccess: onClose, onError: (e) => applyServerErrors(form, e) },
  );
  const err = (f: keyof KnowledgeValues) => form.formState.errors[f]?.message;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? `Edit · ${item.title}` : "New knowledge item"}</DialogTitle>
          <DialogDescription>Use verified facts only. Placeholders in templates: {"{name} {course} {branch} {approved_link} {time} {specific_question} {date_time} {branch_or_mode} {approved_location_or_link}"}</DialogDescription>
        </DialogHeader>
        <form id="knowledge-form" className="grid gap-3" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" error={err("kind")}>
              <NativeSelect options={opt(KNOWLEDGE_KINDS)} {...form.register("kind")} />
            </Field>
            <Field label="Language" error={err("language")}>
              <NativeSelect options={opt(["English", "Telugu"])} {...form.register("language")} />
            </Field>
          </div>
          {kind === "Reply template" && (
            <Field label="Situation" error={err("situation")}>
              <NativeSelect options={opt(REPLY_SITUATIONS)} {...form.register("situation", { required: "Required for templates" })} />
            </Field>
          )}
          <Field label="Title" error={err("title")}>
            <Input {...form.register("title", { required: "Required" })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Course" error={err("course_id")}>
              <CourseSelect placeholder="Any course" {...form.register("course_id")} />
            </Field>
            <Field label="Branch" error={err("branch_id")} hint="Branch Managers: your branch. All branches: admins only.">
              <BranchSelect placeholder="All branches" {...form.register("branch_id")} />
            </Field>
          </div>
          <Field label={kind === "Reply template" ? "Template text" : "Content"} error={err("body")}>
            <Textarea rows={5} {...form.register("body", { required: "Required" })} />
          </Field>
          <Field label="Approved link" error={err("link_url")} hint={kind === "Syllabus" || kind === "Brochure" ? "Required for syllabus / brochure" : undefined}>
            <Input type="url" {...form.register("link_url")} />
          </Field>
          <Field label="Review by" error={err("review_due_on")} hint="Shown as stale after this date">
            <Input type="date" {...form.register("review_due_on")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="knowledge-form" disabled={save.isPending}>
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- course paths

function PathsTab() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER");
  const paths = useQuery({ queryKey: playbookKeys.paths({}), queryFn: () => playbookApi.paths({}) });
  const [adding, setAdding] = useState(false);
  const act = useApiMutation(({ id, to }: { id: number; to: "approve" | "retire" }) => (to === "approve" ? playbookApi.approvePath(id) : playbookApi.retirePath(id)), {
    success: (p) => `${p.from_course.course_title} → ${p.to_course.course_title}: ${p.status}`,
    invalidate: [["playbook", "paths"], ["playbook", "suggestions"]],
  });
  return (
    <Section
      title="Course paths"
      subtitle="Illustrative seeds start as Draft. The academic owner approves mappings, prerequisites and overlap before staff see suggestions."
      action={
        canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add path
          </Button>
        )
      }
    >
      <DataTable
        stack
        rows={paths.data}
        loading={paths.isLoading}
        error={paths.error}
        onRetry={() => void paths.refetch()}
        rowKey={(p) => p.course_path_id}
        empty={<Empty title="No course paths" />}
        columns={[
          { header: "Path", cell: (p) => <span className="font-semibold text-foreground">{p.from_course.course_title} → {p.to_course.course_title}</span> },
          {
            header: "Benefit / when",
            cell: (p) => (
              <span className="block max-w-[26rem] whitespace-normal text-sm">
                {p.learner_benefit}
                {p.helps_when && <small className="block">Helps: {p.helps_when}</small>}
                {p.skip_when && <small className="block">Skip: {p.skip_when}</small>}
              </span>
            ),
          },
          { header: "Status", cell: (p) => <Status kind={statusKind(p.status)}>{p.status}</Status> },
          {
            header: "",
            cell: (p) =>
              canEdit &&
              p.status !== "Retired" && (
                <span className="flex gap-1">
                  {p.status === "Draft" && (
                    <Button size="sm" onClick={() => act.mutate({ id: p.course_path_id, to: "approve" })}>
                      Approve
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: p.course_path_id, to: "retire" })}>
                    Retire
                  </Button>
                </span>
              ),
          },
        ]}
      />
      {adding && <PathDialog onClose={() => setAdding(false)} />}
    </Section>
  );
}

function PathDialog({ onClose }: { onClose: () => void }) {
  const form = useForm({ defaultValues: { from_course_id: "", to_course_id: "", learner_benefit: "", helps_when: "", skip_when: "", prerequisites: "", suggested_question: "" } });
  const save = useApiMutation((v: Record<string, string>) => playbookApi.createPath({ ...cleanBody(v), from_course_id: Number(v.from_course_id), to_course_id: Number(v.to_course_id) }), {
    success: "Path saved as Draft",
    invalidate: [["playbook", "paths"]],
    silentValidation: true,
    onSuccess: onClose,
    onError: (e) => applyServerErrors(form, e),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New course path</DialogTitle>
          <DialogDescription>Course aliases and renamed packages must map to the same entitlement check.</DialogDescription>
        </DialogHeader>
        <form id="path-form" className="grid gap-3" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <Field label="From course" error={form.formState.errors.from_course_id?.message}>
            <CourseSelect {...form.register("from_course_id", { required: "Required" })} />
          </Field>
          <Field label="To course" error={form.formState.errors.to_course_id?.message}>
            <CourseSelect {...form.register("to_course_id", { required: "Required" })} />
          </Field>
          <Field label="Learner benefit" error={form.formState.errors.learner_benefit?.message}>
            <Textarea {...form.register("learner_benefit", { required: "Required" })} />
          </Field>
          <Field label="When it may help">
            <Input {...form.register("helps_when")} />
          </Field>
          <Field label="When to skip">
            <Input {...form.register("skip_when")} />
          </Field>
          <Field label="Prerequisites">
            <Input {...form.register("prerequisites")} />
          </Field>
          <Field label="Suggested question">
            <Input {...form.register("suggested_question")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="path-form" disabled={save.isPending}>
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- AI controls

function ControlsTab() {
  const controls = useQuery({ queryKey: playbookKeys.controls, queryFn: playbookApi.controls });
  return (
    <Section title="AI assistance per branch" subtitle="Observe: suggestions only. Assist: drafts for one reviewed staff action (default). Approved automatic needs a tested live channel — not available yet.">
      <div className="grid gap-3 md:grid-cols-2">
        {controls.data?.map((c) => (
          <ControlCard key={c.branch.branch_id} c={c} />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Pausing stops suggestions and drafts only. Calls, notes, outcomes and deal work continue normally.</p>
    </Section>
  );
}

function ControlCard({ c }: { c: AiControl }) {
  const [reason, setReason] = useState("");
  const update = useApiMutation((body: { execution_profile?: string; is_paused?: boolean; pause_reason?: string | null }) => playbookApi.updateControl(c.branch.branch_id, body), {
    success: "AI controls updated",
    invalidate: [playbookKeys.controls, ["playbook", "workbench"]],
    onSuccess: () => setReason(""),
  });
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <p className="font-semibold">{c.branch.branch_name}</p>
        <Status kind={c.is_paused ? "danger" : "good"}>{c.is_paused ? "Paused" : c.execution_profile}</Status>
      </div>
      {c.is_paused && <p className="mt-1 text-sm text-muted-foreground">Paused by {c.paused_by?.full_name} · {dateTime(c.paused_at)}: {c.pause_reason}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Profile">
          <NativeSelect options={opt(["Observe", "Assist"])} value={c.execution_profile} onChange={(e) => update.mutate({ execution_profile: e.target.value })} />
        </Field>
        {c.is_paused ? (
          <Button size="sm" onClick={() => update.mutate({ is_paused: false })}>
            Resume
          </Button>
        ) : (
          <>
            <Input placeholder="Reason to pause" value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-56" aria-label="Pause reason" />
            <Button size="sm" variant="destructive" disabled={!reason.trim()} onClick={() => update.mutate({ is_paused: true, pause_reason: reason })}>
              Pause
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- recovery lists

function RecoveryTab() {
  const branchId = useBranchFilter();
  const [list, setList] = useState<RecoveryListKey>("no_first_attempt");
  const [picked, setPicked] = useState<number[]>([]);
  const query = { branch_id: branchId };
  const counts = useQuery({ queryKey: playbookKeys.recoveryCounts(query), queryFn: () => playbookApi.recoveryCounts(query) });
  const rows = useQuery({ queryKey: playbookKeys.recovery(list, query), queryFn: () => playbookApi.recoveryList(list, query) });
  const make = useApiMutation(() => playbookApi.recoveryTasks({ list, lead_ids: picked }), {
    success: (r) => `${r.created.length} task(s) created${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`,
    invalidate: [["playbook"], ["tasks"]],
    onSuccess: () => setPicked([]),
  });
  const d = rows.data;
  const leadRows = d?.rows.filter((r) => r.lead) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {RECOVERY_LISTS.map((key) => {
          const c = counts.data?.find((x) => x.list === key);
          return (
            <Button key={key} size="sm" variant={list === key ? "default" : "outline"} onClick={() => (setList(key), setPicked([]))}>
              {c?.label ?? key}
              {c?.count != null && <span className="ml-1 opacity-75">{c.count}</span>}
            </Button>
          );
        })}
      </div>
      <Section
        title={d?.label ?? "Recovery list"}
        subtitle={counts.data?.find((x) => x.list === list)?.suggested_action}
        action={
          list !== "existing_student" && (
            <Button size="sm" disabled={!picked.length || make.isPending} onClick={() => make.mutate(undefined)}>
              Create {picked.length || ""} follow-up task(s)
            </Button>
          )
        }
      >
        {d && d.excluded.length > 0 && (
          <Warning>
            Excluded: {d.excluded.map((e) => `${e.count} · ${e.reason}`).join("; ")}
          </Warning>
        )}
        {list === "existing_student" ? (
          <DataTable
            stack
            rows={d?.rows}
            loading={rows.isLoading}
            error={rows.error}
            rowKey={(r) => `${r.person?.person_id}-${r.course?.course_id}`}
            empty={<Empty title="No useful next course found" />}
            columns={[
              {
                header: "Student",
                cell: (r) => (
                  <Link to="/persons/$personId" params={{ personId: String(r.person!.person_id) }} className="font-semibold text-primary">
                    {r.person!.full_name}
                  </Link>
                ),
              },
              { header: "Suggested course", cell: (r) => r.course?.course_title },
              { header: "Why", cell: (r) => r.evidence },
            ]}
          />
        ) : (
          <DataTable
            stack
            rows={leadRows}
            loading={rows.isLoading}
            error={rows.error}
            rowKey={(r) => r.lead!.lead_id}
            empty={<Empty title="Nobody on this list" />}
            columns={[
              {
                header: "Select",
                cell: (r) => (
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.lead!.name}`}
                    checked={picked.includes(r.lead!.lead_id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, r.lead!.lead_id] : picked.filter((x) => x !== r.lead!.lead_id))}
                  />
                ),
              },
              {
                header: "Lead",
                cell: (r) => (
                  <Link to="/leads/$leadId" params={{ leadId: String(r.lead!.lead_id) }} className="font-semibold text-primary">
                    {r.lead!.name}
                    <small className="block font-normal text-muted-foreground">
                      {r.lead!.lead_code} · {r.lead!.course?.course_title ?? "No course"} · {r.lead!.branch.branch_name}
                    </small>
                  </Link>
                ),
              },
              { header: "Evidence", cell: (r) => <span className="block max-w-[24rem] whitespace-normal">{r.evidence}</span> },
              { header: "Owner", cell: (r) => r.lead!.owner ?? <Status kind="warn">Unassigned</Status> },
              { header: "Task", cell: (r) => (r.recovery_task_open ? <Status kind="info">Task open</Status> : null) },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- measures

function MeasuresTab() {
  const branchId = useBranchFilter();
  const [period, setPeriod] = useState("This Month");
  const query = { period, branch_id: branchId };
  const m = useQuery({ queryKey: playbookKeys.measures(query), queryFn: () => playbookApi.measures(query) });
  const d = m.data;
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);
  return (
    <div className="space-y-4">
      <NativeSelect aria-label="Period" className="max-w-48" options={opt(["Today", "This Week", "Last Week", "This Month", "Last Month"])} value={period} onChange={(e) => setPeriod(e.target.value)} />
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="First attempt within SLA" value={pct(d.first_attempt.pct_within_sla)} hint={`${d.first_attempt.met} of ${d.first_attempt.eligible - d.first_attempt.pending} eligible`} tone="violet" />
            <KpiCard label="Due callbacks completed" value={pct(d.callbacks.pct_completed)} hint={`${d.callbacks.missed_open} missed and still open`} tone="blue" />
            <KpiCard label="Demo attendance" value={pct(d.demos.pct_attended)} hint={`${d.demos.attended} attended · ${d.demos.no_show} no-show`} tone="green" />
            <KpiCard label="Qualified → verified paid" value={pct(d.qualified_to_paid.pct)} hint={`${d.qualified_to_paid.paid} of ${d.qualified_to_paid.qualified}${d.qualified_to_paid.immature ? " · cohort still maturing" : ""}`} tone="amber" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Recovery and cross-course">
              <Facts
                columns={1}
                items={[
                  ["Recovery actions → recovered paid", `${d.recovery.recovery_actions} → ${d.recovery.recovered_paid}`],
                  ["Course suggestions reviewed", String(d.cross_course.reviewed)],
                  ["Discussed · ignored · snoozed", `${d.cross_course.used} · ${d.cross_course.ignored} · ${d.cross_course.snoozed}`],
                  ["Interested leads → verified paid", `${d.cross_course.interested_leads} → ${d.cross_course.paid}`],
                  ["Demos: outcome missing · cancelled · rescheduled", `${d.demos.outcome_missing} · ${d.demos.cancelled} · ${d.demos.rescheduled}`],
                ]}
              />
            </Section>
            <Section title="Assistance quality" subtitle={`${d.assistance.model_fallbacks} counselling brief(s) fell back to rules`}>
              {d.assistance.by_status.length ? (
                <Facts columns={1} items={d.assistance.by_status.map((r) => [`${r.action_type} · ${r.status}`, String(r.count)] as [string, string])} />
              ) : (
                <p className="text-sm text-muted-foreground">No suggestions acted on in this period.</p>
              )}
            </Section>
          </div>
          <Section title="Source and branch quality" subtitle="Genuine leads, qualified deals and verified paid outcomes per source">
            <DataTable
              stack
              rows={d.sources}
              rowKey={(r) => `${r.source}-${r.branch}`}
              empty={<Empty title="No leads in this period" />}
              columns={[
                { header: "Source", cell: (r) => r.source },
                { header: "Branch", cell: (r) => r.branch },
                { header: "Genuine leads", cell: (r) => r.genuine_leads },
                { header: "Deals", cell: (r) => r.deals },
                { header: "Verified paid", cell: (r) => r.verified_paid },
              ]}
            />
          </Section>
          {d.notes.map((n) => (
            <p key={n} className="text-xs text-muted-foreground">
              {n}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
