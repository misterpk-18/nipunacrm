import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  Check,
  CircleDollarSign,
  Columns3,
  List,
  Mail,
  MessageCircle,
  Phone,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCrmData, invoiceSummary, paymentStatus, verifiedAt, periodRange, inRange, inr, fmtDate, fmtDateTime, taskCondition, SAMPLE_TODAY } from "@/lib/crm-store";
import { Students } from "./workflows";
export { Leads, Lead360, Demos, Admissions, Student360, Payments, Collections, Reports, Invoices, InvoiceDetail, Batches, BatchDetail } from "./workflows";
import {
  AiNote,
  ConfirmAction,
  ExportButton,
  FlowLink,
  LeadActions,
  Metric,
  MiniBars,
  PageHead,
  PrototypeTable,
  Section,
  Status,
  Warning,
  demoAction,
} from "./ui";
import { useCrmScope, roleHome, type PrototypeRole } from "./crm-scope";

const branchRows = <T extends { branch: string }>(rows: T[], branch: string) =>
  branch === "All Branches" ? rows : rows.filter((row) => row.branch === branch);
const emptyState = (label: string) => (
  <div className="py-12 text-center text-sm text-muted-foreground">
    No sample records match {label} in this branch.
  </div>
);
const leadTableRows = (items: ReturnType<typeof useCrmData>["leads"]) =>
  items.map((l) => [
    <Link to="/leads/$leadId" params={{ leadId: l.id }} className="font-semibold text-primary">{l.name}<small className="block text-muted-foreground">{l.id}</small></Link>,
    l.phone, l.course, l.branch, l.source, l.owner, <Status>{l.stage}</Status>, l.followUp, l.age,
    <span className="flex items-center gap-2"><Status>{l.priority}</Status><b>{l.score}</b></span>, <LeadActions />,
  ]);
