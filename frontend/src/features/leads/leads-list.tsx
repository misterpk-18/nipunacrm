import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Filter, MessageCircle, Phone, Plus, Save, Search, Trash2, Upload, Users } from "lucide-react";
import { leadKeys, leadsApi, type LeadFilters, type LeadRow } from "@/api/leads";
import { LEAD_OWNER_ROLES, useLookups, useStaff } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CourseSelect, Field, LookupSelect, NativeSelect } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, LoadingRows, ErrorPanel, PageHead, Pagination, Status } from "@/components/crm/ui";
import { dateTime, isPast, maskPhone, relative } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { ImportDialog } from "./import-dialog";
import { NewLeadDialog } from "./new-lead-dialog";

export type LeadSearch = Omit<LeadFilters, "per_page" | "branch_id">;

const FILTER_KEYS: (keyof LeadSearch)[] = ["stage", "course_id", "source_id", "intake_status", "priority", "queue", "assigned_to"];

export function ContactButtons({ phone, prominent = false }: { phone: string; prominent?: boolean }) {
  const digits = phone.replace(/\D/g, "");
  return (
    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
      <Button size={prominent ? "sm" : "icon"} variant={prominent ? "default" : "ghost"} title="Call" asChild>
        <a href={`tel:+${digits}`}>
          <Phone />
          {prominent && "Call"}
        </a>
      </Button>
      <Button size={prominent ? "sm" : "icon"} variant="outline" title="WhatsApp" asChild>
        <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer">
          <MessageCircle />
          {prominent && "WhatsApp"}
        </a>
      </Button>
    </div>
  );
}

export function followUpLabel(lead: Pick<LeadRow, "next_follow_up_at">) {
  if (!lead.next_follow_up_at) return <span className="text-muted-foreground">Unscheduled</span>;
  return (
    <span className={isPast(lead.next_follow_up_at) ? "font-medium text-destructive" : undefined} title={dateTime(lead.next_follow_up_at)}>
      {dateTime(lead.next_follow_up_at)} <small className="block text-[11px] text-muted-foreground">{relative(lead.next_follow_up_at)}</small>
    </span>
  );
}

