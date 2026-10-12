/** Record payment (V4 "Allocate actual payment"): one payer and invoice, money split across its course lines, one
 *  pending transaction per tender. Nothing counts until Accounts verifies; the receipt number comes then.
 *  RecordPaymentDialog opens it in place (Lead 360, invoice page) with the invoice preselected. */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign, Plus, Trash2 } from "lucide-react";
import { invoiceKeys, invoicesApi, useInvoice, type InvoiceLine } from "@/api/invoices";
import { paymentsApi, type Tender } from "@/api/payments";
import { useLookups } from "@/api/reference";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect, StaffSelect } from "@/components/crm/forms";
import { Empty, LoadingRows } from "@/components/crm/ui";
import { money, sumMoney, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FINANCE_INVALIDATE } from "./shared";

type TenderRow = { payment_mode_id: string; amount: string; reference: string; payment_date: string; exception_approved_by: string };
const blankTender = (): TenderRow => ({ payment_mode_id: "", amount: "", reference: "", payment_date: todayIST(), exception_approved_by: "" });

const paise = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const fromPaise = (p: number) => (p / 100).toFixed(2);

/** Spread an amount over the course lines token-first: every course not yet admitted gets what it still needs to reach
 *  its admission token (less claims already waiting for verification) first, then the rest goes oldest line first; never
 *  more than what is open on a course. Mirrors the API's default split. */
export function tokenFirstSplit(lines: InvoiceLine[], amount: string | number): Record<number, string> {
  let remaining = paise(amount);
  const gave: Record<number, number> = {};
  const room = (l: InvoiceLine) => Math.max(paise(l.open_to_allocate), 0);
  for (const l of lines) {
    if (l.admission_id !== null) continue;
    const need = Math.max(paise(l.more_to_admit) - paise(l.pending_verification), 0);
    const take = Math.min(need, room(l), remaining);
    gave[l.invoice_line_id] = take;
    remaining -= take;
  }
  for (const l of lines) {
    const take = Math.min(room(l) - (gave[l.invoice_line_id] ?? 0), remaining);
    gave[l.invoice_line_id] = (gave[l.invoice_line_id] ?? 0) + Math.max(take, 0);
    remaining -= Math.max(take, 0);
  }
  return Object.fromEntries(lines.map((l) => [l.invoice_line_id, fromPaise(gave[l.invoice_line_id] ?? 0)]));
}

/** "₹X more verified to admit <course>" — what is still needed after `allocating` is verified (null: nothing to say). */
export function admitHint(l: Pick<InvoiceLine, "admission_id" | "more_to_admit" | "course">, allocating = 0): string | null {
  if (l.admission_id !== null) return null;
  const left = Math.max(paise(l.more_to_admit) - Math.round(allocating * 100), 0);
  return left > 0 ? `${money(fromPaise(left))} more verified to admit ${l.course.course_title}` : null;
}

