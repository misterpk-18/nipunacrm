import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { CalendarDays, CalendarPlus, Handshake, IndianRupee, Mail, Pencil, Phone, PlusCircle, RotateCcw, Sparkles, UserCog, XCircle } from "lucide-react";
import { get, list, post } from "@/api/client";
import { FOLLOW_UP_PURPOSES, FOLLOW_UP_RESPONSES, MANUAL_INTAKE, REACTIVATE_STAGES, leadKeys, leadsApi, useLead, type Lead } from "@/api/leads";
import { pipelineApi, pipelineKeys } from "@/api/pipeline";
import { useLookups } from "@/api/reference";
import type { BranchRef, CourseRef, Money, UserRef } from "@/api/types";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CourseSelect, Field, LookupSelect, NativeSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { AiNote, DataTable, Empty, ErrorPanel, Facts, LeadChip, LoadingRows, PageHead, PriorityChip, QueryView, Section, Status, Warning, WhatsAppButton } from "@/components/crm/ui";
import { CommercialPanel, DeliveryPlanPanel } from "@/features/sales/deal-panels";
import { SALES_SIDE } from "@/features/sales/shared";
import { ConvertDialog, QualificationPanel } from "./qualification";
import { date, dateTime, fromLocalInput, money, phone, relative, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { NewLeadDialog } from "./new-lead-dialog";

// Minimal shapes for the related-record tabs (full types live in each module's api file).
type DemoRow = { demo_id: number; demo_code: string; scheduled_at: string; duration_minutes: number; mode: string; trainer: UserRef | null; status: string; outcome: string | null };
type FeeVersion = { version_id: number; version_no: number; status: string; final_payable: Money; payment_plan: { plan_name: string } | null; valid_until: string | null };
type FeeDiscussion = { fee_discussion_id: number; discussion_code: string; milestone: string; course: CourseRef | null; current_version: FeeVersion | null; created_at: string };
type TaskRow = { task_id: number; title: string; task_type: string; owner: UserRef | null; team_role: string | null; status: string; original_due_at: string; revised_due_at: string | null; is_overdue: boolean };
type Enquiry = { enquiry_id: number; enquiry_code?: string; course?: CourseRef | null; branch?: BranchRef; lead_source?: string; contact_channel?: string; message?: string | null; created_at: string };
type Insight = { insight_id: number; insight_type: string; content: string | Record<string, unknown>; created_at: string };

const workable = (lead: Lead) => lead.is_open && lead.stage !== "Admitted";

export function Lead360({ leadId }: { leadId: number }) {
  const lead = useLead(leadId);
  const [tab, setTab] = useState("timeline");
  const [dialog, setDialog] = useState<null | "convert" | "edit" | "assign" | "stage" | "lost" | "reactivate" | "demo" | "another" | "activity">(null);
  const { hasRole } = useAuth();

  if (lead.isLoading) return <LoadingRows rows={8} />;
  if (lead.error) return <ErrorPanel error={lead.error} onRetry={() => void lead.refetch()} />;
  const l = lead.data!;
  const p = l.person;
  const digits = p.phone.replace(/\D/g, "");
  const close = () => setDialog(null);
  const converted = l.converted_at !== null;

  return (
    <>
      <PageHead
        title={l.name}
        description={`${l.lead_code} · ${p.person_code} · ${l.branch.branch_name} · ${l.course?.course_title ?? "No course yet"} · ${l.original_source} · Owner: ${l.owner?.full_name ?? "Unassigned"}`}
      />
      <div className="lead-actions mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 pr-2 sm:border-r">
          <Phone className="size-4 text-muted-foreground" />
          <div className="leading-tight">
            <div className="text-[11px] text-muted-foreground">Phone number</div>
            <div className="text-sm font-semibold">{phone(p.phone)}</div>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={`tel:+${digits}`}>
            <Phone />
            Call
          </a>
        </Button>
        <WhatsAppButton phone={p.whatsapp_number ?? p.phone} />
        {p.email && (
          <Button variant="outline" size="sm" asChild>
            <a href={`mailto:${p.email}`}>
              <Mail />
              Email
            </a>
          </Button>
        )}
        {converted ? (
          l.pipeline_entry_id !== null && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/pipeline" search={{ q: l.lead_code }}>
                <Handshake />
                Deal in pipeline
              </Link>
            </Button>
          )
        ) : (
          workable(l) &&
          hasRole(...SALES_SIDE) && (
            <Button size="sm" disabled={!l.qualified_at} title={l.qualified_at ? "Convert to deal" : "Complete the qualification review first"} onClick={() => setDialog("convert")}>
              <Handshake />
              Convert to deal
            </Button>
          )
        )}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Status>{l.stage}</Status>
        {l.ai_priority && <PriorityChip priority={l.ai_priority} score={l.ai_score} />}
        <LeadChip value={l.intake_status} />
        <Status kind={converted ? "info" : "neutral"}>{converted ? "Deal" : l.qualified_at ? "Qualified lead" : "Lead"}</Status>
        <span className="break-all text-sm text-muted-foreground">
          {p.email ?? "no email"} · WhatsApp: {p.whatsapp_number ? phone(p.whatsapp_number) : "same as mobile"}
        </span>
      </div>
      {l.lost && (
        <div className="mb-4">
          <Warning>
            Lost — {l.lost.reason ?? "no reason"}
            {l.lost.competitor ? ` · joined ${l.lost.competitor}` : ""}
            {l.lost.reactivation_date ? ` · reactivate on ${date(l.lost.reactivation_date)}` : ""}
            {l.lost.notes ? ` · ${l.lost.notes}` : ""}
          </Warning>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {workable(l) && (
          <>
            {converted && (
              <>
                <Button size="sm" variant="outline" onClick={() => setDialog("stage")}>
                  Move stage
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog("demo")}>
                  <CalendarPlus />
                  Schedule demo
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/fee-quote" search={{ leadId: l.lead_id }}>
                    <IndianRupee />
                    Fee discussion
                  </Link>
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => setDialog("activity")}>
              <PlusCircle />
              Log call / note
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>
              <Pencil />
              Edit
            </Button>
            {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER") && (
              <Button size="sm" variant="outline" onClick={() => setDialog("assign")}>
                <UserCog />
                Reassign
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDialog("lost")}>
              <XCircle />
              Mark lost
            </Button>
          </>
        )}
        {l.stage === "Lost - closed" && (
          <Button size="sm" variant="outline" onClick={() => setDialog("reactivate")}>
            <RotateCcw />
            Reactivate
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setDialog("another")}>
          <PlusCircle />
          Add another course
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="panel overflow-x-auto">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="min-w-max">
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="enquiries">Enquiries</TabsTrigger>
                <TabsTrigger value="demos">Demos</TabsTrigger>
                <TabsTrigger value="fees">Fees / Invoices</TabsTrigger>
                <TabsTrigger value="tasks">Tasks</TabsTrigger>
                <TabsTrigger value="ai">AI Insights</TabsTrigger>
              </TabsList>
              <div className="mt-5">
                <TabsContent value="timeline">
                  <Timeline leadId={l.lead_id} />
                </TabsContent>
                <TabsContent value="enquiries">
                  <Enquiries leadId={l.lead_id} />
                </TabsContent>
                <TabsContent value="demos">
                  <Demos leadId={l.lead_id} />
                </TabsContent>
                <TabsContent value="fees">
                  <Fees lead={l} />
                </TabsContent>
                <TabsContent value="tasks">
                  <Tasks leadId={l.lead_id} />
                </TabsContent>
                <TabsContent value="ai">
                  <Insights leadId={l.lead_id} />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          {!converted && <QualificationPanel lead={l} />}
          {converted && l.is_open && <DeliveryPlanPanel lead={l} />}
          {converted && <CommercialPanel lead={l} />}
          <Section title="Sales summary">
            <Facts
              columns={1}
              items={[
                ["Next follow-up", l.next_follow_up_at ? `${dateTime(l.next_follow_up_at)} (${relative(l.next_follow_up_at)})` : "Unscheduled"],
                ["Last contacted", dateTime(l.last_contacted_at)],
                ["In stage since", dateTime(l.stage_changed_at)],
                ["Contact channel · entry", `${l.contact_channel} · ${l.entry_method}`],
                ["Campaign / referral", l.campaign ?? "—"],
                ["Qualified · converted", `${l.qualified_at ? dateTime(l.qualified_at) : "Not yet"} · ${l.converted_at ? dateTime(l.converted_at) : "Not yet"}`],
                ["Remarks", l.remarks ?? "—"],
                ["Created", dateTime(l.created_at)],
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/persons/$personId" params={{ personId: String(p.person_id) }}>
                  Open person
                </Link>
              </Button>
            </div>
          </Section>
          {l.pipeline_entry_id !== null && <CardSummary entryId={l.pipeline_entry_id} leadId={l.lead_id} />}
          {workable(l) && (
            <Section title="Log follow-up" subtitle="Adds to the timeline and sets the next follow-up task">
              <FollowUpForm leadId={l.lead_id} />
            </Section>
          )}
        </div>
      </div>

      {dialog === "convert" && <ConvertDialog lead={l} onClose={close} />}
      {dialog === "edit" && <EditDialog lead={l} onClose={close} />}
      {dialog === "assign" && <AssignDialog lead={l} onClose={close} />}
      {dialog === "stage" && <StageDialog lead={l} onClose={close} />}
      {dialog === "lost" && <LostDialog lead={l} onClose={close} />}
      {dialog === "reactivate" && <ReactivateDialog lead={l} onClose={close} />}
      {dialog === "demo" && <ScheduleDemoDialog lead={l} onClose={close} />}
      {dialog === "activity" && <ActivityDialog lead={l} onClose={close} />}
      <NewLeadDialog open={dialog === "another"} onOpenChange={(o) => !o && close()} person={p} />
    </>
  );
}

// ---------------------------------------------------------------- tabs

/** The person's pipeline card this lead is on: shared stage, owner and the other courses. */
function CardSummary({ entryId, leadId }: { entryId: number; leadId: number }) {
  const card = useQuery({ queryKey: pipelineKeys.entry(entryId), queryFn: () => pipelineApi.get(entryId) });
  if (!card.data) return null;
  const c = card.data;
  const others = c.courses.filter((course) => course.lead_id !== leadId);
  return (
    <Section title="Pipeline card" subtitle={c.is_open ? "All open courses on the card share its stage" : `Closed ${dateTime(c.closed_at)}`}>
      <Facts
        columns={1}
        items={[
          ["Card", `${c.entry_code} · ${c.branch.branch_name}`],
          ["Card stage", <Status key="stage">{c.stage}</Status>],
          ["Card owner", c.owner?.full_name ?? "Unassigned"],
          [
            "Other courses on the card",
            others.length ? (
              <span key="others" className="flex flex-col">
                {others.map((o) => (
                  <Link key={o.lead_id} to="/leads/$leadId" params={{ leadId: String(o.lead_id) }} className="text-primary">
                    {o.course?.course_title ?? o.lead_code}
                  </Link>
                ))}
              </span>
            ) : (
              "None"
            ),
          ],
        ]}
      />
      {c.is_open && (
        <Button asChild size="sm" variant="outline" className="mt-3">
          <Link to="/pipeline" search={{ q: c.entry_code }}>
            Open in pipeline
          </Link>
        </Button>
      )}
    </Section>
  );
}

function Timeline({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: leadKeys.activities(leadId), queryFn: () => leadsApi.activities(leadId) });
  return (
    <QueryView query={{ ...q, data: q.data?.data }} empty={<Empty title="No activity yet" />}>
      {(rows) => (
        <ol className="space-y-4 border-l-2 pl-5">
          {rows.map((a) => (
            <li key={a.activity_id}>
              <div className="text-xs text-muted-foreground">
                {dateTime(a.occurred_at)} · {a.performed_by?.full_name ?? "System"}
              </div>
              <div className="text-sm font-semibold">
                {a.activity_type === "Stage Change" ? `${a.from_stage ?? "—"} → ${a.to_stage}` : a.activity_type}
                {a.direction ? ` · ${a.direction}` : ""}
                {a.channel ? ` · ${a.channel}` : ""}
              </div>
              {(a.summary || a.purpose || a.outcome) && (
                <div className="text-sm text-muted-foreground">{[...new Set([a.purpose, a.outcome, a.summary].filter(Boolean))].join(" · ")}</div>
              )}
            </li>
          ))}
        </ol>
      )}
    </QueryView>
  );
}

function Enquiries({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: ["leads", "enquiries", leadId], queryFn: () => get<Enquiry[]>(`/leads/${leadId}/enquiries`) });
  return (
    <QueryView query={q} empty={<Empty title="No enquiries linked" />}>
      {(rows) => (
        <DataTable
          rows={rows}
          rowKey={(e) => e.enquiry_id}
          columns={[
            { header: "Enquiry", cell: (e) => e.enquiry_code ?? `#${e.enquiry_id}` },
            { header: "Received", cell: (e) => dateTime(e.created_at) },
            { header: "Course", cell: (e) => e.course?.course_title ?? "—" },
            { header: "Source", cell: (e) => e.lead_source ?? "—" },
            { header: "Channel", cell: (e) => e.contact_channel ?? "—" },
            { header: "Message", cell: (e) => <span className="block max-w-72 truncate">{e.message ?? "—"}</span> },
          ]}
        />
      )}
    </QueryView>
  );
}

function Demos({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: ["demos", "lead", leadId], queryFn: () => list<DemoRow>("/demos", { lead_id: leadId }).then((p) => p.data) });
  return (
    <QueryView query={q} empty={<Empty title="No demos yet">Use “Schedule demo” above.</Empty>}>
      {(rows) => (
        <DataTable
          rows={rows}
          rowKey={(d) => d.demo_id}
          columns={[
            { header: "Demo", cell: (d) => d.demo_code },
            { header: "When", cell: (d) => dateTime(d.scheduled_at) },
            { header: "Duration", cell: (d) => `${d.duration_minutes} min` },
            { header: "Mode", cell: (d) => d.mode },
            { header: "Trainer", cell: (d) => d.trainer?.full_name ?? "—" },
            { header: "Status", cell: (d) => <Status>{d.status}</Status> },
            { header: "Outcome", cell: (d) => d.outcome ?? "—" },
          ]}
        />
      )}
    </QueryView>
  );
}

function Fees({ lead }: { lead: Lead }) {
  const q = useQuery({ queryKey: ["fee-discussions", "lead", lead.lead_id], queryFn: () => get<FeeDiscussion[]>(`/leads/${lead.lead_id}/fee-discussions`) });
  return (
    <QueryView
      query={q}
      empty={
        <Empty title="No fee discussion yet">
          <Link to="/fee-quote" search={{ leadId: lead.lead_id }} className="text-primary">
            Start a fee discussion
          </Link>
        </Empty>
      }
    >
      {(rows) => (
        <DataTable
          rows={rows}
          rowKey={(d) => d.fee_discussion_id}
          columns={[
            {
              header: "Discussion",
              cell: (d) => (
                <Link to="/fee-quote" search={{ leadId: lead.lead_id, discussionId: d.fee_discussion_id }} className="font-medium text-primary">
                  {d.discussion_code}
                </Link>
              ),
            },
            { header: "Milestone", cell: (d) => <Status>{d.milestone}</Status> },
            { header: "Version", cell: (d) => (d.current_version ? `v${d.current_version.version_no} · ${d.current_version.status}` : "—") },
            { header: "Final payable", cell: (d) => money(d.current_version?.final_payable) },
            { header: "Plan", cell: (d) => d.current_version?.payment_plan?.plan_name ?? "—" },
            { header: "Valid until", cell: (d) => date(d.current_version?.valid_until) },
          ]}
        />
      )}
    </QueryView>
  );
}

function Tasks({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: ["tasks", "lead", leadId], queryFn: () => list<TaskRow>("/tasks", { view: "team", lead_id: leadId, per_page: 50 }).then((p) => p.data) });
  return (
    <QueryView query={q} empty={<Empty title="No tasks on this lead" />}>
      {(rows) => (
        <DataTable
          rows={rows}
          rowKey={(t) => t.task_id}
          columns={[
            { header: "Task", cell: (t) => <span className="block max-w-72 truncate">{t.title}</span> },
            { header: "Type", cell: (t) => t.task_type },
            { header: "Owner", cell: (t) => t.owner?.full_name ?? (t.team_role ? `${t.team_role} team` : "Unassigned") },
            { header: "Original deadline", cell: (t) => dateTime(t.original_due_at) },
            { header: "Revised", cell: (t) => dateTime(t.revised_due_at) },
            { header: "Status", cell: (t) => <Status>{t.is_overdue && !["Completed", "Cancelled"].includes(t.status) ? "Overdue" : t.status}</Status> },
          ]}
        />
      )}
    </QueryView>
  );
}

function Insights({ leadId }: { leadId: number }) {
  const q = useQuery({ queryKey: ["ai", "lead", leadId], queryFn: () => get<Insight[]>(`/leads/${leadId}/ai/insights`) });
  const brief = useApiMutation(() => post<Insight>(`/leads/${leadId}/ai/brief`, { language: "English" }), {
    success: "AI brief generated",
    invalidate: [["ai", "lead", leadId]],
  });
  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" onClick={() => brief.mutate(undefined)} disabled={brief.isPending}>
        <Sparkles />
        Generate lead brief
      </Button>
      <QueryView query={q} empty={<Empty title="No AI insights yet">Generate a brief to get an advisory summary.</Empty>}>
        {(rows) => (
          <div className="space-y-3">
            {rows.map((i) => (
              <AiNote key={i.insight_id} title={`${i.insight_type} · ${dateTime(i.created_at)}`}>
                <div className="whitespace-pre-wrap">{typeof i.content === "string" ? i.content : JSON.stringify(i.content, null, 2)}</div>
              </AiNote>
            ))}
          </div>
        )}
      </QueryView>
    </div>
  );
}