/** Leads register: search, filters (in the URL), saved views, bulk assign, create / import. */
export function LeadsList({ search, onSearch }: { search: LeadSearch; onSearch: (next: LeadSearch) => void }) {
  const branchId = useBranchFilter();
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const lookups = useLookups();
  const [text, setText] = useState(search.q ?? "");
  const [showFilters, setShowFilters] = useState(FILTER_KEYS.some((k) => search[k] !== undefined));
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkOwner, setBulkOwner] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [viewName, setViewName] = useState("");

  const filters: LeadFilters = { ...search, branch_id: branchId, per_page: 25 };
  const leads = useQuery({ queryKey: leadKeys.list(filters), queryFn: () => leadsApi.list(filters), placeholderData: (prev) => prev });
  const views = useQuery({ queryKey: leadKeys.savedViews, queryFn: leadsApi.savedViews });
  const rows = leads.data?.data;

  const selectedRows = (rows ?? []).filter((l) => selected.includes(l.lead_id));
  const selectedBranches = [...new Set(selectedRows.map((l) => l.branch.branch_id))];
  const owners = useStaff(selectedBranches[0], LEAD_OWNER_ROLES, selectedBranches.length === 1);
  const canAssign = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER");

  const bulkAssign = useApiMutation((v: { ids: number[]; owner: number }) => leadsApi.bulkAssign(v.ids, v.owner), {
    success: (r) => `Assigned ${r.length} lead(s)`,
    invalidate: [leadKeys.all],
    onSuccess: () => {
      setSelected([]);
      setBulkOwner("");
    },
  });
  const saveView = useApiMutation(leadsApi.createSavedView, { success: "View saved", invalidate: [leadKeys.savedViews], onSuccess: () => setViewName("") });
  const deleteView = useApiMutation(leadsApi.deleteSavedView, { success: "View deleted", invalidate: [leadKeys.savedViews] });

  const set = (patch: Partial<LeadSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof LeadSearch)[]) if (next[key] === "" || next[key] === undefined) delete next[key];
    onSearch(next);
  };
  const activeFilters = FILTER_KEYS.filter((k) => search[k] !== undefined).length;
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const currentView = views.data?.find((v) => JSON.stringify(v.filters) === JSON.stringify(Object.fromEntries(Object.entries(search).filter(([k]) => k !== "page"))));

  return (
    <>
      <PageHead
        title="Leads"
        description="Search, filter, assign and progress enquiries."
        actions={
          <>
            <Button onClick={() => setNewOpen(true)}>
              <Plus />
              New lead
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              Import CSV
            </Button>
          </>
        }
      />
      <div className="panel">
        <div className="mb-3 flex flex-wrap gap-2">
          <form
            className="relative min-w-0 flex-1 basis-56"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search name, phone, email or lead code — press Enter" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search leads" />
          </form>
          <Button variant={showFilters ? "secondary" : "outline"} onClick={() => setShowFilters((x) => !x)}>
            <Filter />
            Filters{activeFilters ? ` (${activeFilters})` : ""}
          </Button>
          <div className="w-48 min-w-0">
            <NativeSelect
              aria-label="Saved views"
              value={currentView?.saved_view_id ?? ""}
              placeholder="Saved views…"
              options={(views.data ?? []).map((v) => ({ value: v.saved_view_id, label: `${v.name}${v.shared ? "" : " (mine)"}` }))}
              onChange={(e) => {
                const view = views.data?.find((v) => v.saved_view_id === Number(e.target.value));
                if (view) {
                  const next = view.filters as LeadSearch;
                  setText(next.q ?? "");
                  onSearch(next);
                }
              }}
            />
          </div>
          {currentView && !currentView.shared && (
            <ConfirmAction
              trigger={
                <Button variant="ghost" size="icon" title="Delete saved view">
                  <Trash2 />
                </Button>
              }
              title={`Delete “${currentView.name}”?`}
              action="Delete"
              destructive
              onConfirm={() => deleteView.mutateAsync(currentView.saved_view_id)}
            />
          )}
        </div>
        {showFilters && (
          <div className="mb-3 grid gap-2 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Stage">
              <NativeSelect value={search.stage ?? ""} placeholder="Any" options={(lookups.data?.enums["lead_stages"] ?? []).map((s) => ({ value: s, label: s }))} onChange={(e) => set({ stage: e.target.value })} />
            </Field>
            <Field label="Course">
              <CourseSelect value={search.course_id ?? ""} placeholder="Any" onChange={(e) => set({ course_id: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="Original source">
              <LookupSelect lookup="lead_sources" value={search.source_id ?? ""} placeholder="Any" onChange={(e) => set({ source_id: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="Intake status">
              <NativeSelect value={search.intake_status ?? ""} placeholder="Any" options={(lookups.data?.enums["intake_statuses"] ?? []).map((s) => ({ value: s, label: s }))} onChange={(e) => set({ intake_status: e.target.value })} />
            </Field>
            <Field label="AI priority">
              <NativeSelect value={search.priority ?? ""} placeholder="Any" options={(lookups.data?.enums["lead_priorities"] ?? []).map((s) => ({ value: s, label: s }))} onChange={(e) => set({ priority: e.target.value })} />
            </Field>
            <Field label="Assigned">
              <NativeSelect
                value={search.assigned_to ?? ""}
                placeholder="Anyone"
                options={[
                  { value: "me", label: "Assigned to me" },
                  { value: "unassigned", label: "Unassigned" },
                ]}
                onChange={(e) => set({ assigned_to: e.target.value })}
              />
            </Field>
            <div className="flex items-end gap-2 sm:col-span-2">
              <Input placeholder="Save these filters as…" value={viewName} onChange={(e) => setViewName(e.target.value)} aria-label="Saved view name" />
              <Button
                variant="outline"
                disabled={!viewName.trim() || saveView.isPending}
                onClick={() => saveView.mutate({ name: viewName.trim(), filters: Object.fromEntries(Object.entries(search).filter(([k]) => k !== "page")) })}
              >
                <Save />
                Save view
              </Button>
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText("");
                  onSearch({});
                }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        )}
        {selected.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <Users className="size-4" />
            <b>{selected.length} selected</b>
            {!canAssign ? (
              <span className="text-muted-foreground">Bulk assign is available to branch managers and admins.</span>
            ) : selectedBranches.length > 1 ? (
              <span>Select leads from one branch only — owners are branch-scoped.</span>
            ) : (
              <>
                <div className="w-64 min-w-0">
                  <NativeSelect
                    aria-label="New owner"
                    value={bulkOwner}
                    placeholder="Choose owner…"
                    options={(owners.data ?? []).map((o) => ({ value: o.user_id, label: `${o.full_name} · ${o.roles.map((r) => r.role_name).join(", ")}` }))}
                    onChange={(e) => setBulkOwner(e.target.value)}
                  />
                </div>
                <Button size="sm" disabled={!bulkOwner || bulkAssign.isPending} onClick={() => bulkAssign.mutate({ ids: selected, owner: Number(bulkOwner) })}>
                  Assign
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          </div>
        )}
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={leads.isLoading}
            error={leads.error}
            onRetry={() => void leads.refetch()}
            rowKey={(l) => l.lead_id}
            onRowClick={(l) => void navigate({ to: "/leads/$leadId", params: { leadId: String(l.lead_id) } })}
            empty={<Empty title="No leads match">Try clearing the search or filters.</Empty>}
            columns={[
              {
                header: "",
                cell: (l) => (
                  <input
                    type="checkbox"
                    aria-label={`Select ${l.name}`}
                    checked={selected.includes(l.lead_id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(l.lead_id)}
                  />
                ),
              },
              {
                header: "Name",
                cell: (l) => (
                  <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {l.name}
                    <small className="block font-normal text-muted-foreground">{l.lead_code}</small>
                  </Link>
                ),
              },
              { header: "Phone", cell: (l) => maskPhone(l.phone) },
              { header: "Course", cell: (l) => <span className="block max-w-56 truncate">{l.course?.course_title ?? "—"}</span> },
              { header: "Branch", cell: (l) => l.branch.branch_name },
              { header: "Source", cell: (l) => l.original_source },
              { header: "Channel", cell: (l) => l.contact_channel },
              { header: "Intake", cell: (l) => <Status>{l.intake_status}</Status> },
              { header: "Owner", cell: (l) => l.owner?.full_name ?? <Status kind="warn">Unassigned</Status> },
              { header: "Stage", cell: (l) => <Status>{l.stage}</Status> },
              { header: "Next follow-up", cell: followUpLabel },
              { header: "AI priority", cell: (l) => (l.ai_priority ? <Status>{`${l.ai_priority}${l.ai_score !== null ? ` · ${l.ai_score}` : ""}`}</Status> : "—") },
              { header: "", cell: (l) => <ContactButtons phone={l.phone} /> },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {leads.isLoading ? (
            <LoadingRows />
          ) : leads.error ? (
            <ErrorPanel error={leads.error} onRetry={() => void leads.refetch()} />
          ) : rows?.length ? (
            rows.map((l) => (
              <div className="mobile-lead-card" key={l.lead_id}>
                <div className="flex items-start justify-between gap-3">
                  <label className="flex min-w-0 items-start gap-2">
                    <input type="checkbox" className="mt-1" aria-label={`Select ${l.name}`} checked={selected.includes(l.lead_id)} onChange={() => toggle(l.lead_id)} />
                    <span className="min-w-0">
                      <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="font-semibold text-primary">
                        {l.name}
                      </Link>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {l.course?.course_title ?? "No course"} · {l.stage}
                      </span>
                    </span>
                  </label>
                  {l.ai_priority && <Status>{l.ai_priority}</Status>}
                </div>
                <div className="my-3 space-y-1 text-xs">
                  <div>
                    {maskPhone(l.phone)} · {l.next_follow_up_at ? dateTime(l.next_follow_up_at) : "Unscheduled"}
                  </div>
                  <div className="break-words text-muted-foreground">
                    {l.branch.branch_name} · {l.owner?.full_name ?? "Unassigned"} · {l.original_source} · {l.intake_status}
                  </div>
                </div>
                <ContactButtons phone={l.phone} prominent />
              </div>
            ))
          ) : (
            <Empty title="No leads match" />
          )}
        </div>
        <Pagination meta={leads.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
      <NewLeadDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