const fields = (names: string[]) => (
  <div className="field-grid">
    {names.map((n, i) => (
      <div className="field" key={n}>
        <Label>{n}</Label>
        {i === names.length - 1 && /Notes|Reason|Outcome/.test(n) ? (
          <Textarea placeholder={`Enter sample ${n.toLowerCase()}`} />
        ) : (
          <Input defaultValue={sampleValue(n)} />
        )}
      </div>
    ))}
  </div>
);
function sampleValue(n: string) {
  const v: Record<string, string> = {
    Course: "Data Science",
    Branch: "Guntur",
    "Standard Fee": "₹30,000",
    "Approved Offer / Version": "v3 · ₹2,000",
    "Extra Approved Concession": "₹1,000",
    "Final Payable Amount": "₹27,000",
    "Payment Plan": "50% Day 0 · 25% Day 10 · 25% Day 15",
    Validity: "7 calendar days or offer expiry, whichever is earlier",
    Counsellor: "Counsellor A (GNT)",
    "Delivery Mode": "Classroom",
    Batch: "Select a batch — required",
    "Agreed Fee": "₹27,000",
    "Admission Date": "24 Sep 2026",
    Documents: "Aadhaar copy (sample)",
    "Payment Status": "Part Paid",
    Admission: "NIT-GNT-2026-000001",
    Amount: "₹15,000",
    "Payment Mode": "UPI / Bank Transfer",
    Date: "24 Sep 2026",
    Reference: "SAMPLE-REF-8821",
    Collector: "Counsellor A (GNT)",
  };
  return v[n] ?? "Sample value";
}
export function Dashboard({ manager = false }: { manager?: boolean }) {
  const { branch } = useCrmScope();
  const data = useCrmData();
  const range = periodRange("This Month");
  const basis = `Sep 2026 month-to-date · 01–${SAMPLE_TODAY.slice(8)} Sep · IST`;
  const calc = (b: string) => {
    const invs = branchRows(data.invoices, b);
    const events = data.payments.filter((p) => invs.some((i) => i.id === p.invoiceId));
    const ver = events.filter((p) => paymentStatus(data, p.id) === "Verified" && inRange(verifiedAt(data, p.id), range));
    const gross = ver.filter((p) => p.amount > 0).reduce((x, p) => x + p.amount, 0);
    const rev = ver.filter((p) => p.amount < 0).reduce((x, p) => x + p.amount, 0);
    const sums = invs.map((i) => invoiceSummary(data, i));
    const recovery = sums.reduce((x, sm) => x + sm.installments.reduce((y, i) => y + i.recovered, 0), 0);
    const overdueDue = sums.reduce((x, sm) => x + sm.installments.filter((i) => i.paid < i.amount && i.due < SAMPLE_TODAY).reduce((y, i) => y + i.amount - i.paid, 0), 0);
    const paidAdm = data.admissions.filter((a) => invs.some((i) => i.id === a.invoiceId) && inRange(verifiedAt(data, a.firstQualifyingPayment), range)).length;
    const octRange: [string, string] = ["2026-10-01", "2026-10-31"];
    const octNet = events.filter((p) => paymentStatus(data, p.id) === "Verified" && inRange(verifiedAt(data, p.id), octRange)).reduce((x, p) => x + p.amount, 0);
    const octAdm = data.admissions.filter((a) => invs.some((i) => i.id === a.invoiceId) && inRange(verifiedAt(data, a.firstQualifyingPayment), octRange)).length;
    return { gross, rev, net: gross + rev, pending: events.filter((p) => paymentStatus(data, p.id) === "Pending Verification" && p.amount > 0).reduce((x, p) => x + p.amount, 0), outstanding: sums.reduce((x, sm) => x + sm.outstanding, 0), overdueDue, recovery, paidAdm, octNet, octAdm };
  };
  const m = calc(branch);
  const leads = branchRows(data.leads, branch);
  const leadsIn = leads.filter((l) => inRange(l.createdOn, range));
  const genuine = leadsIn.filter((l) => !["Invalid-Spam", "Test", "Duplicate Review"].includes(l.intakeStatus));
  const demos = branchRows(data.demos, branch).filter((d) => inRange(d.at, range));
  const dc = (st: string) => demos.filter((d) => d.status === st).length;
  const tasks = branchRows(data.tasks, branch);
  const overdue = tasks.filter((t) => taskCondition(t) === "Overdue").length;
  const unassigned = tasks.filter((t) => t.owner === "Unassigned" && !["Completed", "Cancelled"].includes(t.status)).length;
  const untouched = leads.filter((l) => l.stage === "New Enquiry").length;
  const pendingCorr = data.corrections.filter((c) => c.status === "Pending Approval" && branchRows(data.invoices, branch).some((i) => i.id === c.invoiceId)).length;
  const metrics: [string, string, string][] = manager ? [
    ["Genuine Enquiries", String(genuine.length), "/leads"], ["Unassigned Tasks", String(unassigned), "/tasks"],
    ["Overdue Tasks", String(overdue), "/tasks"], ["Demos Attended / No-shows", `${dc("Attended")} / ${dc("No-show")}`, "/demos"],
    ["Paid Admissions", String(m.paidAdm), "/admissions"], ["Net Verified Collections", inr(m.net), "/collections"],
    ["Outstanding (verified basis)", inr(m.outstanding), "/collections"], ["Pending Verification", `${inr(m.pending)} · not counted`, "/payments"],
  ] : [
    ["Captured Leads", String(leadsIn.length), "/leads"], ["Genuine Enquiries", String(genuine.length), "/leads"],
    ["New Enquiry / Overdue Tasks", `${untouched} / ${overdue}`, "/tasks"], ["Demos S/A/N", `${dc("Scheduled")}/${dc("Attended")}/${dc("No-show")}`, "/demos"],
    ["Paid Admissions", String(m.paidAdm), "/admissions"], ["Gross Verified Collections", inr(m.gross), "/payments"],
    ["Dues Recovery (subset)", inr(m.recovery), "/collections"], ["Outstanding (verified basis)", inr(m.outstanding), "/collections"],
    ["Gross / Refunds-Reversals / Net", `${inr(m.gross)} / ${inr(m.rev)} / ${inr(m.net)}`, "/reports"],
    ["Pending Verification", `${inr(m.pending)} · not counted`, "/payments"], ["Correction Requests Pending", String(pendingCorr), "/invoices"],
    ["Overdue Instalment Value", inr(m.overdueDue), "/collections"],
  ];
  const stages = ["New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited", "Payment Pending Verification", "Admitted", "Lost - closed"];
  const branchesShown = branch === "All Branches" ? ["Guntur", "Vijayawada"] : [branch];
  const oct = branchesShown.map((b) => ({ b, ...calc(b) }));
  return <>
    <PageHead title={manager ? "Branch Manager Dashboard" : "Founder / CEO Dashboard"}
      description={`${branch} · ${basis} · derived from shared SAMPLE DATA records`} />
    <div className="mb-4 flex flex-wrap gap-2"><Status>Requirement Approved</Status><Status>Configured</Status><Status>Operationally Verified: Pending Verification</Status></div>
    <p className="mb-3 text-xs text-muted-foreground">Collections count only verified events by verification date. Outstanding and pending are current positions as of {fmtDate(SAMPLE_TODAY)}. Figures reconcile with Payments, Invoices, Collections and Reports (This Month).</p>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{metrics.map(([a, b, c]) => <Metric key={a} label={a} value={b} delta="SAMPLE DATA" to={c} />)}</div>
    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Section title="Branch comparison" subtitle={basis}>
        <PrototypeTable headers={["Branch", "Net verified", "Outstanding", "Paid admissions"]} rows={branchesShown.map((b) => { const x = calc(b); return [b, inr(x.net), inr(x.outstanding), x.paidAdm]; })} />
      </Section>
      <Section title="Exact pipeline (current stage counts)" subtitle="All opportunities in scope"><div className="space-y-2 text-sm">{stages.map((st) => <div className="flex justify-between border-b pb-1" key={st}><span>{st}</span><b>{leads.filter((l) => l.stage === st).length}</b></div>)}</div></Section>
      <Section title={manager ? "Work queue" : "Top courses by net verified"} subtitle={basis}>
        {manager ? <div className="space-y-2 text-sm">{[["Open tasks", tasks.filter((t) => ["Open", "In Progress", "Waiting/Blocked"].includes(t.status)).length], ["Overdue (derived)", overdue], ["Unassigned / needs cover", unassigned], ["Corrections awaiting approval", pendingCorr]].map((x) => <div className="flex justify-between border-b pb-1" key={String(x[0])}><span>{x[0]}</span><b>{x[1]}</b></div>)}</div>
          : <div className="space-y-2 text-sm">{[...new Set(branchRows(data.invoices, branch).map((i) => i.course))].map((c) => { const ids = branchRows(data.invoices, branch).filter((i) => i.course === c).map((i) => i.id); const v = data.payments.filter((p) => ids.includes(p.invoiceId) && paymentStatus(data, p.id) === "Verified" && inRange(verifiedAt(data, p.id), range)).reduce((x, p) => x + p.amount, 0); return [c, v] as const; }).sort((x, y) => y[1] - x[1]).map(([c, v]) => <div className="flex justify-between border-b pb-1" key={c}><span>{c}</span><b>{inr(v)}</b></div>)}</div>}
      </Section>
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Section title="October 2026 targets (Target Master)" subtitle="Compared only with October 2026 verified results · period not yet started on the sample date">
        <PrototypeTable headers={["Scope", "Oct revenue target", "Oct paid admissions target", "Oct verified to date", "Oct paid admissions", "Achievement"]} rows={[...oct.map((x) => [x.b === "Guntur" ? "Guntur · NIT-GNT" : "Vijayawada · NIT-VIJ", "₹8L", "35", inr(x.octNet), x.octAdm, "Not started — period begins 01 Oct 2026"]), ...(branch === "All Branches" ? [["Company", "₹16L", "70", inr(oct.reduce((a, x) => a + x.octNet, 0)), oct.reduce((a, x) => a + x.octAdm, 0), "Not started — period begins 01 Oct 2026"]] : [])]} />
        <p className="mt-2 text-xs text-muted-foreground">September figures above are never compared with October targets.</p>
      </Section>
      <AiNote title="AI Management Brief" actions={false}>{`Recorded sample facts (${basis}, ${branch}): net verified ${inr(m.net)}, ${inr(m.pending)} awaiting verification (not counted), ${overdue} overdue tasks. Human review required.`}</AiNote>
    </div>
  </>;
}
export function Pipeline() {
  const [kanban, setKanban] = useState(true);
  const { branch } = useCrmScope();
  const { leads } = useCrmData();
  const scoped = branchRows(leads, branch);
  const stages = [
    "New Enquiry",
    "Counselling",
    "Demo Scheduled",
    "Demo Attended",
    "Fee Discussion / Payment Awaited",
    "Payment Pending Verification",
    "Admitted",
    "Lost - closed",
  ];
  return (
    <>
      <PageHead
        title="Pipeline"
        description={`Sample opportunity flow · ${branch}`}
        actions={
          <div className="flex rounded-md border p-1">
            <Button
              size="sm"
              variant={kanban ? "secondary" : "ghost"}
              onClick={() => setKanban(true)}
            >
              <Columns3 />
              Kanban
            </Button>
            <Button
              size="sm"
              variant={!kanban ? "secondary" : "ghost"}
              onClick={() => setKanban(false)}
            >
              <List />
              Table
            </Button>
          </div>
        }
      />
      {kanban ? (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {stages.map((s) => (
            <div className="w-64 shrink-0" key={s}>
              <div className="mb-2 flex justify-between text-xs font-semibold">
                <span>{s}</span>
                <span>{scoped.filter((l) => l.stage === s).length}</span>
              </div>
              <div className="min-h-52 rounded-md bg-muted p-2">
                {scoped
                  .filter((l) => l.stage === s)
                  .map((l) => (
                    <Link
                      to="/leads/$leadId"
                      params={{ leadId: l.id }}
                      key={l.id}
                      className="mb-2 block rounded-md border bg-card p-3"
                    >
                      <b className="text-sm">{l.name}</b>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {l.course} · {l.branch}
                      </p>
                      <div className="mt-2 flex justify-between">
                        <Status>{l.priority}</Status>
                        <span className="text-xs">{l.age}</span>
                      </div>
                    </Link>
                  ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          <PrototypeTable
            headers={[
              "Name",
              "Phone",
              "Course",
              "Branch",
              "Source",
              "Assigned",
              "Stage",
              "Follow-up",
              "Age",
              "AI",
              "Actions",
            ]}
            rows={leadTableRows(scoped)}
          />
        </div>
      )}
      <Warning>
        Dragging is simulated. Fee Shared and Token Paid — Verified remain milestones, not stages. Moving to Payment Pending Verification or Admitted opens validation
        when required fields are missing.
      </Warning>
    </>
  );
}
export function FeeQuote() {
  return <>
    <PageHead title="Fee Discussion & Invoice" description="FD-26091 · Version 3 · Ananya Rao · SAMPLE DATA" actions={<Button variant="outline" onClick={()=>demoAction("View Discussion History")}>View History</Button>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Approved commercial discussion" subtitle="Default validity: 7 calendar days or offer expiry, whichever comes first" className="lg:col-span-2">
        {fields(["Course","Branch","Standard Fee","Approved Offer / Version","Extra Approved Concession","Final Payable Amount","Minimum Payable Floor","Payment Plan","Validity","Counsellor"])}
        <div className="mt-4 flex flex-wrap gap-2"><Status>Fee Shared · milestone</Status><Status>Invoice Issued · milestone</Status></div>
        <div className="mt-5 flex flex-wrap gap-2"><Button variant="outline" onClick={()=>demoAction("Save Discussion")}>Save Discussion</Button><Button asChild><Link to="/discount-approval">Request Special Closing</Link></Button><Button variant="secondary" onClick={()=>demoAction("Share Approved Fee")}>Share Approved Fee</Button><Button variant="outline" asChild><Link to="/invoices">Invoice Register</Link></Button></div>
      </Section>
      <Section title="Version history"><PrototypeTable headers={["Version","Final payable","Status"]} rows={[["v3 · Current","₹27,000","Approved"],["v2","₹28,000","Counteroffered"],["v1","₹30,000","Discussion saved"]]} /></Section>
    </div>
    <Warning>After the first verified payment, fee changes require Founder / CEO or Super Admin approval plus an Accounts correction. No self-approval.</Warning>
  </>;
}
export function DiscountApproval() {
  return <>
    <PageHead title="Special Closing Request" description="SCR-26091 · 5 staffed-minute decision target · SAMPLE DATA" />
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Commercial terms and authority" className="lg:col-span-2">
        <PrototypeTable headers={["Standard fee","Active offer","Requested extra","Final payable","Floor","Delegation check"]} rows={[["₹30,000","No general campaign active","₹1,000","₹27,000","₹21,000 · 70%","BM limit: lower of 5% or ₹1,000"]]} />
        <div className="mt-4 grid gap-3 sm:grid-cols-3"><Warning>4 staffed min: warn approver</Warning><Warning>5 staffed min: escalate</Warning><Warning>Timeout never approves</Warning></div>
      </Section>
      <div className="space-y-3"><AiNote title="Human Review Required" actions={false}>Floor and delegation checks are advisory. Below-floor exceptions require Founder / CEO or Super Admin plus independent approval.</AiNote><ConfirmAction title="Approve special closing?" description="Approval identity and reason are added to sample audit history. Self-approval is blocked." action="Approve" trigger={<Button className="w-full">Approve</Button>} /><Button className="w-full" variant="outline" onClick={()=>demoAction("Counteroffer")}>Counteroffer</Button><ConfirmAction destructive title="Reject special closing?" description="A reason is required." action="Reject" trigger={<Button className="w-full" variant="destructive">Reject</Button>} /></div>
    </div>
  </>;
}
export function Admission() {
  const [plan, setPlan] = useState(false); const [payment, setPayment] = useState(false); const [done,setDone]=useState(false);
  return <>
    <PageHead title="Create Admission" description="Two mandatory prerequisites · SAMPLE DATA" />
    <Warning>Payment proof or an Unallocated Advance alone cannot create an Admission. One Person creates one Student Master / LMS identity.</Warning>
    <div className="mt-4 panel">{!done ? <>
      {fields(["Person","Branch","Course","Delivery Mode","Agreed Fee","Payment Plan","Admission Date","Counsellor"])}
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="flex items-start gap-3 rounded-md border p-4"><input type="checkbox" checked={plan} onChange={e=>setPlan(e.target.checked)} /><span><b>Accepted confirmed delivery plan</b><small className="block text-muted-foreground">Plan acceptance recorded; batch remains a distinct allocation.</small></span></label><label className="flex items-start gap-3 rounded-md border p-4"><input type="checkbox" checked={payment} onChange={e=>setPayment(e.target.checked)} /><span><b>First qualifying allocated payment Verified</b><small className="block text-muted-foreground">Accounts verification required.</small></span></label></div>
      <Button className="mt-4" disabled={!plan || !payment} onClick={()=>setDone(true)}><UserPlus/>Create Admission</Button>
    </> : <div className="py-6 text-center"><Check className="mx-auto size-10 text-success"/><h2 className="mt-3 text-xl font-semibold">Admission created in prototype</h2><div className="mx-auto mt-5 grid max-w-xl gap-3 sm:grid-cols-2">{[["Person ID","Selected Person (sample)"],["Admission ID","NIT-GNT-2026-000003 (simulated)"],["CRM Status","Admitted"],["Enrolment","Awaiting Batch Allocation"],["Final Fee","₹27,000 SAMPLE DATA"],["LMS Provisioning","Pending Verification"]].map(x=><div className="rounded-md border p-3" key={x[0]}><small>{x[0]}</small><div className="font-semibold">{x[1]}</div></div>)}</div><div className="mt-5"><FlowLink to="/students/$personId" params={{personId:"PER-GNT-00148"}} label="Open Student 360"/></div></div>}</div>
  </>;
}
export function Refunds() {
 const data = useCrmData(); const { branch } = useCrmScope();
 const adm = data.admissions.find((a) => a.id === "NIT-VIJ-2026-000002");
 const inv = adm ? data.invoices.find((i) => i.id === adm.invoiceId) : undefined;
 const sm = inv ? invoiceSummary(data, inv) : undefined;
 const hidden = branch === "Guntur";
 return <><PageHead title="Refund / Cancellation" description="Case NIT-RF-26019 · separate decisions and execution · SAMPLE DATA" />
 {hidden ? <Warning>NIT-RF-26019 belongs to Vijayawada. Branch-scoped UI simulation: switch scope if your role allows.</Warning> :
 <div className="grid gap-4 lg:grid-cols-3"><Section title="Registered case" subtitle="Cases remain registered even when evidence is incomplete" className="lg:col-span-2"><PrototypeTable headers={["Case","Admission","Request timing","Assessment","Evidence","Decision target","Payout target"]} rows={[["NIT-RF-26019","NIT-VIJ-2026-000002","Module 12 standard: within 3 calendar days","Assessment date recorded separately",<Status>Evidence Pending</Status>,"Normally 3–7 working days","Up to 18 working days after approval + verified payout details"]]}/>
 <h3 className="mb-2 mt-5 text-sm font-semibold">Linked immutable ledger · {inv ? <Link to="/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="text-primary">{inv.id}</Link> : "—"}</h3>
 {sm && sm.events.length ? <><PrototypeTable headers={["Receipt / event","Kind","Amount","Verification"]} rows={sm.events.map((p) => [p.id, p.kind + (p.linkedTo ? ` → ${p.linkedTo}` : ""), inr(p.amount), <Status>{paymentStatus(data, p.id)}</Status>])}/><p className="mt-2 text-sm">Verified paid {inr(sm.verified)} · Pending verification {inr(sm.pending)} (not counted) · Outstanding {inr(sm.outstanding)}. Any refund amount is assessed only against verified money.</p></> : <p className="text-sm text-muted-foreground">No ledger events.</p>}
 </Section><Section title="Decision separation"><div className="space-y-3 text-sm">{[["Operational cancellation","Branch Manager"],["Financial refund / waiver","Founder / CEO or Super Admin"],["Execution / reconciliation","Accounts"],["Payout state","Approved / Processing / Completed / Failed"]].map(x=><div className="rounded-md border p-3" key={x[0]}><b>{x[0]}</b><div>{x[1]}</div></div>)}</div><p className="mt-3 text-xs text-muted-foreground">Refund Completed only after payout execution and reconciliation. No blanket non-refundable wording or automatic class-percentage deduction.</p></Section></div>}</>;
}
export function Tasks() {
 const {branch}=useCrmScope(); const data=useCrmData(); const [tab,setTab]=useState("My Tasks");
 const fmtD=(d?:string)=>!d?"—":/^\d{4}-/.test(d)?fmtDateTime(d):d;
 const all=branchRows(data.tasks,branch).map(t=>({...t,condition:t.owner==="Unassigned"&&!["Completed","Cancelled"].includes(t.status)?`Unassigned · ${taskCondition(t)}`:taskCondition(t)}));
 const rows=tab==="My Tasks"?all.filter(x=>x.owner!=="Unassigned"&&!["Completed","Cancelled"].includes(x.status)):tab==="Team Tasks"?all:tab==="Overdue"?all.filter(x=>x.condition.includes("Overdue")):tab==="Unassigned / Needs Cover"?all.filter(x=>x.owner==="Unassigned"):all.filter(x=>x.status===tab);
 return <><PageHead title="Tasks" description={`${branch} · shared linked work queue · as of ${fmtDate(SAMPLE_TODAY)} 12:00 IST · SAMPLE DATA`} actions={<Button onClick={()=>demoAction("Create Task")}><Plus/>Create Task</Button>} /><div className="panel"><Tabs value={tab} onValueChange={setTab}><TabsList className="mb-4 h-auto max-w-full overflow-x-auto">{["My Tasks","Team Tasks","Open","In Progress","Waiting/Blocked","Completed","Cancelled","Overdue","Unassigned / Needs Cover"].map(t=><TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}</TabsList><TabsContent value={tab}>{rows.length?<PrototypeTable headers={["Task","Type","Title","Branch","Owner","Workflow status","Derived condition","Original deadline","Revised deadline","Linked record"]} rows={rows.map(x=>[x.id,x.type,x.title,x.branch,x.owner,<Status>{x.status}</Status>,x.condition,fmtD(x.original),fmtD(x.revised),x.record.startsWith("LD-")?<Link to="/leads/$leadId" params={{leadId:x.record}} className="text-primary">{x.record}</Link>:x.record])}/>:emptyState(tab)}</TabsContent></Tabs><p className="mt-3 text-xs text-muted-foreground">Workflow statuses only: Open · In Progress · Waiting/Blocked · Completed · Cancelled. Overdue is derived against the fixed sample clock; Unassigned is an assignment condition. Reassignment never changes Lead Owner or Admission.</p></div></>;
}
export function Communications() {
 const [tab,setTab]=useState("Awaiting Reply");
 return <><PageHead title="Communications" description="Unified V1 inbox · no automatic sync · SAMPLE DATA" />
 <div className="mb-4 flex flex-wrap gap-2"><Status>Guntur +91 9XXXX X7111 (masked sample) · Manual</Status><Status>Vijayawada +91 9XXXX X8639 (masked sample) · Manual</Status><Status>WhatsApp API: Planned / Pending Verification</Status><Status>Email: Pending Verification</Status><Status>Telephony: Planned / Pending Verification</Status></div>
 <div className="panel"><Tabs value={tab} onValueChange={setTab}><TabsList className="mb-4 h-auto max-w-full overflow-x-auto">{["Awaiting Reply","Failed Communications","Manual Activity","Match Review","Missed Calls","Call Tasks"].map(t=><TabsTrigger value={t} key={t}>{t}</TabsTrigger>)}</TabsList><TabsContent value={tab}><PrototypeTable headers={["Person / item","Channel","Branch","State","SLA","Action"]} rows={tab==="Awaiting Reply"?[["Ananya Rao","WhatsApp","Guntur",<Status>Awaiting Reply</Status>,"Active",<Button size="sm" onClick={()=>demoAction("Reply")}>Open</Button>]]:tab==="Failed Communications"?[["Karthik Reddy","Email","Vijayawada",<Status>Failed</Status>,"Still active",<Button size="sm" onClick={()=>demoAction("Retry")}>Retry</Button>]]:tab==="Match Review"?[["+91 9XXXX 11009","Missed call","Guntur",<Status>Review Required</Status>,"Not paused","Never auto-merge"]]:[["Sample activity",tab,"Guntur",<Status>Manual</Status>,"Active","Recorded manually"]]} /></TabsContent></Tabs></div>
 <Warning>Identity ambiguity never auto-merges and does not pause the lead SLA. Delivery, read, acknowledgement and action completion remain separate.</Warning></>;
}
export function AiCopilot({ ask = false }: { ask?: boolean }) {
  const [lang, setLang] = useState("English");
  return (
    <>
      <PageHead
        title={ask ? "Ask Nipuna" : "AI Copilot"}
        description={
          ask
            ? "Management analytics assistant · sample metrics with explicit scope"
            : "Advisory sales assistance · CRM facts remain distinct from AI inference"
        }
        actions={
          !ask && (
            <div className="flex rounded-md border p-1">
              <Button
                size="sm"
                variant={lang === "English" ? "secondary" : "ghost"}
                onClick={() => setLang("English")}
              >
                English
              </Button>
              <Button
                size="sm"
                variant={lang === "Telugu" ? "secondary" : "ghost"}
                onClick={() => setLang("Telugu")}
              >
                తెలుగు
              </Button>
            </div>
          )
        }
      />
      {ask ? (
        <AskContent />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="CRM facts" subtitle="Verified sample fields">
            <dl className="space-y-3 text-sm">
              {[
                ["Lead", "Ananya Rao"],
                ["Branch", "Guntur"],
                ["Course", "Data Science"],
                ["Last Contact", "23 Sep · outbound call"],
                ["Last Commitment", "Confirm weekend demo"],
                ["Fee Context", "Standard ₹30,000 · final assessment Not Yet Assessed"],
                ["Next Follow-Up", "Today · 4:30 PM"],
              ].map((x) => (
                <div className="flex justify-between gap-4" key={x[0]}>
                  <dt className="text-muted-foreground">{x[0]}</dt>
                  <dd className="text-right font-medium">{x[1]}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <div className="space-y-4">
             <AiNote title="AI Before-call Brief · evidence 24 Sep 2026">
              {lang === "Telugu"
                ? "వారాంతపు బ్యాచ్‌పై ఆసక్తి ఉంది. షెడ్యూల్‌ను నిర్ధారించి శనివారం డెమోను ప్రతిపాదించండి."
                : "Interested in a weekend batch. Confirm schedule and propose the Saturday demo before discussing discounts."}
            </AiNote>
             <AiNote title="Why Hot · AI Inference · Human Review Required">
               Two recorded replies, a demo acceptance, and recent sample activity support a score of
               92. Source: CRM activity snapshot dated 24 Sep 2026.
            </AiNote>
            <AiNote title="Suggested WhatsApp">
              Hi Ananya, the Saturday 4 PM Data Science demo is available at our Guntur branch.
              Shall I reserve your sample seat?
            </AiNote>
            <div className="flex flex-wrap gap-2">
              <Button>Create Follow-Up Task</Button>
              <Button variant="outline">Helpful</Button>
              <Button variant="outline" onClick={()=>demoAction("AI feedback: Incorrect")}>Incorrect</Button><Button variant="outline" onClick={()=>demoAction("AI feedback: Not Useful")}>Not Useful</Button><Button variant="outline" onClick={()=>demoAction("AI feedback: Missing Context")}>Missing Context</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
function AskContent() {
  const [q, setQ] = useState("Which courses have high enquiries but low admissions?");
  const { branch } = useCrmScope();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <div className="panel">
           <div className="flex min-w-0 gap-2">
            <Input className="min-w-0" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button>Ask</Button>
          </div>
           <div className="mt-3 flex min-w-0 flex-wrap gap-2">
            {[
              "Which courses have high enquiries but low admissions?",
              "Which counsellors have overdue follow-ups?",
              "What collections are at risk this week?",
              "Which admitted students have not started LMS activity?",
            ].map((x) => (
              <Button key={x} variant="outline" size="sm" className="h-auto max-w-full whitespace-normal text-left" onClick={() => setQ(x)}>
                {x}
              </Button>
            ))}
          </div>
        </div>
        <Section title="Sample answer">
          <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
            {[["Sources / Evidence","Synthetic CRM enquiries and payment-verification sample; supporting table below"],["Selected Period","01–24 Sep 2026 · SAMPLE DATA"],["Branch Scope",branch],["Report Cutoff","24 Sep 2026 · 20:00 IST (sample)"],["Data Freshness","Simulated snapshot · live freshness not verified"],["Missing Data / Warnings","Demo attendance and fee follow-up evidence incomplete; no live integrations"]].map(([label,value])=><div key={label} className="border-b pb-2"><dt className="font-semibold">{label}</dt><dd className="text-muted-foreground">{value}</dd></div>)}
          </dl>
          <p className="text-sm leading-6"><b>Recorded Fact · SAMPLE DATA:</b> The supporting sample table records enquiry and admission counts. <b>Possible Explanation:</b> Demo attendance or fee follow-up could affect conversion, but this is not established. <b>Missing Evidence:</b> Verified activity and source-system freshness are unavailable.</p>
        </Section>
        <Section title="Supporting table">
          <PrototypeTable
            headers={["Course", "Enquiries", "Admissions", "Conversion", "Branch signal"]}
            rows={(branch === "All Branches" ? [
              ["Power BI", "55", "10", "18%", "Guntur gap"],
              ["AWS with DevOps", "48", "7", "15%", "Vijayawada gap"],
              ["Data Science", "96", "25", "26%", "Balanced"],
            ] : branch === "Guntur" ? [["Power BI", "55", "10", "18%", "Guntur sample"]] : [["AWS with DevOps", "48", "7", "15%", "Vijayawada sample"]])}
          />
        </Section>
      </div>
      <AiNote title="AI Method Note" actions={false}>
        This answer uses synthetic CRM samples only. Figures are descriptive, not forecasts. No
        external service or production source was queried.
      </AiNote>
    </div>
  );
}
export function GenericOperational({ type }: { type: "students" | "manager" }) {
  if (type === "manager") return <Dashboard manager />;
  return <Students />;
}
function _LegacyStudents() {
  const { branch } = useCrmScope();
  const records = [
    {
      person: "PER-GNT-00148",
      name: "Ananya Rao",
      branch: "Guntur",
      admissions: "1",
      courses: "Data Science",
      paid: "₹20,000",
      outstanding: "₹12,000",
      lms: "Pending",
    },
    {
      person: "PER-VJA-00131",
      name: "Vamsi Krishna",
      branch: "Vijayawada",
      admissions: "2",
      courses: "Python Full Stack + AWS",
      paid: "₹92,000",
      outstanding: "₹31,000",
      lms: "Synced",
    },
  ];
  const scoped = branchRows(records, branch);
  return (
    <>
      <PageHead
        title="Students"
        description={`${branch} canonical sample people with one or more admissions and courses`}
      />
      <div className="panel">
        {scoped.length ? (
          <PrototypeTable
            headers={[
              "Person ID",
              "Student",
              "Branch",
              "Admissions",
              "Active Courses",
              "Paid",
              "Outstanding",
              "LMS",
            ]}
            rows={scoped.map((x) => [
              x.person,
              <Link
                to="/students/$personId"
                params={{ personId: x.person }}
                className="font-semibold text-primary"
              >
                {x.name}
              </Link>,
              x.branch,
              x.admissions,
              x.courses,
              `${x.paid} SAMPLE DATA`,
              `${x.outstanding} SAMPLE DATA`,
              <Status>{x.lms}</Status>,
            ])}
          />
        ) : (
          emptyState("students")
        )}
      </div>
    </>
  );
}

export function CourseMaster() {
  const rows=[["NIT-CRS-018","Data Science with Python, SQL, Machine Learning & Applied AI","Data & Analytics","₹30,000"],["NIT-CRS-047","Java Full Stack Developer","Software Development","₹25,000"],["NIT-CRS-052","Python Full Stack Developer","Software Development","₹24,000"],["NIT-CRS-007","AWS with DevOps","Cloud & DevOps","₹22,000"],["NIT-CRS-019","Microsoft Power BI Data Analytics & Business Intelligence","Data & Analytics","₹22,000"],["NIT-CRS-028","Complete Digital Marketing","Digital Marketing","₹25,000"],["NIT-CRS-025","Professional Graphic Design with AI Tools","Design & Media","₹18,000"],["NIT-CRS-026","Professional Video Editing with AI Tools","Design & Media","₹22,000"]];
  return <><PageHead title="Course Master" description="Approved course examples · both branches · representative rows displayed"/><div className="grid grid-cols-3 gap-3"><Metric label="Active records" value="72"/><Metric label="Standalone" value="63"/><Metric label="Combos" value="9"/></div><Section title="Representative approved records" subtitle="Same standard fee at NIT-GNT and NIT-VIJ" className="mt-4"><PrototypeTable headers={["Code","Course","Category","Standard fee","Branches","Status"]} rows={rows.map(x=>[...x,"NIT-GNT · NIT-VIJ",<Status>Active</Status>])}/></Section><Section title="Representative combo records" subtitle="4 of 9 approved combos · same package price at NIT-GNT and NIT-VIJ" className="mt-4"><PrototypeTable headers={["Code","Package name","Category","Approved package price","Branches","Status"]} rows={[["NIT-CMB-001","AI-Powered Java Full Stack Developer","3+1 Career Combo","₹25,000","NIT-GNT · NIT-VIJ",<Status>Active</Status>],["NIT-CMB-002","AI-Powered Python Full Stack Developer","3+1 Career Combo","₹25,000","NIT-GNT · NIT-VIJ",<Status>Active</Status>],["NIT-CMB-004","Career Restart Data Analyst","3+1 Career Combo","₹30,000","NIT-GNT · NIT-VIJ",<Status>Active</Status>],["NIT-CMB-009","Multi-Cloud DevOps Engineer","3+1 Career Combo","₹25,000","NIT-GNT · NIT-VIJ",<Status>Active</Status>]]}/></Section></>;
}
export function OfferMaster() { return <><PageHead title="Offer Master" description="Restricted prototype configuration · versioned and auditable"/><Warning>No general campaign active. Historical festival or 30%/35% campaigns are not active.</Warning><Section title="Campaign versions" className="mt-4"><PrototypeTable headers={["Version","Status","Branch / course scope","Dates","Benefit","Combination","Qualifying payment","Approver / audit"]} rows={[["OM-2026-DRAFT-01",<Status>Configured · Inactive</Status>,"Both branches · selected courses","Not active","One extra promo course by default","No stacking unless approved","First allocated payment Verified","Super Admin · audit pending"]]}/></Section><Section title="Complimentary eligibility" className="mt-4"><PrototypeTable headers={["Course","Threshold","Additional rule"]} rows={[["NIT-CRS-034 · Advanced Excel","Final agreed paid fee ≥ ₹15,000","Active Offer Master required"],["NIT-CRS-035 · Microsoft 365 & Office Productivity with AI Tools","Final agreed paid fee ≥ ₹20,000","Active Offer Master required"]]}/><p className="mt-3 text-xs">Threshold alone never grants access. Redemption/access period and course combination rules come from the active version.</p></Section></> }
export function TargetMaster() { return <><PageHead title="Target Master" description="Restricted approved target requirements · configuration and operational verification pending"/><Section title="Oct 2026 approved targets"><PrototypeTable headers={["Version","Scope","Verified Collections","Paid Admissions","Effective period","Requirement status","Configuration / verification"]} rows={[["TM-2026-10-v1","NIT-GNT","₹8,00,000","35","01–31 Oct 2026",<Status>Requirement Approved</Status>,"Pending Verification"],["TM-2026-10-v1","NIT-VIJ","₹8,00,000","35","01–31 Oct 2026",<Status>Requirement Approved</Status>,"Pending Verification"],["TM-2026-10-v1","Company","₹16,00,000","70","01–31 Oct 2026",<Status>Requirement Approved</Status>,"Pending Verification"]]}/><p className="mt-3 text-xs">Unconfigured measures display Not Set. Version history preserves prior effective periods and approver audit.</p></Section></> }
export function Notifications() { const [tab,setTab]=useState("My Notifications"); return <><PageHead title="Notification Centre" description="Delivery, read, acknowledgement and action completion are separate · SAMPLE DATA"/><div className="panel"><Tabs value={tab} onValueChange={setTab}><TabsList className="mb-4 h-auto max-w-full overflow-x-auto">{["My Notifications","Action Required","Escalations","Unread","System Issues","Completed"].map(t=><TabsTrigger value={t} key={t}>{t}</TabsTrigger>)}</TabsList><TabsContent value={tab}><PrototypeTable headers={["Event","Recipient","Delivery","Read","Acknowledged","Action completed","External WhatsApp / email","Threshold"]} rows={[["SCR-26091","Branch Manager",<Status>In-app sample</Status>,"Read (simulated)","Pending","No",<Status>Pending Verification</Status>,"Warn 4m · escalate 5m"],["GNT-R pending verification","Accounts",<Status>In-app sample</Status>,"Unread","No","No",<Status>Pending Verification</Status>,"Warn 25m · escalate 30m"]]}/></TabsContent></Tabs><p className="mt-3 text-xs">Deduplicated by event occurrence + linked record + recipient + purpose. No external delivery has been verified.</p></div></> }
export function PlacementAlumni() { const {branch}=useCrmScope(); return <><PageHead title="Placement & Alumni" description="Career assistance only — no guaranteed placement · SAMPLE DATA"/><div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3"><Metric label="Profiles ready" value="12"/><Metric label="Consent recorded" value="9"/><Metric label="Evidence pending" value="3"/></div><Section title="Placement Profile · sample summary"><dl className="grid gap-3 text-sm sm:grid-cols-2">{[["CV version","v2 · review pending"],["Skills / projects","Python, SQL · portfolio project (student reported)"],["Qualification","Graduate · student reported"],["Career gap / salary","Optional · Not supplied"],["Preferences","Guntur / hybrid · analyst role"],["Consent","Explicit referral consent recorded (sample)"],["Evidence state","Student Reported; verification Pending"]].map(([k,v])=><div key={k} className="border-b pb-2"><dt className="font-semibold">{k}</dt><dd>{v}</dd></div>)}</dl></Section><Section title="Job Opening Master" subtitle="Representative sample opening · external verification pending" className="mt-4"><PrototypeTable headers={["Job ID","Company","Job Title","Employment Type","Location / Mode","Required Skills","Salary / CTC","Source / Last Verification","Placement Owner","Status"]} rows={[["JOB-SAMPLE-001","Sample Employer A","Junior Data Analyst","Full-time",branch==="All Branches"?"Guntur · hybrid":"Local / hybrid","SQL, Power BI","Not Disclosed","Manual sample · Pending Verification","Placement Team",<Status>Review Required</Status>]]}/></Section><Section title="Placement profile and applications" className="mt-4"><PrototypeTable headers={["Student","Readiness","Job match","Consent","Application pipeline","Evidence"]} rows={[["Sample Learner A","Ready","Junior Data Analyst","Explicit consent recorded",<Status>Interview Scheduled</Status>,"Interview invite · sample only"],["Sample Learner B","Not Yet Assessed","—","Not recorded",<Status>Applied</Status>,"Pending Verification"]]}/><p className="mt-3 text-xs">Pipeline: Applied → Shortlisted → Interview Scheduled → Interview Attended → Selected → Offer Received → Offer Accepted → Joined. No-show is an interview event, not automatic closure.</p></Section><Section title="Alumni and support" className="mt-4"><p className="text-sm">Alumni begins after authorised completion of one standalone course or full combo. Alumni + Active may coexist. Standard support is 6 months after academic completion for new admissions; extensions require Founder / CEO or Super Admin.</p></Section></> }
export function AdminHub() { const sections=["Users & Access","Shift / SLA Configuration","Offer Master","Target Master","Finance Configuration","Communication Channels","Notification Rules","AI Configuration","Security / Sessions / Audit","Retention","Integration Status","Backup / Recovery Status","Incident Register"]; return <><PageHead title="Admin / Settings" description="Restricted prototype requirements and readiness · no production services connected"/><div className="mb-4 grid gap-3 sm:grid-cols-3"><Status>Requirement Approved</Status><Status>Configuration Partial / Pending</Status><Status>Operational Verification Pending</Status></div><div className="grid gap-4 lg:grid-cols-2">
 <Section title="Users & Access"><p className="text-sm leading-6">Staff Member 1 (sample) · Founder / CEO · all branches<br/>Staff Member 2 (sample) · Guntur Sales + Front Office<br/>Staff Member 3 (sample) · Vijayawada Branch Manager + Super Admin · all branches<br/>Staff Member 4 (sample) · Vijayawada Sales + Front Office<br/>Trainers deferred. Combined role+branch scopes never union into another role. recovery.admin@example.test is controlled emergency/recovery access only. MFA, temporary access expiry and real authentication: Pending Verification.</p></Section>
 <Section title="Security / Sessions / Audit"><p className="text-sm leading-6">Requirement Approved: 30-minute inactivity timeout; 12-hour maximum staff session; fresh authentication for sensitive actions; expiring temporary access; append-only audit; independent approval for sensitive deletion. Implementation/testing: Pending Verification.</p></Section>
 <Section title="Integration Status"><PrototypeTable headers={["Service","State","Verification"]} rows={[["WhatsApp branch numbers",<Status>Manual</Status>,"API Planned / Pending Verification"],["Branch email delivery",<Status>Pending Verification</Status>,"No successful test date"],["Telephony",<Status>Planned</Status>,"Pending Verification"],["HDFC",<Status>Planned</Status>,"Pending Verification"],["Scheduled report email",<Status>Configured</Status>,"Sending/delivery Pending Verification"]]}/></Section>
 <Section title="Incident Register"><PrototypeTable headers={["Incident","Severity","Owner","Status","Backup reference"]} rows={[["IR-REQUIREMENT-01","Not Set","Owner Pending",<Status>Requirement Approved</Status>,"Named incident backup Pending Verification"]]}/></Section>
 </div><Section title="Configuration areas" className="mt-4"><div className="flex flex-wrap gap-2">{sections.map(x=><Status key={x}>{x}</Status>)}</div><div className="mt-4 flex gap-2"><Button asChild><Link to="/offer-master">Offer Master</Link></Button><Button variant="outline" asChild><Link to="/target-master">Target Master</Link></Button></div></Section></> }
export function AccessDenied() {
  return (
    <div className="mx-auto max-w-lg py-24 text-center">
      <div className="text-5xl">⊘</div>
      <h1 className="mt-4 text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This sample role is not authorized for that action. Contact a Super Admin in the production
        system.
      </p>
      <Button className="mt-5" asChild>
        <Link to="/dashboard">Return to Dashboard</Link>
      </Button>
    </div>
  );
}
export function Login() {
  const nav = useNavigate();
  const { role, setRole, roles } = useCrmScope();
  return (
    <>
    <div className="prototype-strip">SAMPLE DATA — NO LIVE INTEGRATIONS</div>
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.15fr_.85fr]">
      <div className="hidden bg-sidebar p-12 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div>
          <div className="logo-mark">N</div>
          <h1 className="mt-10 max-w-xl text-4xl font-semibold leading-tight">
            Nipuna AI-Enabled CRM Prototype
          </h1>
          <p className="mt-4 max-w-lg text-sidebar-foreground/65">
            A sample-only view of the future connected learner journey across sales, admissions,
            collections and learning operations.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            "Branch-separated operations",
            "Human-controlled approvals",
            "Advisory AI insights",
            "End-to-end sample workflow",
          ].map((x) => (
            <div className="rounded-md border border-sidebar-border p-3" key={x}>
              <Check className="mb-2 size-4" />
              {x}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-center p-5">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <div className="logo-mark">N</div>
            <h1 className="mt-3 text-2xl font-semibold">Nipuna CRM</h1>
          </div>
          <div className="panel p-6 sm:p-8">
            <h2 className="text-xl font-semibold">Welcome back</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a demo role and enter the interactive prototype
            </p>
            <div className="mt-6 space-y-4">
              <div className="field">
                <Label>Prototype Role</Label>
                <Select value={role} onValueChange={(value) => setRole(value as PrototypeRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field">
                <Label>Email</Label>
                <Input defaultValue="sample.user@example.test" />
              </div>
              <div className="field">
                <Label>Password</Label>
                <Input type="password" defaultValue="sample-password" />
              </div>
              <Button className="w-full" onClick={() => nav({ to: roleHome(role) })}>
                Enter as {role}
              </Button>
            </div>
            <div className="mt-5 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs leading-5">
              NIPUNA CRM — INTERACTIVE PROTOTYPE — SAMPLE DATA. Roles are simulated; no credentials
              are verified and no production service is connected.
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
