import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HandCoins } from "lucide-react";
import { AGE_BANDS, collectionKeys, collectionsApi, type DuePlan, type DuesFilters } from "@/api/collections";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, MiniBars, PageHead, Pagination, QueryView, Section, Status } from "@/components/crm/ui";
import { date, dateTime, money, sumMoney, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FINANCE_INVALIDATE, MoneyTiles } from "./shared";

export const COLLECTION_TABS = ["Due Today", "Overdue", "Upcoming", "All Plans", "Ageing"] as const;
export type CollectionSearch = { tab?: (typeof COLLECTION_TABS)[number]; plan_code?: string; age_band?: string; contact_hold?: boolean; page?: number };

/** Collections: coordinated dues per invoice, ageing bands and payment promises. */
export function CollectionsPage({ search, onSearch }: { search: CollectionSearch; onSearch: (next: CollectionSearch) => void }) {
  const branchId = useBranchFilter();
  const tab = search.tab ?? "Due Today";
  const [promisesFor, setPromisesFor] = useState<DuePlan | null>(null);
  const plans = useQuery({ queryKey: collectionKeys.plans, queryFn: collectionsApi.plans, staleTime: 10 * 60_000 });
  const position = tab === "Due Today" || tab === "Overdue" || tab === "Upcoming" ? tab : undefined;
  const filters: DuesFilters = {
    position,
    plan_code: search.plan_code,
    age_band: search.age_band,
    contact_hold: search.contact_hold,
    branch_id: branchId,
    page: search.page,
    per_page: 25,
  };
  const dues = useQuery({ queryKey: collectionKeys.dues(filters), queryFn: () => collectionsApi.dues(filters), enabled: tab !== "Ageing", placeholderData: (prev) => prev });
  const ageingFilters = { plan_code: search.plan_code, contact_hold: search.contact_hold, branch_id: branchId };
  const ageing = useQuery({ queryKey: collectionKeys.ageing(ageingFilters), queryFn: () => collectionsApi.ageing(ageingFilters) });
  const ageingRows = AGE_BANDS.map((band) => ({ band, ...(ageing.data?.[band] ?? { installments: 0, balance: 0 }) }));
  const overdueTotal = sumMoney(ageingRows.map((r) => String(r.balance)));
  const overdueCount = ageingRows.reduce((a, r) => a + r.installments, 0);

  const set = (patch: Partial<CollectionSearch>) => {
    const next = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof CollectionSearch)[]) if (next[key] === "" || next[key] === undefined) delete next[key];
    onSearch(next);
  };

  return (
    <>
      <PageHead title="Collections" description="One coordinated plan per invoice. No automatic late fee, admission cancellation or LMS block." />
      <MoneyTiles
        loading={ageing.isLoading}
        items={[
          ["Overdue balance", money(overdueTotal), `${overdueCount} overdue instalment(s)`],
          ["Overdue 31+ days", money(sumMoney(ageingRows.slice(4).map((r) => String(r.balance))))],
          ["Plans on this page", dues.data ? String(dues.data.meta.total) : "—", tab === "Ageing" ? "" : tab],
          ["Balance on this page", money(sumMoney((dues.data?.data ?? []).map((d) => d.balance)))],
        ]}
      />
      <div className="panel overflow-x-auto">
        <Tabs value={tab} onValueChange={(v) => set({ tab: v === "Due Today" ? undefined : (v as CollectionSearch["tab"]) })}>
          <TabsList className="mb-4 min-w-max">
            {COLLECTION_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <NativeSelect
            aria-label="Payment plan"
            value={search.plan_code ?? ""}
            placeholder="Any plan"
            options={(plans.data ?? []).map((p) => ({ value: p.plan_code, label: p.plan_name }))}
            onChange={(e) => set({ plan_code: e.target.value })}
          />
          {tab === "Overdue" && (
            <NativeSelect aria-label="Age band" value={search.age_band ?? ""} placeholder="Any age band" options={AGE_BANDS.map((b) => ({ value: b, label: `${b} days` }))} onChange={(e) => set({ age_band: e.target.value })} />
          )}
          <NativeSelect
            aria-label="Contact hold"
            value={search.contact_hold === undefined ? "" : String(search.contact_hold)}
            placeholder="Contact hold: any"
            options={[
              { value: "true", label: "On hold (payment pending verification)" },
              { value: "false", label: "Not on hold" },
            ]}
            onChange={(e) => set({ contact_hold: e.target.value === "" ? undefined : e.target.value === "true" })}
          />
        </div>
        {tab === "Ageing" ? (
          <QueryView query={ageing}>
            {() => (
              <div className="grid gap-4 lg:grid-cols-2">
                <DataTable
                  rows={ageingRows}
                  rowKey={(r) => r.band}
                  columns={[
                    { header: "Age band (days overdue)", cell: (r) => r.band },
                    { header: "Instalments", cell: (r) => r.installments, className: "text-right" },
                    { header: "Balance", cell: (r) => money(r.balance), className: "text-right" },
                  ]}
                />
                <MiniBars
                  items={ageingRows.map((r) => ({
                    name: `${r.band} days`,
                    value: Number(overdueTotal) ? Math.round((Number(r.balance) / Number(overdueTotal)) * 100) : 0,
                    label: money(r.balance),
                  }))}
                />
              </div>
            )}
          </QueryView>
        ) : (
          <>
            <DataTable
              rows={dues.data?.data}
              loading={dues.isLoading}
              error={dues.error}
              onRetry={() => void dues.refetch()}
              rowKey={(d) => d.invoice.invoice_id}
              empty={<Empty title={`No dues in ${tab}`}>Nothing to collect with these filters.</Empty>}
              columns={[
                { header: "Person", cell: (d) => <span className="font-medium">{d.person.full_name}</span> },
                {
                  header: "Invoice / admission",
                  cell: (d) => (
                    <Link to="/invoices/$invoiceId" params={{ invoiceId: String(d.invoice.invoice_id) }} className="text-primary">
                      {d.invoice.invoice_number}
                      <small className="block text-muted-foreground">
                        {d.courses.map((c) => c.course_title).join(", ")} · {d.admission_ids.length ? `${d.admission_ids.length} admitted` : "Pre-admission"}
                      </small>
                    </Link>
                  ),
                },
                { header: "Plan", cell: (d) => d.plan },
                {
                  header: "Instalments",
                  cell: (d) => (
                    <ul className="space-y-1 text-xs">
                      {d.installments.map((i) => (
                        <li key={i.installment_no} className="whitespace-nowrap">
                          #{i.installment_no} · {date(i.due_date)} · {money(i.balance)} · <Status>{i.due_position}</Status>
                          {i.age_band ? ` · ${i.age_band} days` : ""}
                        </li>
                      ))}
                    </ul>
                  ),
                },
                { header: "Balance", cell: (d) => money(d.balance), className: "text-right" },
                { header: "Next due", cell: (d) => date(d.next_due_date) },
                { header: "Days overdue", cell: (d) => d.max_days_overdue ?? "—" },
                { header: "Contact hold", cell: (d) => (d.contact_hold ? <Status kind="warn">Paused · pending verification</Status> : "None") },
                {
                  header: "Actions",
                  cell: (d) => (
                    <Button size="sm" variant="outline" onClick={() => setPromisesFor(d)} aria-label={`Promises for ${d.person.full_name}`}>
                      <HandCoins />
                      Promises
                    </Button>
                  ),
                },
              ]}
            />
            <Pagination meta={dues.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
          </>
        )}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Approved payment plans" subtitle="From the payment plan master">
          <QueryView query={plans} rows={3}>
            {(rows) => (
              <DataTable
                rows={rows.filter((p) => p.is_active)}
                rowKey={(p) => p.payment_plan_id}
                columns={[
                  { header: "Plan", cell: (p) => p.plan_name },
                  {
                    header: "Schedule",
                    cell: (p) => p.description ?? p.installments.map((i) => `${Number(i.percent_of_fee)}% day ${i.due_days_after_admission}`).join(" · "),
                  },
                ]}
              />
            )}
          </QueryView>
        </Section>
        <Section title="Reminder and escalation timeline">
          <p className="text-sm leading-6">
            Day −3 · due date · +3 reminder · +4 owner · +7 manager · at most one proactive follow-up per week through Day 30 · then a management plan. Instalments with a
            payment pending verification are on contact hold; their ageing stays visible.
          </p>
        </Section>
      </div>
      <PromisesDialog plan={promisesFor} onClose={() => setPromisesFor(null)} />
    </>
  );
}

function PromisesDialog({ plan, onClose }: { plan: DuePlan | null; onClose: () => void }) {
  const { hasRole } = useAuth();
  const canCollect = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE", "ACCOUNTS");
  const invoiceId = plan?.invoice.invoice_id ?? 0;
  const promises = useQuery({ queryKey: collectionKeys.promises(invoiceId), queryFn: () => collectionsApi.promises(invoiceId), enabled: invoiceId > 0 });
  const [amount, setAmount] = useState("");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const add = useApiMutation((v: { amount: string; date: string; notes: string }) => collectionsApi.addPromise(invoiceId, { promised_amount: v.amount, promised_date: v.date, notes: v.notes || null }), {
    success: (p) => `Promise of ${money(p.promised_amount)} on ${date(p.promised_date)} recorded`,
    invalidate: [collectionKeys.all, ["students"], ["admissions"]],
    onSuccess: () => {
      setAmount("");
      setWhen("");
      setNotes("");
    },
  });
  const resolve = useApiMutation((v: { id: number; status: "kept" | "broken" | "cancel" }) => collectionsApi.resolvePromise(v.id, v.status), {
    success: (p) => `Promise marked ${p.status}`,
    invalidate: [collectionKeys.all, ...FINANCE_INVALIDATE],
  });
  const pending = promises.data?.some((p) => p.status === "Pending");
  return (
    <Dialog open={plan !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Payment promises · {plan?.person.full_name}</DialogTitle>
          <DialogDescription>
            {plan?.invoice.invoice_number} · balance {money(plan?.balance)}. One pending promise at a time; mark it kept, broken or cancelled before adding another.
          </DialogDescription>
        </DialogHeader>
        <QueryView query={promises} empty={<Empty title="No promises yet" />} rows={2}>
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(p) => p.promise_id}
              columns={[
                { header: "Amount", cell: (p) => money(p.promised_amount), className: "text-right" },
                { header: "Promised date", cell: (p) => date(p.promised_date) },
                { header: "Status", cell: (p) => <Status>{p.status}</Status> },
                { header: "Notes", cell: (p) => p.notes ?? "—" },
                { header: "Recorded", cell: (p) => dateTime(p.recorded_at) },
                {
                  header: "Actions",
                  cell: (p) =>
                    p.status === "Pending" && canCollect ? (
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" onClick={() => resolve.mutate({ id: p.promise_id, status: "kept" })} disabled={resolve.isPending}>
                          Kept
                        </Button>
                        <ConfirmAction
                          trigger={
                            <Button size="sm" variant="outline">
                              Broken
                            </Button>
                          }
                          title="Mark this promise as broken?"
                          description="Recorded in the audit trail; follow-up escalates per the collections timeline."
                          action="Mark broken"
                          destructive
                          onConfirm={() => resolve.mutateAsync({ id: p.promise_id, status: "broken" })}
                        />
                        <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: p.promise_id, status: "cancel" })} disabled={resolve.isPending}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      p.resolved_at ? dateTime(p.resolved_at) : "—"
                    ),
                },
              ]}
            />
          )}
        </QueryView>
        {canCollect && !pending && (
          <form
            className="mt-2 grid gap-2 rounded-md border p-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate({ amount: amount.trim(), date: when, notes: notes.trim() });
            }}
          >
            <Field label="Promised amount (₹)" htmlFor="promise-amount">
              <Input id="promise-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="\d+(\.\d{1,2})?" />
            </Field>
            <Field label="Promised date" htmlFor="promise-date">
              <Input id="promise-date" type="date" min={todayIST()} value={when} onChange={(e) => setWhen(e.target.value)} required />
            </Field>
            <Field label="Notes" htmlFor="promise-notes" className="sm:col-span-2">
              <Textarea id="promise-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <DialogFooter className="sm:col-span-2">
              <Button type="submit" disabled={add.isPending}>
                Add promise
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
