import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { personKeys, personsApi, type PersonFilters, type PersonRow } from "@/api/persons";
import { useBranchFilter } from "@/auth/auth";
import { Input } from "@/components/ui/input";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status } from "@/components/crm/ui";
import { date, maskPhone } from "@/lib/format";

export type PersonSearch = Omit<PersonFilters, "per_page" | "branch_id">;

function Where({ p }: { p: PersonRow }) {
  if (p.open_cards.length)
    return (
      <span className="flex flex-wrap gap-1">
        {p.open_cards.map((c) => (
          <Status key={c.pipeline_entry_id}>{`${c.stage} · ${c.branch.branch_code}`}</Status>
        ))}
      </span>
    );
  if (p.active_leads.length) return <Status kind="neutral">{`Lead · ${p.active_leads.length} new enquir${p.active_leads.length === 1 ? "y" : "ies"}`}</Status>;
  return <span className="text-muted-foreground">No open enquiry</span>;
}

/** Persons: everyone registered at, or enquiring at, the user's branches. Searches as you type (name, mobile, email, person ID). */
export function PersonsList({ search, onSearch }: { search: PersonSearch; onSearch: (s: PersonSearch) => void }) {
  const branchId = useBranchFilter();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const filters: PersonFilters = { ...search, branch_id: branchId, per_page: 25 };
  const persons = useQuery({ queryKey: personKeys.list(filters), queryFn: () => personsApi.list(filters), placeholderData: (p) => p });
  const rows = persons.data?.data;
  const open = (id: number) => void navigate({ to: "/persons/$personId", params: { personId: String(id) } });

  useEffect(() => {
    const q = text.trim() || undefined;
    if (q === search.q) return;
    const timer = setTimeout(() => onSearch(q ? { q } : {}), 300);
    return () => clearTimeout(timer);
  }, [text, search.q, onSearch]);

  return (
    <>
      <PageHead title="Persons" description="Everyone who has enquired or studied here — one record per person, with their leads, pipeline cards and admissions." />
      <div className="panel">
        <div className="relative mb-3">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search by name or mobile number" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search persons" />
        </div>
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={persons.isLoading}
            error={persons.error}
            onRetry={() => void persons.refetch()}
            rowKey={(p) => p.person_id}
            onRowClick={(p) => open(p.person_id)}
            empty={<Empty title="No persons match">Try part of the name or at least 4 digits of the mobile number.</Empty>}
            columns={[
              { header: "Person ID", cell: (p) => p.person_code },
              {
                header: "Name",
                cell: (p) => (
                  <Link to="/persons/$personId" params={{ personId: String(p.person_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                    {p.full_name}
                  </Link>
                ),
              },
              { header: "Mobile", cell: (p) => maskPhone(p.phone) },
              { header: "Email", cell: (p) => p.email ?? "—" },
              { header: "Registered at", cell: (p) => p.registered_branch.branch_name },
              { header: "Leads", cell: (p) => p.leads_count },
              { header: "Now", cell: (p) => <Where p={p} /> },
              { header: "Since", cell: (p) => date(p.created_at) },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {persons.isLoading ? (
            <LoadingRows />
          ) : persons.error ? (
            <ErrorPanel error={persons.error} onRetry={() => void persons.refetch()} />
          ) : rows?.length ? (
            rows.map((p) => (
              <Link key={p.person_id} to="/persons/$personId" params={{ personId: String(p.person_id) }} className="mobile-lead-card block">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-primary">{p.full_name}</span>
                  <small className="text-muted-foreground">{p.person_code}</small>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {maskPhone(p.phone)} · {p.registered_branch.branch_name} · {p.leads_count} lead(s)
                </div>
                <div className="mt-2 text-xs">
                  <Where p={p} />
                </div>
              </Link>
            ))
          ) : (
            <Empty title="No persons match" />
          )}
        </div>
        <Pagination meta={persons.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
    </>
  );
}
