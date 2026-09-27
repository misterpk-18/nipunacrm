import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { CalendarDays, Check, CircleDollarSign, Filter, Mail, MessageCircle, Phone, Plus, Printer, RotateCcw, Search, Upload, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  SAMPLE_NOTICE, SAMPLE_TODAY, allocationCheck, ageBand, branchCode, channels, courseCatalog, courseCode, entryMethods, fmtDate, fmtDateTime,
  inRange, inr, intakeStatuses, invoiceSummary, occupancy, ownerOptions, paymentMethods, paymentStatus, periodRange, pipelineStages,
  sources, staff, trainers, useCrmData, verifiedAt, type BranchName, type Lead,
} from "@/lib/crm-store";
import { AiNote, LeadActions, PageHead, PrototypeTable, Section, Status, Warning, demoAction } from "./ui";
import { useCrmScope } from "./crm-scope";

/* ------------------------------ small helpers ------------------------------ */
const scopeRows = <T,>(rows: T[], branch: string, key: (r: T) => string) => (branch === "All Branches" ? rows : rows.filter((r) => key(r) === branch));
const Empty = ({ children }: { children: ReactNode }) => <div className="py-10 text-center text-sm text-muted-foreground">{children}</div>;
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string | undefined }) {
  return <div className="field min-w-0"><Label>{label}</Label>{children}{hint && <small className="text-xs text-muted-foreground">{hint}</small>}</div>;
}
function NativeSelect({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; options: (string | [string, string])[]; ariaLabel?: string }) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm">
      {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option>; })}
    </select>
  );
}
export function SampleNotice() {
  return <div className="sample-notice" role="note">{SAMPLE_NOTICE}</div>;
}
function ResetDemo() {
  const { reset } = useCrmData();
  return <Button variant="outline" size="sm" onClick={() => { reset(); toast.success("Sample data reset to prototype fixtures"); }}><RotateCcw />Reset demo data</Button>;
}
const canFinance = (role: string) => role === "Founder / CEO" || role === "Super Admin" || role.endsWith("Accounts");
const isGlobal = (role: string) => role === "Founder / CEO" || role === "Super Admin";
const isTrainerOrStudent = (role: string) => role.endsWith("Trainer") || role.endsWith("Student");

/* ================================ LEADS ================================ */
const leadMatchesTab = (lead: Lead, tab: string) =>
  ({
    New: lead.stage === "New Enquiry",
    Untouched: lead.followUp === "Unscheduled",
    "Due Today": lead.followUp.startsWith("Today"),
    Overdue: lead.followUp.includes("Overdue") || lead.followUp.includes("overdue"),
    Hot: lead.priority === "Hot",
    Demos: lead.stage.includes("Demo"),
    "Fee Discussion": lead.stage === "Fee Discussion / Payment Awaited",
    "Payment Pending Verification": lead.stage === "Payment Pending Verification",
    Collections: lead.stage === "Admitted" && /instal|Collection/i.test(lead.followUp),
    "Cold / Reactivation": lead.priority === "Cold" || lead.priority.includes("Future Joining"),
  })[tab] ?? true;

const savedViews: Record<string, Partial<Record<"stage" | "source" | "intake" | "owner", string>>> = {
  "All open": {},
  "Hot fee discussions": { stage: "Fee Discussion / Payment Awaited" },
  "Duplicate Review queue": { intake: "Duplicate Review" },
  "Website enquiries": { source: "Website" },
  "Admitted (reference)": { stage: "Admitted" },
};

export function Leads({ workspace = false }: { workspace?: boolean }) {
  const { branch, role } = useCrmScope();
  const { leads, bulkAssign } = useCrmData();
  const [tab, setTab] = useState("New");
  const [q, setQ] = useState("");
  const [f, setF] = useState({ stage: "Any", source: "Any", intake: "Any", owner: "Any" });
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState("All open");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOwner, setBulkOwner] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const scoped = scopeRows(leads, branch, (l) => l.branch);
  const shown = scoped.filter((l) => {
    if (workspace && !leadMatchesTab(l, tab)) return false;
    const hay = `${l.name} ${l.id} ${l.phone} ${l.email} ${l.course} ${l.personId}`.toLowerCase();
    if (q && !hay.includes(q.toLowerCase())) return false;
    if (f.stage !== "Any" && l.stage !== f.stage) return false;
    if (f.source !== "Any" && l.source !== f.source) return false;
    if (f.intake !== "Any" && l.intakeStatus !== f.intake) return false;
    if (f.owner !== "Any" && l.owner !== f.owner) return false;
    return true;
  });
  const selectedLeads = leads.filter((l) => selected.includes(l.id));
  const selBranches = [...new Set(selectedLeads.map((l) => l.branch))];
  const bulkOptions = selBranches.length === 1 && selBranches[0] ? ownerOptions(selBranches[0]) : [];
  const canAssign = !isTrainerOrStudent(role) && !role.endsWith("Accounts");
  const applyView = (v: string) => { setView(v); setF({ stage: "Any", source: "Any", intake: "Any", owner: "Any", ...savedViews[v] }); };
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allOwners = [...new Set(scoped.map((l) => l.owner))];
  const filterCount = Object.values(f).filter((v) => v !== "Any").length;

  return (
    <>
      <PageHead
        title={workspace ? "Counsellor Workspace" : "Leads"}
        description={workspace ? `Today's prioritized queue · ${branch} · sample records` : `Search, filter, assign and progress sample enquiries · ${branch}`}
        actions={<>
          <Button onClick={() => setNewOpen(true)}><Plus />{workspace ? "Add Lead" : "New Lead"}</Button>
          {!workspace && <Button variant="outline" onClick={() => setImportOpen(true)}><Upload />Sample Import Review</Button>}
          <ResetDemo />
        </>}
      />
      {workspace && (
        <div className="mb-4 overflow-x-auto">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-auto min-w-max">
              {["New", "Untouched", "Due Today", "Overdue", "Hot", "Demos", "Fee Discussion", "Payment Pending Verification", "Collections", "Cold / Reactivation"].map((x) => <TabsTrigger key={x} value={x}>{x}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
      )}
      <div className="panel">
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search name, ID, masked phone, course" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sample leads" />
          </div>
          <Button variant={showFilters ? "secondary" : "outline"} onClick={() => setShowFilters((x) => !x)}><Filter />Filters{filterCount ? ` (${filterCount})` : ""}</Button>
          <div className="w-44 min-w-0"><NativeSelect ariaLabel="Saved Views" value={view} onChange={applyView} options={Object.keys(savedViews)} /></div>
        </div>
        {showFilters && (
          <div className="mb-3 grid gap-2 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Stage"><NativeSelect value={f.stage} onChange={(v) => setF({ ...f, stage: v })} options={["Any", ...pipelineStages]} /></Field>
            <Field label="Original Source"><NativeSelect value={f.source} onChange={(v) => setF({ ...f, source: v })} options={["Any", ...sources]} /></Field>
            <Field label="Intake Status"><NativeSelect value={f.intake} onChange={(v) => setF({ ...f, intake: v })} options={["Any", ...intakeStatuses]} /></Field>
            <Field label="Owner"><NativeSelect value={f.owner} onChange={(v) => setF({ ...f, owner: v })} options={["Any", ...allOwners]} /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Button size="sm" variant="ghost" onClick={() => applyView("All open")}>Clear filters</Button></div>
          </div>
        )}
        {selected.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <Users className="size-4" /><b>{selected.length} selected</b>
            {!canAssign ? <span className="text-muted-foreground">Bulk Assign is not available for this prototype role.</span>
              : selBranches.length > 1 ? <span className="text-warning-foreground">Select leads from one branch only — owners are branch-scoped.</span>
              : <>
                <div className="w-56 min-w-0"><NativeSelect ariaLabel="Bulk owner" value={bulkOwner} onChange={setBulkOwner} options={[["", "Choose owner (Sales → Front Office → manager cover)"], ...bulkOptions.map((o) => [o.name, `${o.name} · ${o.role}`] as [string, string])]} /></div>
                <Button size="sm" disabled={!bulkOwner} onClick={() => { bulkAssign(selected, bulkOwner); toast.success(`Assigned ${selected.length} sample lead(s) to ${bulkOwner}. Admissions and Lead Owner history preserved.`); setSelected([]); setBulkOwner(""); }}>Bulk Assign</Button>
              </>}
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>
          </div>
        )}
        {workspace && <AiNote title="AI Next Best Action">Review the highest-priority {branch} lead before the next scheduled follow-up. This suggestion uses sample activity only.</AiNote>}
        <p className="mt-2 text-xs text-muted-foreground">{shown.length} of {scoped.length} sample records · tick rows to Bulk Assign · trainers are never sales owners</p>
        <div className="mt-2 table-desktop">
          {shown.length ? (
            <PrototypeTable
              headers={["", "Name", "Phone", "Course", "Branch", "Original Source", "Contact Channel", "Entry Method", "Intake Status", "Assigned", "Stage", "Next Follow-Up", "AI Priority", "Actions"]}
              rows={shown.map((l) => [
                <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.includes(l.id)} onChange={() => toggle(l.id)} />,
                <Link to="/leads/$leadId" params={{ leadId: l.id }} className="font-semibold text-primary">{l.name}<small className="block text-muted-foreground">{l.id} · {l.personId}</small></Link>,
                l.phone, l.course, l.branch, l.source, l.channel, l.entryMethod, <Status>{l.intakeStatus}</Status>, l.owner, <Status>{l.stage}</Status>, l.followUp,
                <span className="flex items-center gap-2"><Status>{l.priority}</Status><b>{l.score}</b></span>, <LeadActions />,
              ])}
            />
          ) : <Empty>No sample leads match the current search, filters or tab in {branch}.</Empty>}
        </div>
        <div className="mobile-lead-list mt-2">
          {shown.length ? shown.map((l) => (
            <div className="mobile-lead-card" key={l.id}>
              <div className="flex items-start justify-between gap-3">
                <label className="flex min-w-0 items-start gap-2">
                  <input type="checkbox" className="mt-1" aria-label={`Select ${l.name}`} checked={selected.includes(l.id)} onChange={() => toggle(l.id)} />
                  <span className="min-w-0">
                    <Link to="/leads/$leadId" params={{ leadId: l.id }} className="font-semibold text-primary">{l.name}</Link>
                    <span className="mt-1 block text-xs text-muted-foreground">{l.course} · {l.stage}</span>
                  </span>
                </label>
                <Status>{l.priority}</Status>
              </div>
              <div className="my-3 space-y-1 text-xs">
                <div>{l.phone} · {l.followUp}</div>
                <div className="break-words text-muted-foreground">{l.branch} · {l.owner} · {l.source} · {l.channel} · {l.entryMethod} · {l.intakeStatus}</div>
              </div>
              <LeadActions prominent />
            </div>
          )) : <Empty>No sample leads match the current search, filters or tab.</Empty>}
        </div>
      </div>
      <NewLeadDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}

