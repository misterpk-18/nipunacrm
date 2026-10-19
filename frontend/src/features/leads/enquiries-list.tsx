import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { enquiriesApi, enquiryKeys, TRIAGE_STATUSES, type Enquiry, type EnquiryFilters } from "@/api/enquiries";
import { leadKeys } from "@/api/leads";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CourseSelect, Field, NativeSelect, StaffSelect } from "@/components/crm/forms";
import { DataTable, Empty, ErrorPanel, Facts, PageHead, Pagination, Status, Warning } from "@/components/crm/ui";
import { dateTime, maskPhone } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export type EnquirySearch = { tab?: string; q?: string; page?: number };

const TABS: { key: string; label: string; filters: EnquiryFilters }[] = [
  { key: "open", label: "Not converted", filters: { linked: false } },
  { key: "review", label: "Duplicate Review", filters: { intake_status: "Duplicate Review" } },
  { key: "linked", label: "Converted / linked", filters: { linked: true } },
  { key: "spam", label: "Invalid-Spam", filters: { intake_status: "Invalid-Spam" } },
  { key: "all", label: "All", filters: {} },
];

function statusKind(e: Enquiry) {
  if (e.lead_id) return "good" as const;
  if (e.intake_status === "Duplicate Review") return "warn" as const;
  if (e.intake_status === "Invalid-Spam" || e.intake_status === "Test") return "neutral" as const;
  return "info" as const;
}