// ---------------------------------------------------------------- side form

function FollowUpForm({ leadId }: { leadId: number }) {
  const form = useForm({ defaultValues: { purpose: FOLLOW_UP_PURPOSES[0]!, response: FOLLOW_UP_RESPONSES[0]!, notes: "", next: "" } });
  const log = useApiMutation(
    (v: { purpose: string; response: string; notes: string; next: string }) =>
      leadsApi.logFollowUp(leadId, { purpose: v.purpose, response: v.response, notes: v.notes || undefined, next_follow_up_at: fromLocalInput(v.next)! }),
    {
      success: "Follow-up logged",
      invalidate: [leadKeys.detail(leadId), leadKeys.activities(leadId), ["tasks"]],
      silentValidation: true,
      onSuccess: () => form.reset({ ...form.getValues(), notes: "", next: "" }),
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <form className="grid gap-2" onSubmit={form.handleSubmit((v) => log.mutate(v))}>
      <Field label="Purpose">
        <NativeSelect options={FOLLOW_UP_PURPOSES.map((x) => ({ value: x, label: x }))} {...form.register("purpose")} />
      </Field>
      <Field label="Response">
        <NativeSelect options={FOLLOW_UP_RESPONSES.map((x) => ({ value: x, label: x }))} {...form.register("response")} />
      </Field>
      <Field label="Notes">
        <Textarea {...form.register("notes")} />
      </Field>
      <Field label="Next follow-up (IST)" error={form.formState.errors.next?.message ?? form.formState.errors["next_follow_up_at" as "next"]?.message}>
        <Input type="datetime-local" aria-label="Next follow-up" {...form.register("next", { required: "Next follow-up is required" })} />
      </Field>
      <Button type="submit" disabled={log.isPending}>
        <CalendarDays />
        Log follow-up
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- dialogs

function FormDialog({
  title,
  description,
  onClose,
  onSubmit,
  submitLabel,
  busy,
  destructive,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          id="lead-dialog-form"
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="lead-dialog-form" disabled={busy} variant={destructive ? "destructive" : "default"}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const invalidateLead = (id: number) => [leadKeys.detail(id), leadKeys.activities(id), ["leads", "list"], ["persons"], ["pipeline"]];

function EditDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const form = useForm({
    defaultValues: { course_id: String(lead.course?.course_id ?? ""), intake_status: MANUAL_INTAKE.includes(lead.intake_status) ? lead.intake_status : "", campaign: lead.campaign ?? "", remarks: lead.remarks ?? "" },
  });
  const save = useApiMutation((body: Parameters<typeof leadsApi.update>[1]) => leadsApi.update(lead.lead_id, body), {
    success: "Lead updated",
    invalidate: invalidateLead(lead.lead_id),
    onSuccess: onClose,
    silentValidation: true,
    onError: (e) => applyServerErrors(form, e),
  });
  return (
    <FormDialog
      title="Edit lead"
      onClose={onClose}
      busy={save.isPending}
      submitLabel="Save"
      onSubmit={form.handleSubmit((v) => {
        const body: Parameters<typeof leadsApi.update>[1] = { course_id: v.course_id ? Number(v.course_id) : null, campaign: v.campaign || null, remarks: v.remarks || null };
        if (v.intake_status) body.intake_status = v.intake_status;
        save.mutate(body);
      })}
    >
      <Field label="Course" error={form.formState.errors.course_id?.message}>
        <CourseSelect branchCode={lead.branch.branch_code} placeholder="Not decided yet" {...form.register("course_id")} />
      </Field>
      <Field label="Intake status" hint={MANUAL_INTAKE.includes(lead.intake_status) ? undefined : `Currently ${lead.intake_status} (system-set)`}>
        <NativeSelect options={MANUAL_INTAKE.map((s) => ({ value: s, label: s }))} placeholder="Keep current" {...form.register("intake_status")} />
      </Field>
      <Field label="Campaign / referral">
        <Input {...form.register("campaign")} />
      </Field>
      <Field label="Remarks">
        <Textarea {...form.register("remarks")} />
      </Field>
    </FormDialog>
  );
}

function AssignDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [owner, setOwner] = useState(String(lead.owner?.user_id ?? ""));
  const assign = useApiMutation((id: number) => leadsApi.assign(lead.lead_id, id), { success: "Lead reassigned", invalidate: invalidateLead(lead.lead_id), onSuccess: onClose });
  return (
    <FormDialog title="Reassign lead" description="Ownership history is kept in the timeline." onClose={onClose} busy={assign.isPending || !owner} submitLabel="Reassign" onSubmit={() => assign.mutate(Number(owner))}>
      <Field label="New owner">
        <StaffSelect branchId={lead.branch.branch_id} value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function StageDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const lookups = useLookups();
  // A lead in the pipeline never moves back to New Enquiry
  const excluded = ["Payment Pending Verification", "Admitted", "Lost - closed", lead.stage, ...(lead.lead_status === "Active" ? [] : ["New Enquiry"])];
  const manual = (lookups.data?.enums["lead_stages"] ?? []).filter((s) => !excluded.includes(s));
  const [stage, setStage] = useState(manual[0] ?? "");
  const [note, setNote] = useState("");
  const change = useApiMutation(() => leadsApi.changeStage(lead.lead_id, stage, note || undefined), { success: "Stage updated", invalidate: invalidateLead(lead.lead_id), onSuccess: onClose });
  return (
    <FormDialog
      title="Move stage"
      description="Moves the person's pipeline card, and every open course on it. Payment Pending Verification and Admitted are set by payments and admissions; use Mark lost to close."
      onClose={onClose}
      busy={change.isPending || !stage}
      submitLabel="Move"
      onSubmit={() => change.mutate(undefined)}
    >
      <Field label="New stage">
        <NativeSelect aria-label="New stage" value={stage} options={manual.map((s) => ({ value: s, label: s }))} onChange={(e) => setStage(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function LostDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const form = useForm({ defaultValues: { lost_reason_id: "", lost_competitor: "", lost_notes: "", reactivation_date: "" } });
  const lost = useApiMutation(
    (v: { lost_reason_id: string; lost_competitor: string; lost_notes: string; reactivation_date: string }) =>
      leadsApi.markLost(lead.lead_id, {
        lost_reason_id: Number(v.lost_reason_id),
        lost_competitor: v.lost_competitor || null,
        lost_notes: v.lost_notes || null,
        reactivation_date: v.reactivation_date || null,
      }),
    { success: "Lead marked lost", invalidate: invalidateLead(lead.lead_id), onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog title="Mark lead lost" onClose={onClose} busy={lost.isPending} submitLabel="Mark lost" destructive onSubmit={form.handleSubmit((v) => lost.mutate(v))}>
      <Field label="Reason" error={form.formState.errors.lost_reason_id?.message}>
        <LookupSelect lookup="lost_reasons" {...form.register("lost_reason_id", { required: "Choose a reason" })} />
      </Field>
      <Field label="Competitor (optional)">
        <Input {...form.register("lost_competitor")} />
      </Field>
      <Field label="Notes">
        <Textarea {...form.register("lost_notes")} />
      </Field>
      <Field label="Reactivation date (optional)" error={form.formState.errors.reactivation_date?.message}>
        <Input type="date" min={todayIST()} {...form.register("reactivation_date")} />
      </Field>
    </FormDialog>
  );
}

function ReactivateDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [stage, setStage] = useState("Counselling");
  const [next, setNext] = useState("");
  const go = useApiMutation(() => leadsApi.reactivate(lead.lead_id, { stage, next_follow_up_at: fromLocalInput(next) }), {
    success: "Lead reactivated",
    invalidate: invalidateLead(lead.lead_id),
    onSuccess: onClose,
  });
  return (
    <FormDialog title="Reactivate lead" onClose={onClose} busy={go.isPending} submitLabel="Reactivate" onSubmit={() => go.mutate(undefined)}>
      <Field label="Return to stage">
        <NativeSelect value={stage} options={REACTIVATE_STAGES.map((s) => ({ value: s, label: s }))} onChange={(e) => setStage(e.target.value)} />
      </Field>
      <Field label="Next follow-up (IST, optional)">
        <Input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function ActivityDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const lookups = useLookups();
  const types = (lookups.data?.enums["activity_types"] ?? []).filter((t) => !["Stage Change", "Assignment Change"].includes(t));
  const form = useForm({ defaultValues: { activity_type: "Call", direction: "Outbound", contact_channel_id: "", outcome: "", summary: "", minutes: "" } });
  const add = useApiMutation(
    (v: { activity_type: string; direction: string; contact_channel_id: string; outcome: string; summary: string; minutes: string }) =>
      leadsApi.addActivity(lead.lead_id, {
        activity_type: v.activity_type,
        direction: v.direction || null,
        contact_channel_id: v.contact_channel_id ? Number(v.contact_channel_id) : null,
        outcome: v.outcome || null,
        summary: v.summary || null,
        call_duration_seconds: v.minutes ? Math.round(Number(v.minutes) * 60) : null,
      }),
    { success: "Activity logged", invalidate: invalidateLead(lead.lead_id), onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <FormDialog title="Log call / note" onClose={onClose} busy={add.isPending} submitLabel="Log" onSubmit={form.handleSubmit((v) => add.mutate(v))}>
      <Field label="Type" error={form.formState.errors.activity_type?.message}>
        <NativeSelect options={types.map((t) => ({ value: t, label: t }))} {...form.register("activity_type")} />
      </Field>
      <Field label="Direction">
        <NativeSelect placeholder="—" options={["Outbound", "Inbound"].map((t) => ({ value: t, label: t }))} {...form.register("direction")} />
      </Field>
      <Field label="Channel">
        <LookupSelect lookup="contact_channels" placeholder="—" {...form.register("contact_channel_id")} />
      </Field>
      <Field label="Outcome">
        <Input {...form.register("outcome")} placeholder="e.g. Connected, Busy, Switched off" />
      </Field>
      <Field label="Call duration (minutes)">
        <Input type="number" min={0} step="0.5" {...form.register("minutes")} />
      </Field>
      <Field label="Summary" error={form.formState.errors.summary?.message}>
        <Textarea {...form.register("summary")} />
      </Field>
    </FormDialog>
  );
}

function ScheduleDemoDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const form = useForm({ defaultValues: { scheduled_at: "", course_id: "", demo_type: "Standard", mode: "In-person", duration_minutes: "45", trainer_user_id: "", meeting_link: "" } });
  const book = useApiMutation(
    (v: { scheduled_at: string; course_id: string; demo_type: string; mode: string; duration_minutes: string; trainer_user_id: string; meeting_link: string }) =>
      post<{ demo_code: string }>(`/leads/${lead.lead_id}/demos`, {
        scheduled_at: fromLocalInput(v.scheduled_at),
        ...(v.course_id ? { course_id: Number(v.course_id) } : {}),
        demo_type: v.demo_type,
        mode: v.mode,
        duration_minutes: Number(v.duration_minutes),
        trainer_user_id: v.trainer_user_id ? Number(v.trainer_user_id) : null,
        meeting_link: v.meeting_link || null,
      }),
    {
      success: (d) => `Demo ${d.demo_code} scheduled`,
      invalidate: [...invalidateLead(lead.lead_id), ["demos"]],
      onSuccess: onClose,
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
    },
  );
  return (
    <FormDialog
      title={`Schedule demo · ${lead.name}`}
      description={lead.course ? lead.course.course_title : "The lead has no course yet"}
      onClose={onClose}
      busy={book.isPending}
      submitLabel="Schedule"
      onSubmit={form.handleSubmit((v) => book.mutate(v))}
    >
      <Field label="Date & time (IST)" error={form.formState.errors.scheduled_at?.message}>
        <Input type="datetime-local" aria-label="Demo date and time" {...form.register("scheduled_at", { required: "Required" })} />
      </Field>
      {!lead.course && (
        <Field label="Course (optional)" error={form.formState.errors.course_id?.message}>
          <CourseSelect branchCode={lead.branch.branch_code} placeholder="Not decided yet" {...form.register("course_id")} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type">
          <NativeSelect options={["Standard", "Practical"].map((t) => ({ value: t, label: t }))} {...form.register("demo_type")} />
        </Field>
        <Field label="Mode">
          <NativeSelect options={["In-person", "Online"].map((t) => ({ value: t, label: t }))} {...form.register("mode")} />
        </Field>
        <Field label="Minutes" error={form.formState.errors.duration_minutes?.message}>
          <Input type="number" min={15} step={15} {...form.register("duration_minutes")} />
        </Field>
      </div>
      <Field label="Trainer" error={form.formState.errors.trainer_user_id?.message}>
        <StaffSelect branchId={lead.branch.branch_id} roles={["TRAINER"]} placeholder="Assign later" {...form.register("trainer_user_id")} />
      </Field>
      {form.watch("mode") === "Online" && (
        <Field label="Meeting link" error={form.formState.errors.meeting_link?.message}>
          <Input type="url" {...form.register("meeting_link")} />
        </Field>
      )}
    </FormDialog>
  );
}