export function RecordPaymentDialog({ invoiceId, open, onOpenChange }: { invoiceId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>Nothing counts until Accounts verifies it; the receipt number comes then.</DialogDescription>
        </DialogHeader>
        {open && <RecordPaymentForm invoiceId={invoiceId} lockInvoice onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

export function RecordPaymentForm({ invoiceId: preset, onDone, lockInvoice = false }: { invoiceId?: number | undefined; onDone?: (invoiceId: number) => void; lockInvoice?: boolean }) {
  const branchId = useBranchFilter();
  const lookups = useLookups();
  const [search, setSearch] = useState("");
  const [invoiceId, setInvoiceId] = useState<number | undefined>(preset);
  const [split, setSplit] = useState(false);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [amount, setAmount] = useState("");
  const [tenders, setTenders] = useState<TenderRow[]>([blankTender()]);
  const [proof, setProof] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  useEffect(() => setInvoiceId(preset), [preset]);

  const candidates = useQuery({
    queryKey: invoiceKeys.list({ status: "Issued", outstanding: true, q: search, branch_id: branchId, per_page: 50 }),
    queryFn: () => invoicesApi.list({ status: "Issued", outstanding: true, q: search || undefined, branch_id: branchId, per_page: 50 }),
  });
  const invoice = useInvoice(invoiceId ?? 0);
  const inv = invoiceId ? invoice.data : undefined;
  const lines = useMemo(() => inv?.lines ?? [], [inv]);

  // New invoice (or changed balances): suggest the whole remaining amount, split token-first over the courses
  const linesKey = lines.map((l) => `${l.invoice_line_id}:${l.open_to_allocate}:${l.more_to_admit}`).join("|");
  useEffect(() => {
    const open = sumMoney(lines.map((l) => (Number(l.open_to_allocate) > 0 ? l.open_to_allocate : "0")));
    setAmount(open);
    setAlloc(tokenFirstSplit(lines, open));
    setTenders([blankTender()]);
    setSplit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);
  const changeAmount = (value: string) => {
    setAmount(value);
    setAlloc(tokenFirstSplit(lines, value));
  };
  const changeAlloc = (lineId: number, value: string) => {
    const next = { ...alloc, [lineId]: value };
    setAlloc(next);
    setAmount(sumMoney(Object.values(next)));
  };

  const allocated = sumMoney(Object.values(alloc));
  const tendered = sumMoney(split ? tenders.map((t) => t.amount) : [allocated]);
  const modes = lookups.data?.payment_modes ?? [];
  const rows = split ? tenders : [{ ...tenders[0]!, amount: allocated }];
  const modeOf = (t: TenderRow) => modes.find((m) => String(m.id) === t.payment_mode_id);
  const overLine = lines.find((l) => Number(alloc[l.invoice_line_id] ?? 0) > Number(l.open_to_allocate));
  const needsProof = rows.some((t) => t.payment_mode_id && modeOf(t)?.code !== "CASH");
  const openTotal = sumMoney(lines.map((l) => (Number(l.open_to_allocate) > 0 ? l.open_to_allocate : "0")));
  const ready =
    inv &&
    (!needsProof || proof) &&
    Number(allocated) > 0 &&
    !overLine &&
    tendered === allocated &&
    rows.every((t) => t.payment_mode_id && Number(t.amount) > 0 && (!modeOf(t)?.requires_reference || t.reference.trim()) && (!modeOf(t)?.requires_approval || t.exception_approved_by));

  const record = useApiMutation(
    () => {
      const body = {
        invoice_id: inv!.invoice_id,
        allocations: lines.filter((l) => Number(alloc[l.invoice_line_id]) > 0).map((l) => ({ invoice_line_id: l.invoice_line_id, amount: alloc[l.invoice_line_id]! })),
        tenders: rows.map(
          (t): Tender => ({
            amount: t.amount,
            payment_mode_id: Number(t.payment_mode_id),
            payment_date: t.payment_date || null,
            reference: t.reference.trim() || null,
            exception_approved_by: t.exception_approved_by ? Number(t.exception_approved_by) : null,
          }),
        ),
        notes: notes.trim() || null,
        split_excess: false,
      };
      return paymentsApi.record(body, proof);
    },
    {
      success: (r) => `${r.payments.map((p) => p.transaction_number).join(", ")} recorded · pending verification (no receipt yet)`,
      invalidate: [...FINANCE_INVALIDATE, ["pipeline"]],
      onSuccess: () => {
        const id = inv!.invoice_id;
        setProof(null);
        setNotes("");
        onDone?.(id);
      },
    },
  );
  const setTender = (i: number, patch: Partial<TenderRow>) => setTenders(tenders.map((t, n) => (n === i ? { ...t, ...patch } : t)));

  return (
    <div className="grid gap-4">
      {lockInvoice && inv && (
        <p className="text-sm">
          <b>{inv.invoice_number}</b> · {inv.person.full_name} · {inv.collecting_branch.branch_name}
        </p>
      )}
      <div className={lockInvoice ? "hidden" : "grid gap-3 sm:grid-cols-2"}>
        <Field label="Starting invoice / payer" htmlFor="rp-invoice">
          <NativeSelect
            id="rp-invoice"
            value={invoiceId ?? ""}
            placeholder={candidates.isLoading ? "Loading…" : "Select invoice…"}
            options={[
              ...(inv && !(candidates.data?.data ?? []).some((c) => c.invoice_id === inv.invoice_id)
                ? [{ value: inv.invoice_id, label: `${inv.invoice_number} · ${inv.person.full_name} · ${inv.collecting_branch.branch_name}` }]
                : []),
              ...(candidates.data?.data ?? []).map((i) => ({ value: i.invoice_id, label: `${i.invoice_number} · ${i.person.full_name} · ${i.collecting_branch.branch_name}` })),
            ]}
            onChange={(e) => setInvoiceId(e.target.value ? Number(e.target.value) : undefined)}
          />
        </Field>
        <Field label="Find invoice" htmlFor="rp-search">
          <Input id="rp-search" placeholder="Invoice number, name or course" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
      </div>
      {invoiceId && invoice.isLoading && <LoadingRows rows={3} />}
      {!invoiceId && <Empty title="Choose the invoice the money is for" />}
      {inv && (
        <>
          <Field
            label="Amount received (₹)"
            htmlFor="rp-amount"
            hint="Split over the courses token-first: each course not yet admitted gets its admission token first, then the rest oldest first. Change any course below."
            className="max-w-sm"
          >
            <Input id="rp-amount" inputMode="decimal" value={amount} onChange={(e) => changeAmount(e.target.value)} />
          </Field>
          {paise(amount) > paise(openTotal) && (
            <p className="text-xs text-destructive">
              {money(amount)} is more than the {money(openTotal)} outstanding on this invoice; only {money(openTotal)} can be recorded against it.
            </p>
          )}
          <div className="table-wrap">
            <table className="w-full text-left text-sm" aria-label="Allocate to courses">
              <thead>
                <tr>
                  <th>Invoice / course</th>
                  <th className="text-right">Charge</th>
                  <th className="text-right">Verified paid</th>
                  <th className="text-right">Remaining</th>
                  <th>Allocate now</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.invoice_line_id}>
                    <td className="min-w-40 max-w-64 whitespace-normal!">
                      <b>{l.course.course_title}</b>
                      <small className="block text-muted-foreground">
                        {inv.invoice_number} · {l.line_code}
                        {Number(l.pending_verification) > 0 ? ` · ${money(l.pending_verification)} pending` : ""}
                      </small>
                      {admitHint(l, Number(alloc[l.invoice_line_id] ?? 0)) && <small className="block font-medium text-primary">{admitHint(l, Number(alloc[l.invoice_line_id] ?? 0))}</small>}
                    </td>
                    <td className="text-right">{money(l.billed_amount)}</td>
                    <td className="text-right">{money(l.verified_paid)}</td>
                    <td className="text-right">{money(l.open_to_allocate)}</td>
                    <td className="w-32 min-w-28">
                      <Input
                        inputMode="decimal"
                        aria-label={`Allocate to ${l.course.course_title}`}
                        value={alloc[l.invoice_line_id] ?? ""}
                        onChange={(e) => changeAlloc(l.invoice_line_id, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {overLine && <p className="text-xs text-destructive">Only {money(overLine.open_to_allocate)} is left on {overLine.course.course_title}.</p>}
          <label className="check-tile max-w-xs">
            <Checkbox aria-label="Split payment" checked={split} onCheckedChange={(v) => setSplit(v === true)} />
            <span className="text-sm">Split payment (several tenders)</span>
          </label>
          <div className="rounded-xl border p-3">
            <div className="mb-2 flex justify-between text-sm font-semibold">
              <span>Tenders</span>
              <span>
                {money(tendered)} / {money(allocated)}
              </span>
            </div>
            <div className="grid gap-2">
              {rows.map((t, i) => {
                const mode = modeOf(t);
                return (
                  <div key={i} className="grid gap-2 sm:grid-cols-[1.2fr_0.8fr_1fr_0.8fr_auto]">
                    <NativeSelect
                      aria-label={`Tender ${i + 1} mode`}
                      placeholder="Payment mode…"
                      value={t.payment_mode_id}
                      options={modes.filter((m) => m.is_active).map((m) => ({ value: m.id, label: m.label }))}
                      onChange={(e) => setTender(i, { payment_mode_id: e.target.value })}
                    />
                    <Input
                      inputMode="decimal"
                      aria-label={`Tender ${i + 1} amount`}
                      placeholder="Amount"
                      value={t.amount}
                      disabled={!split}
                      onChange={(e) => setTender(i, { amount: e.target.value })}
                    />
                    <Input aria-label={`Tender ${i + 1} reference`} placeholder={mode?.requires_reference ? "Reference (required)" : "Reference"} value={t.reference} onChange={(e) => setTender(i, { reference: e.target.value })} />
                    <Input type="date" aria-label={`Tender ${i + 1} date`} max={todayIST()} value={t.payment_date} onChange={(e) => setTender(i, { payment_date: e.target.value })} />
                    {split ? (
                      <Button size="icon" variant="ghost" aria-label="Remove tender" disabled={tenders.length === 1} onClick={() => setTenders(tenders.filter((_, n) => n !== i))}>
                        <Trash2 />
                      </Button>
                    ) : (
                      <span />
                    )}
                    {mode?.requires_approval && (
                      <div className="sm:col-span-5">
                        <StaffSelect
                          aria-label={`Tender ${i + 1} exception approver`}
                          branchId={inv.collecting_branch.branch_id}
                          roles={["BRANCH_MANAGER", "FOUNDER_CEO", "SUPER_ADMIN"]}
                          placeholder={`${mode.label} needs an approver (not you)…`}
                          value={t.exception_approved_by}
                          onChange={(e) => setTender(i, { exception_approved_by: e.target.value })}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {split && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setTenders([...tenders, blankTender()])}>
                <Plus />
                Add tender
              </Button>
            )}
            {split && tendered !== allocated && <p className="mt-1 text-xs text-destructive">Tenders must add up to the allocated {money(allocated)}.</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={needsProof ? "Proof (required)" : "Proof (not needed for cash)"}
              htmlFor="rp-proof"
              hint={needsProof ? "Screenshot or PDF of the transfer / payment link receipt / cheque. Accounts reviews it before verifying." : "Only cash can be recorded without proof."}
            >
              <Input id="rp-proof" type="file" accept="image/*,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Notes" htmlFor="rp-notes">
              <Textarea id="rp-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <div>
            <Button disabled={!ready || record.isPending} onClick={() => record.mutate(undefined)}>
              <CircleDollarSign />
              Record payment
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Every tender becomes a separate Pending Verification transaction. A single tender gets one receipt after verification; split tenders get independent receipts.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