export function NewLeadDialog({ open, onOpenChange, personId, presetCourse }: { open: boolean; onOpenChange: (o: boolean) => void; personId?: string | undefined; presetCourse?: string | undefined }) {
  const { allowedBranches } = useCrmScope();
  const { addLead, persons, leads } = useCrmData();
  const person = personId ? persons.find((p) => p.id === personId) : undefined;
  const branchChoices = allowedBranches.filter((b) => b !== "All Branches") as BranchName[];
  // A new opportunity must live inside the viewer's allowed branch scope; the Person's originalBranch is preserved on the Person record only.
  const defaultBranch = (): BranchName => {
    if (person && allowedBranches.includes("All Branches") && branchChoices.includes(person.originalBranch)) return person.originalBranch;
    return branchChoices[0] ?? "Guntur";
  };
  const blank = () => {
    const br = defaultBranch();
    return {
      name: person?.name ?? "Sample Learner", phone: person?.phone ?? "+91 9XXXX 1XXXX", altPhone: "", email: person?.email ?? "sample.learner@example.test", sameWa: true, wa: "",
      course: presetCourse ?? "Data Science", branch: br, source: "Walk-in", campaign: "", channel: "In person", entryMethod: "Staff entered", intake: "New",
      owner: ownerOptions(br)[0]?.name ?? "", follow: `${SAMPLE_TODAY}T18:00`, remarks: "",
    };
  };
  const [v, setV] = useState(blank);
  const [err, setErr] = useState("");
  // Reset defaults whenever the dialog opens or the role/branch scope changes, so stale state can never submit out of scope.
  useEffect(() => { if (open) { setV(blank()); setErr(""); } }, [open, allowedBranches, personId, presetCourse]);
  const set = (k: keyof ReturnType<typeof blank>, val: string | boolean) => setV((x) => ({ ...x, [k]: val }));
  const dup = !person && leads.find((l) => l.phone === v.phone && v.phone !== "+91 9XXXX 1XXXX");
  const submit = (): void => {
    if (!v.name.trim()) { setErr("Name is required."); return; }
    if (!/X/.test(v.phone)) { setErr("Prototype accepts masked synthetic numbers only (must contain X). Do not enter a real phone number."); return; }
    if (v.email && !v.email.endsWith("@example.test")) { setErr("Prototype accepts @example.test addresses only."); return; }
    if (person && leads.some((l) => l.personId === person.id && l.course === v.course && l.stage !== "Lost - closed")) { setErr(`${person.name} already has an open ${v.course} opportunity.`); return; }
    if (!branchChoices.includes(v.branch)) { setErr(`Branch ${v.branch} is outside your allowed scope. Reopen the dialog to refresh defaults.`); return; }
    if (!ownerOptions(v.branch).some((o) => o.name === v.owner)) { setErr(`Owner ${v.owner} is not valid for ${v.branch}. Pick a ${v.branch} owner.`); return; }
    const lead = addLead({ personId: person?.id, name: v.name, phone: v.phone, altPhone: v.altPhone, email: v.email, whatsapp: v.sameWa ? "Same as mobile" : v.wa || "Not provided", course: v.course, branch: v.branch, source: v.source, campaign: v.campaign, channel: v.channel, entryMethod: v.entryMethod, intakeStatus: dup ? "Duplicate Review" : v.intake, owner: v.owner, followUp: v.follow ? fmtDateTime(v.follow) : "Unscheduled", remarks: v.remarks });
    toast.success(`${lead.id} created for ${lead.personId}${person ? " (same Person, new opportunity)" : ""}. No message sent · no admission created.`);
    setErr(""); setV(blank()); onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setV(blank()); onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{person ? `Add Another Course · ${person.name}` : "New Lead · sample capture"}</DialogTitle>
          <DialogDescription>{SAMPLE_NOTICE}. Phone/email fields are demo-only and accept synthetic masked values.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={v.name} disabled={!!person} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Primary mobile (demo only)"><Input value={v.phone} disabled={!!person} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Alternate mobile (optional, demo only)"><Input value={v.altPhone} placeholder="+91 9XXXX 2XXXX" onChange={(e) => set("altPhone", e.target.value)} /></Field>
          <Field label="Email (optional, demo only)"><Input value={v.email} disabled={!!person} onChange={(e) => set("email", e.target.value)} /></Field>
          <div className="field sm:col-span-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.sameWa} onChange={(e) => set("sameWa", e.target.checked)} />WhatsApp number same as primary mobile</label>
            {!v.sameWa && <Input value={v.wa} placeholder="+91 9XXXX 3XXXX" onChange={(e) => set("wa", e.target.value)} />}</div>
          <Field label="Course"><NativeSelect value={v.course} onChange={(x) => set("course", x)} options={courseCatalog.map((c) => [c.name, `${c.code} · ${c.name}`] as [string, string])} /></Field>
          <Field label="Branch" hint={person ? `New opportunity branch must be within your allowed scope; ${person.name}'s original branch stays ${person.originalBranch}.` : undefined}>
            <NativeSelect value={v.branch} onChange={(x) => setV((s) => ({ ...s, branch: x as BranchName, owner: ownerOptions(x as BranchName)[0]?.name ?? "" }))} options={branchChoices} />
          </Field>
          <Field label="Original Source"><NativeSelect value={v.source} onChange={(x) => set("source", x)} options={sources} /></Field>
          <Field label="Campaign / referral (optional)"><Input value={v.campaign} placeholder="e.g. referral by existing student" onChange={(e) => set("campaign", e.target.value)} /></Field>
          <Field label="Contact Channel"><NativeSelect value={v.channel} onChange={(x) => set("channel", x)} options={channels} /></Field>
          <Field label="Entry Method"><NativeSelect value={v.entryMethod} onChange={(x) => set("entryMethod", x)} options={entryMethods} /></Field>
          <Field label="Intake Status"><NativeSelect value={v.intake} onChange={(x) => set("intake", x)} options={intakeStatuses} /></Field>
          <Field label="Lead owner"><NativeSelect value={v.owner} onChange={(x) => set("owner", x)} options={ownerOptions(v.branch).map((o) => [o.name, `${o.name} · ${o.role}`] as [string, string])} /></Field>
          <Field label="Next follow-up (IST)"><Input type="datetime-local" value={v.follow} onChange={(e) => set("follow", e.target.value)} /></Field>
          <div className="field sm:col-span-2"><Label>Counsellor remarks</Label><Textarea value={v.remarks} onChange={(e) => set("remarks", e.target.value)} placeholder="Sample remarks" /></div>
        </div>
        {dup && <Warning>Possible duplicate of {dup.id} ({dup.name}). It will be created as Duplicate Review — never auto-merged.</Warning>}
        {err && <p className="text-sm font-medium text-destructive" role="alert">{err}</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit}><UserPlus />{person ? "Create opportunity" : "Save sample lead"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const syntheticCsv = [
  { name: "Lokesh Babu", phone: "+91 9XXXX 31001", email: "lokesh.b@example.test", course: "Data Science", branch: "Guntur", source: "Website" },
  { name: "Pavani Sri", phone: "+91 9XXXX 31002", email: "pavani.s@example.test", course: "Power BI", branch: "Vijayawada", source: "Meta Ads" },
  { name: "Karthik Reddy", phone: "+91 9XXXX 11002", email: "karthik.reddy@example.test", course: "Java Full Stack", branch: "Vijayawada", source: "Google Ads" },
  { name: "Test Row", phone: "12345", email: "invalid-email", course: "Unknown Course", branch: "Guntur", source: "Website" },
  { name: "Mahesh T", phone: "+91 9XXXX 31005", email: "", course: "Digital Marketing", branch: "Hyderabad", source: "Referral" },
];
function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { leads, addLead, reset } = useCrmData();
  const { allowedBranches } = useCrmScope();
  const [done, setDone] = useState<string | null>(null);
  const rows = syntheticCsv.map((r) => {
    const issues: string[] = [];
    if (!/X/.test(r.phone)) issues.push("Phone not a masked synthetic value");
    if (r.email && !r.email.endsWith("@example.test")) issues.push("Invalid email");
    if (!courseCatalog.some((c) => c.name === r.course)) issues.push("Course not in Course Master");
    const branchOk = r.branch === "Guntur" || r.branch === "Vijayawada";
    if (!branchOk) issues.push("Branch not NIT-GNT / NIT-VIJ");
    else if (!allowedBranches.includes(r.branch as BranchName)) issues.push("Outside your branch scope");
    const dup = leads.find((l) => l.phone === r.phone);
    const status = issues.length ? "Invalid — skipped" : dup ? `Duplicate Review (matches ${dup.id})` : "Ready · New";
    return { ...r, issues, dup, status };
  });
  const importable = rows.filter((r) => !r.issues.length);
  const run = () => {
    const created = importable.map((r) => addLead({ name: r.name, phone: r.phone, email: r.email, course: r.course, branch: r.branch as BranchName, source: r.source, channel: "Web form", entryMethod: "Synthetic CSV import", intakeStatus: r.dup ? "Duplicate Review" : "New" }));
    const ids = new Set(created.map((l) => l.id));
    setDone(`${ids.size} sample rows imported as ${[...ids].join(", ")} (${created.filter((l) => l.intakeStatus === "Duplicate Review").length} held in Duplicate Review, never merged). ${rows.length - importable.length} skipped. No admissions created; SLA not satisfied by import.`);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { setDone(null); onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Sample Import Review · built-in synthetic CSV</DialogTitle><DialogDescription>{SAMPLE_NOTICE}. File upload of production data is disabled in this prototype.</DialogDescription></DialogHeader>
        <Section title="Field mapping"><PrototypeTable headers={["CSV column", "CRM field"]} rows={[["full_name", "Name"], ["mobile", "Primary mobile (masked)"], ["email", "Email"], ["course", "Course (Course Master)"], ["branch", "Branch → NIT-GNT / NIT-VIJ"], ["source", "Original Source · Entry Method = Synthetic CSV import"]]} /></Section>
        <div className="mt-3"><PrototypeTable headers={["Row", "Name", "Mobile", "Course", "Branch", "Validation", "Result"]} rows={rows.map((r, i) => [i + 1, r.name, r.phone, r.course, r.branch, r.issues.length ? r.issues.join("; ") : "OK", <Status>{r.status}</Status>])} /></div>
        {done ? <p className="rounded-md border border-success/40 bg-success/10 p-3 text-sm" role="status"><Check className="mr-1 inline size-4" />{done}</p> : <Warning>Duplicates never auto-merge. Imports do not create admissions or satisfy lead SLA.</Warning>}
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); setDone(null); toast.success("Sample data reset"); }}>Reset demo data</Button>
          <Button disabled={!!done} onClick={run}><Upload />Complete simulated import ({importable.length})</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================================ LEAD 360 ================================ */
function FollowUpForm({ leadId }: { leadId: string }) {
  const { logFollowUp } = useCrmData();
  const [v, setV] = useState({ purpose: "Fee follow-up", response: "Interested", notes: "", next: `${SAMPLE_TODAY}T18:30` });
  return (
    <div className="grid gap-2">
      <Field label="Purpose"><NativeSelect value={v.purpose} onChange={(x) => setV({ ...v, purpose: x })} options={["Counselling call", "Demo confirmation", "Post-demo follow-up", "Fee follow-up", "Collection follow-up", "Document follow-up"]} /></Field>
      <Field label="Response"><NativeSelect value={v.response} onChange={(x) => setV({ ...v, response: x })} options={["Interested", "Call back later", "Not reachable", "Needs time", "Not interested"]} /></Field>
      <Field label="Notes"><Textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} placeholder="Sample notes" /></Field>
      <Field label="Next follow-up (IST)"><Input type="datetime-local" value={v.next} onChange={(e) => setV({ ...v, next: e.target.value })} /></Field>
      <Button onClick={() => { if (!v.next) { toast.error("Next follow-up date/time is required."); return; } logFollowUp(leadId, v); toast.success("Follow-up logged · timeline and task updated (sample). Original deadline retained."); setV({ ...v, notes: "" }); }}><CalendarDays />Log follow-up</Button>
    </div>
  );
}

export function Lead360() {
  const { leadId } = useParams({ strict: false }) as { leadId?: string };
  const { leads, demos, invoices, admissions, tasks, ...st } = useCrmData();
  const { branch } = useCrmScope();
  const [tab, setTab] = useState("Timeline");
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return <><PageHead title="Lead not found" description={`No sample lead ${leadId ?? ""}`} /><Empty><Link to="/leads" className="text-primary">Back to Leads</Link></Empty></>;
  if (branch !== "All Branches" && lead.branch !== branch) return <><PageHead title="Outside branch scope" description={`${lead.id} belongs to ${lead.branch}. Switch branch scope (if your role allows).`} /><Warning>Branch-scoped UI simulation: record hidden for {branch} scope.</Warning></>;
  const personLeads = leads.filter((l) => l.personId === lead.personId && (branch === "All Branches" || l.branch === branch));
  const myDemos = demos.filter((d) => d.leadId === lead.id);
  const inv = invoices.filter((i) => i.leadId === lead.id);
  const adm = admissions.find((a) => a.leadId === lead.id);
  const contents: Record<string, ReactNode> = {
    Timeline: <div className="space-y-4 border-l-2 pl-5">{lead.timeline.map((x, i) => <div key={i}><div className="text-xs text-muted-foreground">{x.at}</div><div className="text-sm font-semibold">{x.title}</div><div className="text-sm text-muted-foreground">{x.detail}</div></div>)}</div>,
    Enquiries: <PrototypeTable headers={["Opportunity", "Course", "Original Source", "Contact Channel", "Entry Method", "Intake", "Stage", "Owner"]} rows={personLeads.map((l) => [<Link to="/leads/$leadId" params={{ leadId: l.id }} className="text-primary">{l.id}</Link>, l.course, l.source, l.channel, l.entryMethod, <Status>{l.intakeStatus}</Status>, <Status>{l.stage}</Status>, l.owner])} />,
    Demos: myDemos.length ? <PrototypeTable headers={["Demo", "When", "Duration", "Trainer", "Status", "Outcome"]} rows={myDemos.map((d) => [d.id, fmtDateTime(d.at), `${d.duration} min`, d.trainer, <Status>{d.status}</Status>, d.outcome ?? "—"])} /> : <Empty>No demos yet. <Link to="/demos" className="text-primary">Schedule in Demo Management</Link></Empty>,
    "Fees / Invoices": inv.length ? <PrototypeTable headers={["Invoice", "Billed", "Verified paid", "Pending verification", "Outstanding"]} rows={inv.map((i) => { const s = invoiceSummary({ leads, demos, invoices, admissions, tasks, ...st }, i); return [<Link to="/invoices/$invoiceId" params={{ invoiceId: i.id }} className="text-primary">{i.id}</Link>, inr(i.billed), inr(s.verified), inr(s.pending), inr(s.outstanding)]; })} /> : <Empty>No invoice issued. <Link to="/fee-quote" className="text-primary">Fee Discussion & Invoice</Link></Empty>,
    Tasks: <PrototypeTable headers={["Task", "Owner", "Original deadline", "Revised", "Status"]} rows={tasks.filter((t) => t.record === lead.id).map((t) => [t.title, t.owner, t.original, t.revised ?? "—", <Status>{t.status}</Status>])} />,
    Communication: <div className="space-y-3 text-sm"><div className="rounded-md border p-3"><b>WhatsApp · Manual</b><p className="text-muted-foreground">Sample conversation only. API automation Planned / Pending Verification.</p></div><div className="rounded-md border p-3"><b>Calls · Not Connected</b><p className="text-muted-foreground">Telephony pending; log calls through the follow-up form.</p></div></div>,
    "AI Insights": <AiNote title="AI Insight">Advisory only, based on this sample timeline: next best step for {lead.name} is “{lead.followUp}”. Human confirmation required for any message or record change.</AiNote>,
  };
  return (
    <>
      <PageHead title={lead.name} description={`${lead.id} · ${lead.personId} · ${lead.branch} · ${lead.course} · ${lead.source} · Owner: ${lead.owner}`}
        actions={<><Button onClick={() => demoAction("Call")}><Phone />Call</Button><Button variant="outline" onClick={() => demoAction("WhatsApp")}><MessageCircle />WhatsApp</Button><Button variant="outline" onClick={() => demoAction("Email")}><Mail />Email</Button></>} />
      <div className="mb-4 flex flex-wrap gap-2"><Status>{lead.stage}</Status><Status>{lead.priority} · {lead.score}</Status><Status>{lead.intakeStatus}</Status><span className="break-all text-sm text-muted-foreground">{lead.phone} · {lead.email || "no email"} · WhatsApp: {lead.whatsapp}</span></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="panel overflow-x-auto">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="min-w-max">{Object.keys(contents).map((t) => <TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}</TabsList>
              <TabsContent value={tab}><div className="mt-5">{contents[tab]}</div></TabsContent>
            </Tabs>
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          <Section title="Sales summary">
            <dl className="space-y-2 text-sm">{[["Next Follow-Up", lead.followUp], ["Original deadline", lead.originalDeadline ?? "—"], ["Campaign / referral", lead.campaign], ["Remarks", lead.remarks || "—"], ["Admission", adm?.id ?? "Not admitted"]].map((x) => <div key={x[0]} className="flex justify-between gap-3"><dt className="text-muted-foreground">{x[0]}</dt><dd className="min-w-0 break-words text-right font-medium">{x[1]}</dd></div>)}</dl>
            <div className="mt-3 flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link to="/students/$personId" params={{ personId: lead.personId }}>Open Person</Link></Button><Button asChild size="sm" variant="outline"><Link to="/demos">Demos</Link></Button></div>
          </Section>
          <Section title="Log follow-up" subtitle="Updates the sample timeline and creates a task"><FollowUpForm leadId={lead.id} /></Section>
        </div>
      </div>
    </>
  );
}

/* ================================ DEMOS ================================ */
export function Demos() {
  const { branch, role } = useCrmScope();
  const data = useCrmData();
  const { demos, leads, scheduleDemo, rescheduleDemo, cancelDemo, recordDemoOutcome } = data;
  const rows = scopeRows(demos, branch, (d) => d.branch).slice().sort((a, b) => b.at.localeCompare(a.at));
  const eligible = scopeRows(leads, branch, (l) => l.branch).filter((l) => !["Admitted", "Lost - closed"].includes(l.stage));
  const [sched, setSched] = useState({ leadId: eligible[0]?.id ?? "", at: "2026-09-28T11:00", duration: 45, trainer: "", mode: "Classroom", exception: "" });
  const [act, setAct] = useState<{ id: string; kind: "reschedule" | "cancel" | "outcome" } | null>(null);
  const selLead = leads.find((l) => l.id === sched.leadId);
  const attended = demos.filter((d) => d.leadId === sched.leadId && d.status === "Attended").length;
  const needsException = attended >= 2;
  const canApproveException = isGlobal(role) || role.includes("Branch Manager") || role.includes("Academic Coordinator");
  const doSchedule = (): void => {
    if (!selLead) { toast.error("Choose a lead in scope."); return; }
    if (sched.duration > 60) { toast.error("Demo duration cannot exceed 60 minutes (practical)."); return; }
    if (needsException && !sched.exception) { toast.error("Blocked: 2 attended demos already. Academic Coordinator or Branch Manager approval is required before confirmation."); return; }
    const d = scheduleDemo({ leadId: selLead.id, at: sched.at, duration: sched.duration, trainer: sched.trainer || (trainers(selLead.branch)[0]?.name ?? "Trainer"), mode: sched.mode, ...(sched.exception ? { exceptionApproval: sched.exception } : {}) });
    toast.success(`${d.id} booked · confirmation simulated · reminders queued in sample state only`);
  };
  const current = act ? demos.find((d) => d.id === act.id) : undefined;
  return (
    <>
      <PageHead title="Demo Management" description={`${branch} · scheduling, reminders, attendance and outcome · SAMPLE DATA`} actions={<ResetDemo />} />
      <div className="mb-4 grid gap-3 md:grid-cols-3"><Warning>Normally maximum 2 attended demos. More needs Academic Coordinator or Branch Manager approval before confirmation.</Warning><Warning>Usual duration 30–45 minutes; practical demos may be up to 60 minutes.</Warning><Warning>Payment Pending Verification or Admitted records never move backward after a demo; Lost is never reopened.</Warning></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Schedule demo" subtitle="Immediate confirmation · 24h student reminder · 1h student + trainer reminder (simulated)" className="min-w-0">
          <div className="grid gap-2">
            <Field label="Lead"><NativeSelect value={sched.leadId} onChange={(x) => setSched({ ...sched, leadId: x, exception: "" })} options={eligible.map((l) => [l.id, `${l.name} · ${l.course} · ${l.branch}`] as [string, string])} /></Field>
            <Field label="Date / time (IST)"><Input type="datetime-local" value={sched.at} onChange={(e) => setSched({ ...sched, at: e.target.value })} /></Field>
            <Field label="Duration" hint="30–45 min default · practical up to 60"><NativeSelect value={String(sched.duration)} onChange={(x) => setSched({ ...sched, duration: Number(x) })} options={["30", "45", "60"]} /></Field>
            <Field label="Trainer (branch-scoped)"><NativeSelect value={sched.trainer} onChange={(x) => setSched({ ...sched, trainer: x })} options={[["", "Default trainer"], ...trainers(selLead?.branch).map((t) => [t.name, t.name] as [string, string])]} /></Field>
            <Field label="Mode"><NativeSelect value={sched.mode} onChange={(x) => setSched({ ...sched, mode: x })} options={["Classroom", "Online · link placeholder (not connected)", "Classroom · practical"]} /></Field>
            <p className="text-xs">Attended demos for this lead: <b>{attended} of 2</b></p>
            {needsException && (
              <div className="rounded-md border border-warning/50 p-2 text-xs">
                <b>Exception required.</b> {canApproveException ? <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={!!sched.exception} onChange={(e) => setSched({ ...sched, exception: e.target.checked ? `Approved by ${role} (sample)` : "" })} />Record approval as {role}</label> : " Your role cannot approve; ask Academic Coordinator or Branch Manager."}
              </div>
            )}
            <Button onClick={doSchedule}><CalendarDays />Schedule demo</Button>
          </div>
        </Section>
        <Section title="Demo schedule" subtitle="Commercial follow-up within 2 staffed hours after attended / confirmed no-show" className="min-w-0 lg:col-span-2">
          {rows.length ? <div className="space-y-3">{rows.map((d) => {
            const l = leads.find((x) => x.id === d.leadId);
            const open = d.status === "Scheduled" || d.status === "Rescheduled";
            return (
              <div key={d.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0"><b>{d.id}</b> · <Link to="/leads/$leadId" params={{ leadId: d.leadId }} className="text-primary">{l?.name}</Link> · {d.course} · {d.branch}<div className="text-xs text-muted-foreground">{fmtDateTime(d.at)} · {d.duration} min · {d.trainer} · {d.mode} · lead stage: {l?.stage}</div></div>
                  <Status>{d.status}</Status>
                </div>
                <div className="mt-2 flex flex-wrap gap-1 text-xs">{d.reminders.map((r, i) => <span key={i} className="rounded border px-2 py-0.5">{r.label}: {r.state}</span>)}</div>
                {d.outcome && <div className="mt-2 text-xs">Outcome: <b>{d.outcome}</b>{d.recommendedCourse && ` · Recommended: ${d.recommendedCourse}`}{d.nextAction && ` · Next: ${d.nextAction}`}{d.commercialOwner && ` · Owner: ${d.commercialOwner}`}{d.nextFollowUp && ` · Follow-up ${fmtDateTime(d.nextFollowUp)}`}</div>}
                {d.history[0] && <div className="mt-1 text-xs text-muted-foreground">Latest: {d.history[0].title} — {d.history[0].detail}</div>}
                {open && <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setAct({ id: d.id, kind: "reschedule" })}>Reschedule</Button><Button size="sm" variant="outline" onClick={() => setAct({ id: d.id, kind: "cancel" })}>Cancel</Button><Button size="sm" onClick={() => setAct({ id: d.id, kind: "outcome" })}>Record attendance / outcome</Button></div>}
              </div>
            );
          })}</div> : <Empty>No sample demos in {branch}.</Empty>}
        </Section>
      </div>
      <Dialog open={!!act} onOpenChange={(o) => !o && setAct(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
          {current && act && <DemoActionForm kind={act.kind} demoId={current.id} leadBranch={current.branch} onDone={(msg) => { toast.success(msg); setAct(null); }} reschedule={rescheduleDemo} cancel={cancelDemo} outcome={recordDemoOutcome} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
function DemoActionForm({ kind, demoId, leadBranch, onDone, reschedule, cancel, outcome }: { kind: "reschedule" | "cancel" | "outcome"; demoId: string; leadBranch: BranchName; onDone: (m: string) => void; reschedule: (id: string, at: string, r: string) => void; cancel: (id: string, r: string) => void; outcome: ReturnType<typeof useCrmData>["recordDemoOutcome"] }) {
  const [reason, setReason] = useState("");
  const [at, setAt] = useState("2026-09-29T11:00");
  const [o, setO] = useState({ status: "Attended" as "Attended" | "No-show", studentFeedback: "", trainerFeedback: "", outcome: "Interested — fee discussion", recommendedCourse: "", nextAction: "Fee discussion", commercialOwner: ownerOptions(leadBranch)[0]?.name ?? "", nextFollowUp: `${SAMPLE_TODAY}T19:00` });
  if (kind === "reschedule") return <><DialogHeader><DialogTitle>Reschedule {demoId}</DialogTitle><DialogDescription>Old pending reminders are superseded; new ones are queued (simulated).</DialogDescription></DialogHeader>
    <Field label="New date / time (IST)"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
    <Field label="Reason (required)"><NativeSelect value={reason} onChange={setReason} options={[["", "Choose reason"], "Student requested", "Trainer unavailable", "Batch timing change", "Other"]} /></Field>
    <DialogFooter><Button disabled={!reason || !at} onClick={() => { reschedule(demoId, at, reason); onDone(`${demoId} rescheduled · old reminders superseded`); }}>Confirm reschedule</Button></DialogFooter></>;
  if (kind === "cancel") return <><DialogHeader><DialogTitle>Cancel {demoId}</DialogTitle><DialogDescription>Pending reminders are cleared in sample state. No message is sent.</DialogDescription></DialogHeader>
    <Field label="Cancellation reason (required)"><NativeSelect value={reason} onChange={setReason} options={[["", "Choose reason"], "Student not available", "Duplicate booking", "Course changed", "Other"]} /></Field>
    <DialogFooter><Button variant="destructive" disabled={!reason} onClick={() => { cancel(demoId, reason); onDone(`${demoId} cancelled · pending reminders cleared`); }}>Confirm cancellation</Button></DialogFooter></>;
  return <><DialogHeader><DialogTitle>Attendance & outcome · {demoId}</DialogTitle><DialogDescription>Trainer confirms attendance/feedback. Commercial follow-up target: within 2 staffed hours.</DialogDescription></DialogHeader>
    <div className="grid gap-2">
      <Field label="Attendance"><NativeSelect value={o.status} onChange={(x) => setO({ ...o, status: x as "Attended" | "No-show" })} options={["Attended", "No-show"]} /></Field>
      <Field label="Student feedback"><Textarea value={o.studentFeedback} onChange={(e) => setO({ ...o, studentFeedback: e.target.value })} /></Field>
      <Field label="Trainer feedback"><Textarea value={o.trainerFeedback} onChange={(e) => setO({ ...o, trainerFeedback: e.target.value })} /></Field>
      <Field label="Outcome"><NativeSelect value={o.outcome} onChange={(x) => setO({ ...o, outcome: x })} options={["Interested — fee discussion", "Needs another demo", "Considering other course", "Not interested", "No-show — reschedule attempt"]} /></Field>
      <Field label="Recommended course"><NativeSelect value={o.recommendedCourse} onChange={(x) => setO({ ...o, recommendedCourse: x })} options={[["", "Same course"], ...courseCatalog.map((c) => c.name)]} /></Field>
      <Field label="Next action"><Input value={o.nextAction} onChange={(e) => setO({ ...o, nextAction: e.target.value })} /></Field>
      <Field label="Commercial owner"><NativeSelect value={o.commercialOwner} onChange={(x) => setO({ ...o, commercialOwner: x })} options={ownerOptions(leadBranch).map((s) => s.name)} /></Field>
      <Field label="Next follow-up (exact IST)"><Input type="datetime-local" value={o.nextFollowUp} onChange={(e) => setO({ ...o, nextFollowUp: e.target.value })} /></Field>
    </div>
    <DialogFooter><Button disabled={!o.nextFollowUp} onClick={() => onDone(outcome(demoId, o))}><Check />Save outcome</Button></DialogFooter></>;
}

/* ============================ ADMISSIONS / STUDENTS ============================ */
export function Admissions() {
  const { branch } = useCrmScope();
  const { admissions, persons } = useCrmData();
  const rows = admissions.filter((a) => branch === "All Branches" || a.originalBranch === branch || a.serviceBranch === branch);
  return (
    <>
      <PageHead title="Admissions" description={`${branch} · delivery, allocation and academic handover · SAMPLE DATA`} actions={<><Button asChild><Link to="/admissions/new"><Plus />Create Admission</Link></Button><Button asChild variant="outline"><Link to="/batches">Batch Workspace</Link></Button></>} />
      <div className="mb-4 grid gap-3 md:grid-cols-3"><Warning>Confirmed seat: allocate within 1 working day after Admission and before first class.</Warning><Warning>Future plan: allocate at least 48h before first class.</Warning><Warning>Unresolved 24h before start escalates to Founder / CEO or Super Admin.</Warning></div>
      <Section title="Admission and enrolment records" subtitle="Each admission shows its accepted delivery plan and first qualifying verified payment">
        {rows.length ? <PrototypeTable headers={["Admission", "Person", "Original / service / collecting branch", "Course", "Accepted plan", "First verified payment", "Curriculum", "Enrolment", "Batch", "Joining date"]} rows={rows.map((a) => [a.id, <Link to="/students/$personId" params={{ personId: a.personId }} className="text-primary">{persons.find((p) => p.id === a.personId)?.name}<small className="block text-muted-foreground">{a.personId}</small></Link>, `${a.originalBranch} / ${a.serviceBranch} / ${a.collectingBranch}`, a.course, a.planAccepted, a.firstQualifyingPayment, a.curriculum ?? <Status>Curriculum Mapping Pending</Status>, <Status>{a.enrolment}</Status>, a.batchId ? <Link to="/batches/$batchId" params={{ batchId: a.batchId }} className="text-primary">{a.batchId}</Link> : <Link to="/batches" className="text-primary">Allocate</Link>, a.firstAttendance ? fmtDate(a.firstAttendance) : "Not yet — first regular class"])} /> : <Empty>No admissions in {branch}.</Empty>}
      </Section>
    </>
  );
}

export function Students() {
  const { branch } = useCrmScope();
  const data = useCrmData();
  const people = data.persons.filter((p) => data.admissions.some((a) => a.personId === p.id) && (branch === "All Branches" || p.originalBranch === branch || data.admissions.some((a) => a.personId === p.id && a.serviceBranch === branch)));
  return (
    <>
      <PageHead title="Students" description={`${branch} · one Person / Student Master per learner · separate admissions per course`} />
      <div className="panel">{people.length ? <PrototypeTable headers={["Person ID", "Student", "Original branch", "Admissions", "Courses", "Verified paid", "Pending verification", "Outstanding"]} rows={people.map((p) => {
        const inv = data.invoices.filter((i) => i.personId === p.id && i.admissionId);
        const sums = inv.map((i) => invoiceSummary(data, i));
        return [p.id, <Link to="/students/$personId" params={{ personId: p.id }} className="font-semibold text-primary">{p.name}</Link>, p.originalBranch, data.admissions.filter((a) => a.personId === p.id).length, data.admissions.filter((a) => a.personId === p.id).map((a) => a.course).join(", "), inr(sums.reduce((a, s) => a + s.verified, 0)), inr(sums.reduce((a, s) => a + s.pending, 0)), inr(sums.reduce((a, s) => a + s.outstanding, 0))];
      })} /> : <Empty>No students in {branch}.</Empty>}</div>
    </>
  );
}

export function Student360() {
  const { personId } = useParams({ strict: false }) as { personId?: string };
  const data = useCrmData();
  const { branch } = useCrmScope();
  const [addOpen, setAddOpen] = useState(false);
  const p = data.persons.find((x) => x.id === personId);
  if (!p) return <><PageHead title="Person not found" description={`No sample Person ${personId ?? ""}`} /><Empty><Link to="/students" className="text-primary">Back to Students</Link></Empty></>;
  const allAdms = data.admissions.filter((a) => a.personId === p.id);
  const inScope = branch === "All Branches" || p.originalBranch === branch || allAdms.some((a) => a.serviceBranch === branch);
  // Canonical Person is shared; records are shown only for the viewer's branch (lead branch · admission service branch · invoice collecting branch).
  const scoped = branch === "All Branches";
  const adms = allAdms.filter((a) => scoped || a.serviceBranch === branch);
  if (!inScope) return <><PageHead title="Outside branch scope" description={`${p.id} belongs to ${p.originalBranch}.`} /><Warning>Branch-scoped UI simulation: record hidden for {branch} scope.</Warning></>;
  const opps = data.leads.filter((l) => l.personId === p.id && (scoped || l.branch === branch));
  const invs = data.invoices.filter((i) => i.personId === p.id && (scoped || i.branch === branch));
  const sums = invs.map((i) => ({ i, s: invoiceSummary(data, i) }));
  const outstanding = sums.filter((x) => x.i.admissionId).reduce((a, x) => a + x.s.outstanding, 0);
  const tabs: Record<string, ReactNode> = {
    Person: <PrototypeTable headers={["Person ID", "Name", "Contact (masked)", "WhatsApp", "Original branch", "Identity"]} rows={[[p.id, p.name, `${p.phone} · ${p.email}`, p.whatsapp, p.originalBranch, "One canonical Person / Student Master / LMS identity"]]} />,
    "Enquiries / Opportunities": <PrototypeTable headers={["Opportunity", "Course", "Branch", "Stage", "Owner"]} rows={opps.map((l) => [<Link to="/leads/$leadId" params={{ leadId: l.id }} className="text-primary">{l.id}</Link>, l.course, l.branch, <Status>{l.stage}</Status>, l.owner])} />,
    "Admissions & Batches": adms.length ? <PrototypeTable headers={["Admission", "Course", "Original / service / collecting", "Accepted plan", "Curriculum", "Enrolment", "Batch", "Joining date"]} rows={adms.map((a) => [a.id, a.course, `${a.originalBranch} / ${a.serviceBranch} / ${a.collectingBranch}`, a.planAccepted, a.curriculum ?? <span>Curriculum Mapping Pending · recovery: Academic Coordinator ({branchCode(a.serviceBranch)})</span>, <Status>{a.enrolment}</Status>, a.batchId ? <Link to="/batches/$batchId" params={{ batchId: a.batchId }} className="text-primary">{a.batchId}</Link> : "Awaiting allocation", a.firstAttendance ? fmtDate(a.firstAttendance) : "—"])} /> : <Empty>{scoped ? "No admission yet." : `No admissions serviced by ${branch} for this Person.`}</Empty>,
    Finance: sums.length ? <PrototypeTable headers={["Invoice", "Admission", "Billed", "Verified paid", "Pending verification", "Outstanding", "Due position"]} rows={sums.map(({ i, s }) => [<Link to="/invoices/$invoiceId" params={{ invoiceId: i.id }} className="text-primary">{i.id}</Link>, i.admissionId ?? "Pre-admission", inr(i.billed), inr(s.verified), inr(s.pending), inr(s.outstanding), <Status>{s.duePosition}</Status>])} /> : <Empty>{scoped ? "No invoices." : `No accessible finance rows in ${branch} scope. Invoices collected by another branch are hidden.`}</Empty>,
    "Certificates & Documents": <PrototypeTable headers={["Item", "State"]} rows={[["Certificate", "Eligibility Rules Pending — no issuance rules defined"], ["Identity documents", "Review Required (sample)"]]} />,
    Timeline: <div className="space-y-3 border-l-2 pl-5">{opps.flatMap((l) => l.timeline.map((t) => ({ ...t, lead: l.id }))).map((t, i) => <div key={i}><div className="text-xs text-muted-foreground">{t.at} · {t.lead}</div><div className="text-sm font-semibold">{t.title}</div><div className="text-sm text-muted-foreground">{t.detail}</div></div>)}</div>,
  };
  return (
    <>
      <PageHead title={p.name} description={`${p.id} · original branch ${p.originalBranch} · SAMPLE DATA`} actions={<><Button onClick={() => setAddOpen(true)}><Plus />Add Another Course</Button><Button asChild variant="outline"><Link to="/payments">Record Payment</Link></Button><Button variant="outline" onClick={() => demoAction("Open LMS")}>Open LMS</Button></>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Opportunities", String(opps.length)], ["Admissions", adms.map((a) => a.id).join(", ") || "None"], ["Outstanding (verified basis)", inr(outstanding)], ["LMS", "Stale / Unavailable · Pending Verification"]].map((x) => <div className="panel min-w-0" key={x[0]}><small>{x[0]}</small><div className="break-words font-semibold">{x[1]}</div><small>SAMPLE DATA</small></div>)}</div>
      <div className="mt-4 panel overflow-x-auto"><Tabs defaultValue="Person"><TabsList className="min-w-max">{Object.keys(tabs).map((t) => <TabsTrigger value={t} key={t}>{t}</TabsTrigger>)}</TabsList>{Object.entries(tabs).map(([t, c]) => <TabsContent value={t} key={t}><div className="mt-4">{c}</div></TabsContent>)}</Tabs></div>
      <NewLeadDialog open={addOpen} onOpenChange={setAddOpen} personId={p.id} presetCourse={courseCatalog.find((c) => !opps.some((o) => o.course === c.name))?.name} />
    </>
  );
}

/* ============================ INVOICES / PAYMENTS ============================ */
export function Invoices() {
  const { branch } = useCrmScope();
  const data = useCrmData();
  const rows = scopeRows(data.invoices, branch, (i) => i.branch);
  const sums = rows.map((i) => ({ i, s: invoiceSummary(data, i) }));
  const tot = sums.reduce((a, { i, s }) => ({ billed: a.billed + i.billed, verified: a.verified + s.verified, pending: a.pending + s.pending, out: a.out + s.outstanding }), { billed: 0, verified: 0, pending: 0, out: 0 });
  return (
    <>
      <PageHead title="Invoice Register" description={`${branch} · collecting branch · SAMPLE DATA — no quotation/proforma workflow`} actions={<><Button asChild variant="outline"><Link to="/fee-quote">Fee Discussion & Invoice</Link></Button><Button asChild variant="outline"><Link to="/payments">Payments & Receipts</Link></Button></>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Invoice billed", tot.billed], ["Verified paid", tot.verified], ["Pending verification (excluded)", tot.pending], ["Outstanding", tot.out]].map(([k, v]) => <div className="panel" key={k}><small>{k}</small><div className="text-lg font-semibold">{inr(v as number)}</div><small>SAMPLE DATA</small></div>)}</div>
      <Section title="Invoices">{sums.length ? <PrototypeTable headers={["Invoice", "Person", "Admission", "Course", "Branch", "Billed", "Verified paid", "Pending verification", "Outstanding", "Next due", "Completion", "Due position"]} rows={sums.map(({ i, s }) => [<Link to="/invoices/$invoiceId" params={{ invoiceId: i.id }} className="font-semibold text-primary">{i.id}</Link>, data.persons.find((p) => p.id === i.personId)?.name, i.admissionId ?? "Pre-admission", i.course, i.branch, inr(i.billed), inr(s.verified), inr(s.pending), inr(s.outstanding), s.nextDue ? fmtDate(s.nextDue.due) : "—", <Status>{s.completion}</Status>, <Status>{s.duePosition}</Status>])} /> : <Empty>No invoices in {branch}.</Empty>}</Section>
    </>
  );
}

export function InvoiceDetail() {
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const data = useCrmData();
  const { branch, role } = useCrmScope();
  const [print, setPrint] = useState<string | null>(null);
  const [corr, setCorr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const inv = data.invoices.find((i) => i.id === invoiceId);
  if (!inv) return <><PageHead title="Invoice not found" description={invoiceId ?? ""} /><Empty><Link to="/invoices" className="text-primary">Back to Invoice Register</Link></Empty></>;
  if (branch !== "All Branches" && inv.branch !== branch) return <><PageHead title="Outside branch scope" description={`${inv.id} collected by ${inv.branch}.`} /><Warning>Branch-scoped UI simulation.</Warning></>;
  const s = invoiceSummary(data, inv);
  const person = data.persons.find((p) => p.id === inv.personId)!;
  const printed = print ? data.payments.find((p) => p.id === print) : undefined;
  const doCorrect = () => {
    if (!reason.trim()) { toast.error("A reason is required for any correction."); return; }
    if (!isGlobal(role) && !role.endsWith("Accounts")) { toast.error("Blocked: only Accounts, Founder / CEO or Super Admin can request corrections (UI simulation)."); return; }
    const r = data.requestCorrection(corr!, reason, role);
    if (r.ok) { toast.success(r.msg); setCorr(null); setReason(""); } else toast.error(r.msg);
  };
  const decide = (id: string, d: "Approved" | "Rejected") => { const r = data.decideCorrection(id, d, role); if (r.ok) toast.success(r.msg); else toast.error(r.msg); };
  const reqs = data.corrections.filter((c) => c.invoiceId === inv.id);
  return (
    <>
      <PageHead title={inv.id} description={`${person.name} · ${inv.course} · ${inv.branch} · SAMPLE DATA`} actions={<><Button variant="outline" onClick={() => setPrint("INVOICE")}><Printer />Print preview</Button><Button variant="outline" onClick={() => demoAction("Email resend")}><Mail />Email resend</Button></>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Billed", inr(inv.billed)], ["Verified paid", inr(s.verified)], ["Pending verification", `${inr(s.pending)} · not counted`], ["Outstanding", inr(s.outstanding)]].map((x) => <div className="panel" key={x[0]}><small>{x[0]}</small><div className="text-lg font-semibold">{x[1]}</div></div>)}</div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section title="Invoice details" className="min-w-0">
          <dl className="space-y-2 text-sm">{[["Person", `${person.name} · ${person.id}`], ["Opportunity", inv.leadId], ["Admission", inv.admissionId ?? "Pre-admission (no Admission until verified qualifying payment + accepted plan)"], ["Course", `${courseCode(inv.course)} · ${inv.course}`], ["Collecting branch", inv.branch], ["Issued", fmtDate(inv.issuedOn)], ["Approved terms", inv.terms], ["Plan", inv.plan], ["Payment Completion", s.completion], ["Due Position", s.duePosition], ["Invoice state", s.state]].map((x) => <div key={x[0]} className="flex justify-between gap-3"><dt className="text-muted-foreground">{x[0]}</dt><dd className="min-w-0 break-words text-right font-medium">{x[1]}</dd></div>)}</dl>
        </Section>
        <Section title="Instalment schedule" subtitle="Allocated from verified events only" className="min-w-0 lg:col-span-2">
          <PrototypeTable headers={["#", "Due date", "Amount", "Verified allocated", "Remaining", "Position"]} rows={s.installments.map((i) => [i.n, fmtDate(i.due), inr(i.amount), inr(i.paid), inr(i.amount - i.paid), i.paid >= i.amount ? "Paid" : i.due < SAMPLE_TODAY ? `Overdue · ${ageBand(Math.round((Date.parse(SAMPLE_TODAY) - Date.parse(i.due)) / 86400000))} days` : i.due === SAMPLE_TODAY ? "Due Today" : "Upcoming"])} />
        </Section>
      </div>
      <Section title="Linked payment history" subtitle="Immutable ledger · corrections are linked new events · no deletion or overwrite" className="mt-4">
        {s.events.length ? <PrototypeTable headers={["Receipt / event", "Kind", "Amount", "Method", "Collector", "Recorded", "Reference", "Verification", "Proof review", "Actions"]} rows={s.events.map((p) => { const vs = paymentStatus(data, p.id); return [p.id, p.kind + (p.linkedTo ? ` → ${p.linkedTo}` : ""), inr(p.amount), p.method, p.collector, fmtDateTime(p.at), `${p.reference}${p.reason ? ` · ${p.reason} · requested by ${p.requestedBy ?? "—"} · approved by ${p.approvedBy}` : ""}`, <span><Status>{vs}</Status>{verifiedAt(data, p.id) && <small className="block text-muted-foreground">{fmtDateTime(verifiedAt(data, p.id)!)}</small>}</span>, <span className="text-xs">{p.proof}</span>, <div className="flex flex-wrap gap-1">{p.kind === "Payment" && <Button size="sm" variant="outline" onClick={() => setPrint(p.id)}>Receipt</Button>}{p.kind === "Payment" && !data.payments.some((x) => x.linkedTo === p.id) && <Button size="sm" variant="ghost" onClick={() => setCorr(p.id)}>Request correction</Button>}</div>]; })} /> : <Empty>No payments recorded against this invoice.</Empty>}
      </Section>
      <Section title="Correction requests" subtitle="Requests never change the ledger. Only a distinct Founder / CEO or Super Admin approval appends a linked reversal." className="mt-4">
        {reqs.length ? <PrototypeTable headers={["Request", "Receipt", "Amount", "Reason", "Requested by", "Status", "Decided by", "Reversal", "Actions"]} rows={reqs.map((c) => [c.id, c.paymentId, inr(c.amount), c.reason, `${c.requestedBy} · ${fmtDateTime(c.requestedAt)}`, <Status>{c.status}</Status>, c.decidedBy ? `${c.decidedBy} · ${fmtDateTime(c.decidedAt!)}` : "—", c.reversalId ?? "—", c.status === "Pending Approval" ? (isGlobal(role) && role !== c.requestedBy ? <div className="flex flex-wrap gap-1"><Button size="sm" onClick={() => decide(c.id, "Approved")}>Approve</Button><Button size="sm" variant="outline" onClick={() => decide(c.id, "Rejected")}>Reject</Button></div> : <span className="text-xs text-muted-foreground">{role === c.requestedBy ? "Self-approval blocked — switch to a distinct approver role" : "Awaiting Founder / CEO or Super Admin"}</span>) : "—"])} /> : <Empty>No correction requests for this invoice.</Empty>}
      </Section>
      <Dialog open={!!corr} onOpenChange={(o) => !o && setCorr(null)}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
          <DialogHeader><DialogTitle>Request correction for {corr}</DialogTitle><DialogDescription>Submits a pending request with your reason and role ({role}). Nothing changes in the ledger until a distinct Founder / CEO or Super Admin approves. Pending or Failed receipts cannot be corrected — mark them Failed on Payments & Receipts.</DialogDescription></DialogHeader>
          <Field label="Reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <DialogFooter><Button onClick={doCorrect}>Submit for approval</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!print} onOpenChange={(o) => !o && setPrint(null)}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Print preview · {print === "INVOICE" ? "Sample invoice" : "Sample receipt"}</DialogTitle><DialogDescription>Not a live issued document. No PDF is generated or delivered.</DialogDescription></DialogHeader>
          <div className="print-sheet">
            <div className="print-watermark" aria-hidden>SAMPLE</div>
            <SampleNotice />
            <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm"><div><b>Nipuna Technologies · {inv.branch === "Guntur" ? "NIT-GNT" : "NIT-VIJ"}</b><div className="text-muted-foreground">Prototype document · not valid for payment or tax</div></div><div className="text-right"><b>{print === "INVOICE" ? inv.id : printed?.id}</b><div>{print === "INVOICE" ? fmtDate(inv.issuedOn) : printed && fmtDateTime(printed.at)}</div></div></div>
            <div className="mt-3 text-sm">Bill to: {person.name} · {person.id} · {person.email}</div>
            {print === "INVOICE" ? <div className="mt-3"><PrototypeTable headers={["Course", "Terms", "Billed"]} rows={[[`${courseCode(inv.course)} · ${inv.course}`, inv.terms, inr(inv.billed)]]} /><p className="mt-2 text-sm">Verified paid {inr(s.verified)} · Pending verification {inr(s.pending)} (not counted) · Outstanding {inr(s.outstanding)}</p></div>
              : printed && <div className="mt-3"><PrototypeTable headers={["Invoice", "Method", "Amount", "Verification"]} rows={[[inv.id, printed.method, inr(printed.amount), paymentStatus(data, printed.id)]]} />{paymentStatus(data, printed.id) !== "Verified" && <p className="mt-2 text-sm font-semibold">Acknowledgement of proof only — not a verified receipt.</p>}</div>}
            <div className="mt-4"><SampleNotice /></div>
          </div>
          <DialogFooter><Button onClick={() => window.print()}><Printer />Print (browser)</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function Payments() {
  const { branch, role } = useCrmScope();
  const data = useCrmData();
  const invs = scopeRows(data.invoices, branch, (i) => i.branch);
  const [v, setV] = useState({ invoiceId: invs[0]?.id ?? "", amount: "5000", method: "UPI/Bank Transfer" as string, reference: "SAMPLE-REF-0001", collector: "" });
  const inv = data.invoices.find((i) => i.id === v.invoiceId);
  const ledger = data.payments.filter((p) => invs.some((i) => i.id === p.invoiceId)).slice().sort((a, b) => b.at.localeCompare(a.at));
  const verifiedTotal = ledger.filter((p) => paymentStatus(data, p.id) === "Verified").reduce((a, p) => a + p.amount, 0);
  const pendingTotal = ledger.filter((p) => paymentStatus(data, p.id) === "Pending Verification" && p.amount > 0).reduce((a, p) => a + p.amount, 0);
  const record = () => {
    if (!inv) { toast.error("Choose an invoice in scope."); return; }
    const amt = Number(v.amount);
    if (!amt || amt <= 0) { toast.error("Enter a positive sample amount."); return; }
    const out = invoiceSummary(data, inv).outstanding;
    if (amt > out) { toast.error(`Blocked: ${inr(amt)} exceeds outstanding ${inr(out)}. Excess must be handled as an Unallocated Advance by Accounts.`); return; }
    const p = data.recordPayment({ invoiceId: inv.id, amount: amt, method: v.method, reference: v.reference, collector: v.collector || (ownerOptions(inv.branch)[0]?.name ?? ""), at: `${SAMPLE_TODAY}T${new Date().toTimeString().slice(0, 5)}` });
    toast.success(`${p.id} recorded as Pending Verification. Outstanding and verified totals are unchanged until Accounts verifies.`);
  };
  const verify = (id: string, result: "Verified" | "Failed") => {
    if (!canFinance(role)) { toast.error("Blocked: only Accounts, Founder / CEO or Super Admin can verify (UI simulation)."); return; }
    const r = data.verifyPayment(id, result, role);
    if (r.ok) toast.success(r.msg); else toast.error(r.msg);
  };
  return (
    <>
      <PageHead title="Payments & Receipts" description={`${branch} · immutable ledger · SAMPLE DATA`} actions={<><Button asChild variant="outline"><Link to="/invoices">Invoice Register</Link></Button><ResetDemo /></>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Record Payment" className="min-w-0 lg:col-span-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Invoice"><NativeSelect value={v.invoiceId} onChange={(x) => setV({ ...v, invoiceId: x })} options={invs.map((i) => [i.id, `${i.id} · ${data.persons.find((p) => p.id === i.personId)?.name}`] as [string, string])} /></Field>
            <Field label="Amount (₹, sample)"><Input inputMode="numeric" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value.replace(/\D/g, "") })} /></Field>
            <Field label="Method"><NativeSelect value={v.method} onChange={(x) => setV({ ...v, method: x })} options={[...paymentMethods]} /></Field>
            <Field label="Reference (sample)"><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
            <Field label="Collector"><NativeSelect value={v.collector} onChange={(x) => setV({ ...v, collector: x })} options={[["", "Default branch collector"], ...(inv ? staff.filter((s) => s.branch === inv.branch && s.role !== "Trainer").map((s) => s.name) : [])]} /></Field>
            <Field label="Proof"><Button variant="outline" onClick={() => demoAction("Proof upload")}>Attach proof (placeholder)</Button></Field>
          </div>
          <Button className="mt-3" onClick={record}><CircleDollarSign />Record Payment</Button>
          <p className="mt-2 text-xs text-muted-foreground">New payments start as Pending Verification. Admission requires accepted delivery plan + first qualifying allocated payment Verified.</p>
        </Section>
        <Section title="Payment truth" className="min-w-0"><dl className="space-y-3 text-sm">{[["Payment Completion", "Unpaid / Part Paid / Paid"], ["Due Position", "Upcoming / Due Today / Overdue"], ["Verification", "Pending Verification / Verified / Failed"], ["Verified net (scope)", inr(verifiedTotal)], ["Pending verification (excluded)", inr(pendingTotal)]].map((x) => <div key={x[0]}><dt className="text-muted-foreground">{x[0]}</dt><dd className="font-semibold">{x[1]}</dd></div>)}</dl></Section>
      </div>
      <Section title="Immutable payment ledger" subtitle="Pending Verification is excluded from verified totals. Corrections create linked reversal events on the invoice page." className="mt-4">
        {ledger.length ? <PrototypeTable headers={["Receipt / event", "Invoice", "Person", "Branch", "Amount", "Method", "Recorded", "Verification", "Actions"]} rows={ledger.map((p) => { const i = data.invoices.find((x) => x.id === p.invoiceId)!; const vs = paymentStatus(data, p.id); return [p.id, <Link to="/invoices/$invoiceId" params={{ invoiceId: i.id }} className="text-primary">{i.id}</Link>, data.persons.find((x) => x.id === i.personId)?.name, i.branch, inr(p.amount), p.method, fmtDateTime(p.at), <Status>{vs}</Status>, vs === "Pending Verification" && p.kind === "Payment" && p.amount > 0 ? <div className="flex gap-1"><Button size="sm" onClick={() => verify(p.id, "Verified")}>Verify</Button><Button size="sm" variant="outline" onClick={() => verify(p.id, "Failed")}>Fail</Button></div> : "—"]; })} /> : <Empty>No ledger events in {branch}.</Empty>}
      </Section>
    </>
  );
}

export function Collections() {
  const { branch } = useCrmScope();
  const data = useCrmData();
  const [tab, setTab] = useState("Due Today");
  const all = scopeRows(data.invoices, branch, (i) => i.branch).flatMap((inv) => {
    const s = invoiceSummary(data, inv);
    return s.installments.filter((i) => i.paid < i.amount).map((i) => {
      const late = Math.round((Date.parse(SAMPLE_TODAY) - Date.parse(i.due)) / 86400000);
      return { inv, s, i, position: late > 0 ? "Overdue" : late === 0 ? "Due Today" : "Upcoming", age: ageBand(late), person: data.persons.find((p) => p.id === inv.personId)!.name };
    });
  });
  const rows = tab === "All Plans" || tab === "Ageing" ? all : all.filter((x) => x.position === tab);
  return (
    <>
      <PageHead title="Collections" description={`${branch} · one coordinated plan per Admission · SAMPLE DATA`} />
      <Section title="Approved payment plans" subtitle="No automatic late fee, Admission cancellation or LMS block"><PrototypeTable headers={["Plan", "Schedule"]} rows={[["Full", "Full Payment"], ["Two Instalments", "50% + 50% on exact agreed date within Day 10–15"], ["Three Instalments", "50% Day 0 · 25% Day 10 · 25% Day 15"]]} /></Section>
      <div className="mt-4 panel"><Tabs value={tab} onValueChange={setTab}><TabsList className="mb-4 h-auto max-w-full overflow-x-auto">{["Due Today", "Overdue", "Upcoming", "All Plans", "Ageing"].map((t) => <TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}</TabsList><TabsContent value={tab}>
        {rows.length ? <PrototypeTable headers={["Person", "Invoice / admission", "Branch", "Plan", "Instalment", "Due date", "Remaining", "Position", "Age band", "Contact hold"]} rows={rows.map((x) => [x.person, <Link to="/invoices/$invoiceId" params={{ invoiceId: x.inv.id }} className="text-primary">{x.inv.id}<small className="block text-muted-foreground">{x.inv.admissionId ?? "Pre-admission"}</small></Link>, x.inv.branch, x.inv.plan, `#${x.i.n}`, fmtDate(x.i.due), inr(x.i.amount - x.i.paid), <Status>{x.position}</Status>, x.age, x.s.pending > 0 ? `Pending verification · contact paused for ${inr(Math.min(x.s.pending, x.i.amount - x.i.paid))}; ageing stays visible` : "None"])} /> : <Empty>No sample dues match {tab} in {branch}.</Empty>}
      </TabsContent></Tabs></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2"><Section title="Ageing bands"><p className="text-sm">1–3 · 4–7 · 8–15 · 16–30 · 31–60 · 61–90 · 91+ days</p></Section><Section title="Reminder and escalation timeline"><p className="text-sm leading-6">Day -3 · due date · +3 reminder · +4 owner · +7 manager · max one proactive follow-up per week through Day 30 · then management plan. Reminders are not sent in this prototype.</p></Section></div>
    </>
  );
}

/* ================================ BATCHES ================================ */
export function Batches() {
  const { branch } = useCrmScope();
  const data = useCrmData();
  const rows = scopeRows(data.batches, branch, (b) => b.branch);
  const waiting = data.admissions.filter((a) => !a.batchId && a.enrolment === "Awaiting Batch Allocation" && (branch === "All Branches" || a.serviceBranch === branch || a.originalBranch === branch));
  return (
    <>
      <PageHead title="Batch Workspace" description={`${branch} · schedule, capacity and allocation · SAMPLE DATA — links are non-connected placeholders`} actions={<ResetDemo />} />
      <div className="mb-4 grid gap-3 md:grid-cols-3"><Warning>Accepted delivery plan, enrolment, batch allocation and first regular attendance are separate records.</Warning><Warning>Confirmed seat: allocate within 1 working day after Admission and before first class · future plan ≥ 48h before first class.</Warning><Warning>Unresolved 24h before start escalates to Founder / CEO or Super Admin.</Warning></div>
      <Section title="Batches">{rows.length ? <PrototypeTable headers={["Batch", "Branch", "Course / curriculum", "Trainer", "Mode", "Start → expected end", "Timing", "Days", "Min", "Occupancy", "Status"]} rows={rows.map((b) => { const occ = occupancy(data, b); return [<Link to="/batches/$batchId" params={{ batchId: b.id }} className="font-semibold text-primary">{b.id}</Link>, b.branch, `${b.course} · ${b.curriculum}`, b.trainer, b.mode, `${fmtDate(b.start)} → ${fmtDate(b.end)}`, `${b.timing} · ${b.duration}`, b.days, b.minStudents, `${occ}/${b.capacity}`, <Status>{occ >= b.capacity ? "Full" : b.status}</Status>]; })} /> : <Empty>No batches in {branch}.</Empty>}</Section>
      <Section title="Awaiting batch allocation" className="mt-4">{waiting.length ? <PrototypeTable headers={["Admission", "Person", "Course", "Service branch", "Curriculum", "Admitted"]} rows={waiting.map((a) => [a.id, data.persons.find((p) => p.id === a.personId)?.name, a.course, a.serviceBranch, a.curriculum ?? <Status>Curriculum Mapping Pending</Status>, fmtDate(a.admittedOn)])} /> : <Empty>No admissions awaiting allocation in {branch}.</Empty>}</Section>
    </>
  );
}

export function BatchDetail() {
  const { batchId } = useParams({ strict: false }) as { batchId?: string };
  const data = useCrmData();
  const { branch, role } = useCrmScope();
  const b = data.batches.find((x) => x.id === batchId);
  const [adm, setAdm] = useState("");
  const [result, setResult] = useState<{ ok: boolean; reason: string; owner?: string } | null>(null);
  const candidates = useMemo(() => data.admissions.filter((a) => !a.batchId && a.enrolment === "Awaiting Batch Allocation" && (branch === "All Branches" || a.originalBranch === branch || a.serviceBranch === branch)), [data.admissions, branch]);
  if (!b) return <><PageHead title="Batch not found" description={batchId ?? ""} /><Empty><Link to="/batches" className="text-primary">Back to Batches</Link></Empty></>;
  if (branch !== "All Branches" && b.branch !== branch) return <><PageHead title="Outside branch scope" description={`${b.id} is a ${b.branch} batch.`} /><Warning>Branch-scoped UI simulation.</Warning></>;
  const occ = occupancy(data, b);
  const members = data.admissions.filter((a) => a.batchId === b.id);
  const canAllocate = isGlobal(role) || role.includes("Academic Coordinator") || role.includes("Branch Manager");
  const check = adm ? allocationCheck(data, adm, b.id) : null;
  return (
    <>
      <PageHead title={b.id} description={`${b.branch} · ${b.course} · SAMPLE DATA`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Schedule" className="min-w-0"><dl className="space-y-2 text-sm">{[["Branch", b.branch], ["Course", `${courseCode(b.course)} · ${b.course}`], ["Curriculum version", b.curriculum], ["Trainer", b.trainer], ["Mode", b.mode], ["Start", fmtDate(b.start)], ["Expected end", fmtDate(b.end)], ["Timing", b.timing], ["Duration", b.duration], ["Class days", b.days], ["Room / link", b.location], ["Minimum students", String(b.minStudents)], ["Capacity / occupancy", `${occ}/${b.capacity} (includes ${b.otherSeats} unnamed sample seats)`], ["Status", occ >= b.capacity ? "Full" : b.status]].map((x) => <div key={x[0]} className="flex justify-between gap-3"><dt className="text-muted-foreground">{x[0]}</dt><dd className="min-w-0 break-words text-right font-medium">{x[1]}</dd></div>)}</dl>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => demoAction("Open class link")}>Open class link</Button></Section>
        <Section title="Allocate admission" subtitle="Checks branch, course, curriculum mapping and capacity" className="min-w-0 lg:col-span-2">
          {!canAllocate && <Warning>Your prototype role can view but not allocate. Academic Coordinator, Branch Manager, Founder / CEO or Super Admin allocate.</Warning>}
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
            <NativeSelect ariaLabel="Admission to allocate" value={adm} onChange={(x) => { setAdm(x); setResult(null); }} options={[["", "Choose admission awaiting allocation"], ...candidates.map((a) => [a.id, `${a.id} · ${data.persons.find((p) => p.id === a.personId)?.name} · ${a.course} · service ${a.serviceBranch}`] as [string, string])]} />
            <Button disabled={!adm || !canAllocate} onClick={() => { const r = data.allocate(adm, b.id); setResult(r); r.ok ? toast.success(`Allocated ${adm} → ${b.id} (sample). First regular attendance still pending.`) : toast.error(r.reason); }}>Allocate</Button>
          </div>
          {check && !result && <p className={`mt-2 text-sm ${check.ok ? "text-success" : "text-destructive"}`}>Pre-check: {check.reason}{check.owner && ` · Owner: ${check.owner}`}</p>}
          {result && <div className={`mt-2 rounded-md border p-3 text-sm ${result.ok ? "border-success/40" : "border-destructive/40"}`} role="status"><b>{result.ok ? "Allocated" : "Blocked"}</b> — {result.reason}{result.owner && <div>Recovery / decision owner: {result.owner}</div>}</div>}
          <h3 className="mb-2 mt-4 text-sm font-semibold">Allocated in this batch</h3>
          {members.length ? <PrototypeTable headers={["Admission", "Person", "Allocated", "First regular attendance (Joining Date)", ""]} rows={members.map((a) => [a.id, data.persons.find((p) => p.id === a.personId)?.name, a.allocatedOn ? fmtDate(a.allocatedOn) : "—", a.firstAttendance ? fmtDate(a.firstAttendance) : "Not yet recorded", !a.firstAttendance && canAllocate ? <Button size="sm" variant="outline" onClick={() => { data.recordFirstAttendance(a.id); toast.success("First regular class attendance recorded (sample, not from LMS). Demos excluded."); }}>Record first attendance</Button> : "—"])} /> : <Empty>No named sample admissions allocated yet.</Empty>}
        </Section>
      </div>
    </>
  );
}

/* ================================ REPORTS ================================ */
export function Reports() {
  const { branch } = useCrmScope();
  const data = useCrmData();
  const [period, setPeriod] = useState("This Month");
  const [custom, setCustom] = useState({ from: "2026-09-01", to: SAMPLE_TODAY });
  const [course, setCourse] = useState("Any");
  const [owner, setOwner] = useState("Any");
  const [source, setSource] = useState("Any");
  const range = periodRange(period, custom);
  const leadsIn = scopeRows(data.leads, branch, (l) => l.branch).filter((l) => (course === "Any" || l.course === course) && (owner === "Any" || l.owner === owner) && (source === "Any" || l.source === source));
  const invs = scopeRows(data.invoices, branch, (i) => i.branch).filter((i) => (course === "Any" || i.course === course) && (source === "Any" || data.leads.find((l) => l.id === i.leadId)?.source === source) && (owner === "Any" || data.leads.find((l) => l.id === i.leadId)?.owner === owner));
  const events = data.payments.filter((p) => invs.some((i) => i.id === p.invoiceId));
  const verifiedInPeriod = events.filter((p) => paymentStatus(data, p.id) === "Verified" && inRange(verifiedAt(data, p.id), range));
  const gross = verifiedInPeriod.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0);
  const reversals = verifiedInPeriod.filter((p) => p.amount < 0).reduce((a, p) => a + p.amount, 0);
  const pendingNow = events.filter((p) => paymentStatus(data, p.id) === "Pending Verification" && p.amount > 0).reduce((a, p) => a + p.amount, 0);
  const billed = invs.filter((i) => inRange(i.issuedOn, range)).reduce((a, i) => a + i.billed, 0);
  // dues recovery: verified money applied to already-due instalments (subset of verified collections)
  const recovery = invs.reduce((acc, inv) => {
    const s = invoiceSummary(data, inv);
    return acc + s.installments.reduce((a, i) => a + i.recovered, 0) * (verifiedInPeriod.some((p) => p.invoiceId === inv.id) ? 1 : 0);
  }, 0);
  const paidAdmissions = data.admissions.filter((a) => invs.some((i) => i.id === a.invoiceId) && inRange(verifiedAt(data, a.firstQualifyingPayment), range));
  const courses = [...new Set([...invs.map((i) => i.course), ...leadsIn.map((l) => l.course)])];
  const owners = [...new Set(scopeRows(data.leads, branch, (l) => l.branch).map((l) => l.owner))];
  const oppsInPeriod = leadsIn.filter((l) => inRange(l.createdOn, range));
  const dues = invs.flatMap((inv) => invoiceSummary(data, inv).installments.filter((i) => i.paid < i.amount).map((i) => ({ inv, i, pos: i.due < SAMPLE_TODAY ? "Overdue" : i.due === SAMPLE_TODAY ? "Due Today" : "Upcoming" })));
  const batchRows = scopeRows(data.batches, branch, (b) => b.branch).filter((b) => course === "Any" || b.course === course);
  const tr = [...new Set(batchRows.map((b) => b.trainer))];
  const personName = (id: string) => data.persons.find((p) => p.id === id)?.name;
  return (
    <>
      <PageHead title="Reports" description={`${branch} · IST · week Monday–Sunday · fixed sample date 26 Sep 2026 · every figure is SAMPLE DATA`} actions={<Button variant="outline" onClick={() => demoAction("Export")}>Export</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">{["Today", "Yesterday", "This Week", "Last Week", "This Month", "Last Month", "Custom"].map((x) => <Button size="sm" variant={period === x ? "default" : "outline"} onClick={() => setPeriod(x)} key={x}>{x}</Button>)}</div>
      <div className="panel mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {period === "Custom" && <><Field label="From"><Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></Field><Field label="To"><Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></Field></>}
        <Field label="Branch (scope switcher)"><Input value={branch} disabled /></Field>
        <Field label="Course"><NativeSelect value={course} onChange={setCourse} options={["Any", ...courseCatalog.map((c) => c.name)]} /></Field>
        <Field label="Staff (lead owner)"><NativeSelect value={owner} onChange={setOwner} options={["Any", ...owners]} /></Field>
        <Field label="Original Source"><NativeSelect value={source} onChange={setSource} options={["Any", ...sources]} /></Field>
        <div className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-5">Period {fmtDate(range[0])} – {fmtDate(range[1])} IST · Report cutoff: fixed sample date · freshness: simulated, not live</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[["Invoice billed (issued in period)", inr(billed)], ["Verified collections · gross", inr(gross)], ["Refunds / reversals", inr(reversals)], ["Verified collections · net", inr(gross + reversals)], ["Dues recovery (subset of verified)", inr(Math.min(recovery, gross))], ["Pending verification (excluded)", inr(pendingNow)], ["New Paid Admissions (first qualifying verification date)", String(paidAdmissions.length)]].map((x) => <div className="panel" key={x[0]}><small>{x[0]}</small><div className="text-lg font-semibold">{x[1]}</div></div>)}</div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Course enrolment & revenue" subtitle="Admissions by paid-admission date · verified net in period" className="min-w-0">
          {courses.length ? <PrototypeTable headers={["Course", "Paid admissions", "Verified net", "Drill-down"]} rows={courses.map((c) => { const ad = paidAdmissions.filter((a) => a.course === c); return [c, ad.length, inr(verifiedInPeriod.filter((p) => invs.find((i) => i.id === p.invoiceId)?.course === c).reduce((a, p) => a + p.amount, 0)), <span className="flex flex-wrap gap-1">{ad.map((a) => <Link key={a.id} to="/students/$personId" params={{ personId: a.personId }} className="text-primary">{a.id}</Link>)}{!ad.length && "—"}</span>]; })} /> : <Empty>No results for these filters.</Empty>}
        </Section>
        <Section title="Counsellor leads & conversion" subtitle="Opportunities created in period → currently Admitted (same record type)" className="min-w-0">
          {oppsInPeriod.length ? <PrototypeTable headers={["Owner", "Opportunities", "Admitted", "Conversion", "Records"]} rows={[...new Set(oppsInPeriod.map((l) => l.owner))].map((o) => { const ls = oppsInPeriod.filter((l) => l.owner === o); const ad = ls.filter((l) => l.stage === "Admitted").length; return [o, ls.length, ad, `${Math.round((ad / ls.length) * 100)}%`, <span className="flex flex-wrap gap-1">{ls.map((l) => <Link key={l.id} to="/leads/$leadId" params={{ leadId: l.id }} className="text-primary">{l.id}</Link>)}</span>]; })} /> : <Empty>No opportunities created in this period for the filters.</Empty>}
        </Section>
        <Section title="Source / campaign conversion" className="min-w-0">
          {oppsInPeriod.length ? <PrototypeTable headers={["Original Source", "Campaign", "Opportunities", "Admitted", "Records"]} rows={[...new Set(oppsInPeriod.map((l) => `${l.source}|${l.campaign}`))].map((k) => { const [s, c] = k.split("|"); const ls = oppsInPeriod.filter((l) => l.source === s && l.campaign === c); return [s, c, ls.length, ls.filter((l) => l.stage === "Admitted").length, <span className="flex flex-wrap gap-1">{ls.map((l) => <Link key={l.id} to="/leads/$leadId" params={{ leadId: l.id }} className="text-primary">{l.id}</Link>)}</span>]; })} /> : <Empty>No results for these filters.</Empty>}
        </Section>
        <Section title="Trainer batches & students" subtitle="Current snapshot" className="min-w-0">
          {tr.length ? <PrototypeTable headers={["Trainer", "Batches", "Students (incl. unnamed sample seats)", "Records"]} rows={tr.map((t) => { const bs = batchRows.filter((b) => b.trainer === t); return [t, bs.length, bs.reduce((a, b) => a + occupancy(data, b), 0), <span className="flex flex-wrap gap-1">{bs.map((b) => <Link key={b.id} to="/batches/$batchId" params={{ batchId: b.id }} className="text-primary">{b.id}</Link>)}</span>]; })} /> : <Empty>No batches for these filters.</Empty>}
        </Section>
        <Section title="Upcoming / overdue dues" subtitle="Verified-basis remaining per instalment" className="min-w-0 lg:col-span-2">
          {dues.length ? <PrototypeTable headers={["Person", "Invoice", "Instalment", "Due", "Remaining", "Position"]} rows={dues.map((d) => [personName(d.inv.personId), <Link to="/invoices/$invoiceId" params={{ invoiceId: d.inv.id }} className="text-primary">{d.inv.id}</Link>, `#${d.i.n}`, fmtDate(d.i.due), inr(d.i.amount - d.i.paid), <Status>{d.pos}</Status>])} /> : <Empty>No dues for these filters.</Empty>}
        </Section>
      </div>
      <Section title="Scheduled report configuration" className="mt-4"><PrototypeTable headers={["Schedule", "Period", "Recipient", "Delivery"]} rows={[["Daily 08:30", "Previous day", "founder.reports@example.test", <Status>Pending Verification</Status>], ["Monday 09:00", "Previous Mon–Sun", "founder.reports@example.test", <Status>Pending Verification</Status>], ["Month day 1 · 09:30", "Previous month", "founder.reports@example.test", <Status>Pending Verification</Status>]]} /><p className="mt-2 text-xs text-muted-foreground">Scheduled email sending and sender verification remain Pending Verification. No report was sent.</p></Section>
    </>
  );
}