/** Enquiries: everything that came in (website form, staff entries) before it becomes a lead. Staff convert, link or dismiss. */
export function EnquiriesList({ search, onSearch }: { search: EnquirySearch; onSearch: (s: EnquirySearch) => void }) {
  const branchId = useBranchFilter();
  const tab = TABS.find((t) => t.key === search.tab) ?? TABS[0];
  const [text, setText] = useState(search.q ?? "");
  const [openId, setOpenId] = useState<number | null>(null);
  const filters: EnquiryFilters = { ...tab.filters, q: search.q, page: search.page, branch_id: branchId, per_page: 25 };
  const enquiries = useQuery({ queryKey: enquiryKeys.list(filters), queryFn: () => enquiriesApi.list(filters), placeholderData: (p) => p });

  useEffect(() => {
    const q = text.trim() || undefined;
    if (q === search.q) return;
    const timer = setTimeout(() => onSearch({ tab: search.tab, q }), 300);
    return () => clearTimeout(timer);
  }, [text, search.q, search.tab, onSearch]);

  return (
    <>
      {openId !== null && <EnquiryDialog id={openId} onClose={() => setOpenId(null)} />}
      <PageHead
        title="Enquiries"
        description="Every enquiry as it came in, including the website form. Review each one: convert it to a lead, link it to an existing lead, or mark it as spam. Nothing is merged automatically."
      />
      <div className="panel">
        <Tabs value={tab.key} onValueChange={(t) => onSearch({ tab: t === "open" ? undefined : t, q: search.q })}>
          <TabsList className="mb-3 flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search by code, name, mobile or email" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search enquiries" />
        </div>
        {enquiries.error ? (
          <ErrorPanel error={enquiries.error} onRetry={() => void enquiries.refetch()} />
        ) : (
          <DataTable
            rows={enquiries.data?.data}
            loading={enquiries.isLoading}
            rowKey={(e) => e.enquiry_id}
            onRowClick={(e) => setOpenId(e.enquiry_id)}
            empty={<Empty title="No enquiries here" />}
            columns={[
              { header: "Enquiry", cell: (e) => <span className="font-semibold text-primary">{e.enquiry_code}</span> },
              { header: "Received", cell: (e) => dateTime(e.received_at) },
              { header: "Name", cell: (e) => e.raw_name ?? "—" },
              { header: "Mobile", cell: (e) => (e.raw_phone ? maskPhone(e.raw_phone) : "—") },
              { header: "Course", cell: (e) => e.course?.course_title ?? "—" },
              { header: "Branch", cell: (e) => e.branch.branch_code },
              { header: "Source", cell: (e) => `${e.source} · ${e.entry_method}` },
              { header: "Status", cell: (e) => <Status kind={statusKind(e)}>{e.lead_code ? `Lead ${e.lead_code}` : e.intake_status}</Status> },
            ]}
          />
        )}
        <Pagination meta={enquiries.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
    </>
  );
}

function EnquiryDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: enquiryKeys.detail(id), queryFn: () => enquiriesApi.get(id) });
  const e = detail.data;
  const persons = e?.matches.persons ?? [];
  const [personId, setPersonId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!e) return;
    setPersonId(e.matches.persons.length === 1 ? String(e.matches.persons[0].person_id) : "");
    setCourseId(e.course ? String(e.course.course_id) : "");
    setStatus(e.intake_status === "Duplicate Review" ? "" : e.intake_status);
  }, [e]);

  const invalidate = [enquiryKeys.all, leadKeys.all];
  const convert = useApiMutation(
    () => enquiriesApi.convert(id, { person_id: personId ? Number(personId) : null, course_id: courseId ? Number(courseId) : null, assigned_to: assignee ? Number(assignee) : null }),
    { success: (lead) => `Lead ${lead.lead_code} created`, invalidate, onSuccess: (lead) => void navigate({ to: "/leads/$leadId", params: { leadId: String(lead.lead_id) } }) },
  );
  const link = useApiMutation((leadId: number) => enquiriesApi.link(id, leadId), { success: "Linked to the existing lead", invalidate, onSuccess: onClose });
  const update = useApiMutation(() => enquiriesApi.update(id, { intake_status: status }), { success: "Enquiry updated", invalidate, onSuccess: onClose });

  const attribution = e?.attribution ? Object.entries(e.attribution).map(([k, v]) => `${k}: ${v}`).join(" · ") : null;
  const open = e && !e.lead_id;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{e ? `${e.enquiry_code} · ${e.raw_name ?? "No name"}` : "Enquiry"}</DialogTitle>
          <DialogDescription>{e ? `${e.source} · ${e.channel} · ${e.entry_method} · received ${dateTime(e.received_at)}` : "Loading…"}</DialogDescription>
        </DialogHeader>
        {detail.error && <ErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />}
        {e && (
          <div className="space-y-4">
            <Facts
              items={[
                ["Mobile", e.raw_phone],
                ["Email", e.raw_email],
                ["Branch", e.branch.branch_name],
                ["Course", e.course?.course_title],
                ["Status", <Status kind={statusKind(e)}>{e.lead_code ? `Lead ${e.lead_code}` : e.intake_status}</Status>],
                ["WhatsApp consent", e.whatsapp_consent === null ? "Not asked" : e.whatsapp_consent ? "Yes (website form)" : "No"],
              ]}
            />
            {e.message && <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{e.message}</p>}
            {attribution && <p className="text-xs text-muted-foreground">Tracking: {attribution}</p>}

            {e.lead_id ? (
              <p className="text-sm">
                Already part of{" "}
                <Link to="/leads/$leadId" params={{ leadId: String(e.lead_id) }} className="font-semibold text-primary">
                  {e.lead_code}
                </Link>
                .
              </p>
            ) : (
              <>
                {(persons.length > 0 || e.matches.enquiries.length > 0) && (
                  <Warning>
                    <div className="space-y-2 text-sm">
                      <b>Possible duplicates. Check before you convert.</b>
                      {persons.map((p) => (
                        <div key={p.person_id}>
                          Person{" "}
                          <Link to="/persons/$personId" params={{ personId: String(p.person_id) }} className="font-semibold text-primary">
                            {p.person_code} · {p.full_name}
                          </Link>{" "}
                          ({maskPhone(p.phone)}{p.email ? ` · ${p.email}` : ""})
                        </div>
                      ))}
                      {e.matches.open_leads.map((l) => (
                        <div key={l.lead_id} className="flex flex-wrap items-center gap-2">
                          Open lead {l.lead_code} · {l.course_code ?? "no course"} · {l.stage}
                          <Button size="sm" variant="outline" disabled={link.isPending} onClick={() => link.mutate(l.lead_id)}>
                            Link to {l.lead_code}
                          </Button>
                        </div>
                      ))}
                      {e.matches.enquiries.map((x) => (
                        <div key={x.enquiry_id}>
                          Other enquiry {x.enquiry_code} · {x.raw_name ?? "—"} · {x.branch.branch_code} · {x.intake_status} · {dateTime(x.received_at)}
                        </div>
                      ))}
                    </div>
                  </Warning>
                )}

                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Person" htmlFor="enq-person">
                    <NativeSelect
                      id="enq-person"
                      value={personId}
                      onChange={(ev) => setPersonId(ev.target.value)}
                      placeholder="New person (from this enquiry)"
                      options={persons.map((p) => ({ value: p.person_id, label: `${p.person_code} · ${p.full_name}` }))}
                    />
                  </Field>
                  <Field label="Course" htmlFor="enq-course">
                    <CourseSelect id="enq-course" branchCode={e.branch.branch_code} value={courseId} onChange={(ev) => setCourseId(ev.target.value)} placeholder="Not chosen" />
                  </Field>
                  <Field label="Assign to" htmlFor="enq-owner">
                    <StaffSelect id="enq-owner" branchId={e.branch.branch_id} value={assignee} onChange={(ev) => setAssignee(ev.target.value)} placeholder="Me / Branch Manager decides" />
                  </Field>
                </div>
                <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                  <Field label="Or set status" htmlFor="enq-status" className="min-w-48">
                    <NativeSelect id="enq-status" value={status} onChange={(ev) => setStatus(ev.target.value)} placeholder="Choose…" options={TRIAGE_STATUSES.map((s) => ({ value: s, label: s }))} />
                  </Field>
                  <Button variant="outline" disabled={!status || status === e.intake_status || update.isPending} onClick={() => update.mutate(undefined)}>
                    Save status
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {open && (
            <Button disabled={convert.isPending} onClick={() => convert.mutate(undefined)}>
              Convert to lead
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
