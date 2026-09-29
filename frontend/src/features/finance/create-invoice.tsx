/** Create invoice from a deal (V4): issuer preview, bill-to, compatible courses, and the 1–3 instalment schedule. */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, MapPin, Plus, Trash2 } from "lucide-react";
import { dealKeys, dealsApi, presetSchedule } from "@/api/deals";
import { invoiceKeys } from "@/api/invoices";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ErrorPanel, LoadingRows } from "@/components/crm/ui";
import { money, sumMoney, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { cn } from "@/lib/utils";

type Row = { due_date: string; amount: string };

export function CreateInvoiceDialog({ leadId, onClose }: { leadId: number; onClose: () => void }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: dealKeys.invoiceOptions(leadId), queryFn: () => dealsApi.invoiceOptions(leadId) });
  const [picked, setPicked] = useState<number[]>([leadId]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const eligible = useMemo(() => (q.data?.courses ?? []).filter((c) => c.eligible), [q.data]);
  const total = sumMoney(eligible.filter((c) => picked.includes(c.lead.lead_id)).map((c) => c.amount));
  const schedule = rows ?? presetSchedule(total, 1, todayIST());
  const scheduled = sumMoney(schedule.map((r) => r.amount || "0"));

  // A different selection means a different total: restart the schedule as a full payment
  useEffect(() => setRows(null), [total]);

  const create = useApiMutation(
    () => dealsApi.createInvoice({ lead_ids: picked, installments: schedule.map((r) => ({ due_date: r.due_date, amount: r.amount })) }),
    {
      success: (r) => `Invoice ${r.invoice_number} created`,
      invalidate: [invoiceKeys.all, ["deals"], ["pipeline"], ["fee-discussions"], ["leads"]],
      onSuccess: (r) => {
        onClose();
        void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: String(r.invoice_id) } });
      },
    },
  );

  const preset = (count: 1 | 2 | 3) => setRows(presetSchedule(total, count, todayIST()));
  const update = (i: number, patch: Partial<Row>) => setRows(schedule.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const ok = picked.length > 0 && scheduled === total && schedule.every((r) => r.due_date && Number(r.amount) > 0);
  const issuer = q.data?.issuer;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create invoice from deal</DialogTitle>
          <DialogDescription>Review the billing branch, courses and payment schedule. No admission is created by invoicing.</DialogDescription>
        </DialogHeader>
        {q.isLoading && <LoadingRows rows={4} />}
        {q.error && <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && issuer && (
          <div className="grid gap-4">
            <div className="rounded-xl border p-4" style={{ borderColor: issuer.accent ?? undefined, background: `color-mix(in srgb, ${issuer.accent ?? "#6251DA"} 6%, white)` }}>
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0" style={{ color: issuer.accent ?? undefined }} />
                <div className="text-sm">
                  <div className="font-semibold">
                    {issuer.legal_name} · {issuer.branch_code}
                  </div>
                  <div className="whitespace-pre-line text-muted-foreground">{issuer.address ?? "Address not set — add it in Admin › Branches"}</div>
                  <div className="mt-1 text-xs" style={{ color: issuer.accent ?? undefined }}>
                    The issuing branch comes from the deal and is saved with the invoice.
                  </div>
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Bill to</div>
              <div className="font-semibold">{q.data.bill_to.full_name}</div>
              <div className="text-xs text-muted-foreground">
                {q.data.bill_to.person_code} {q.data.bill_to.phone ? `· ${q.data.bill_to.phone}` : ""}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium">Courses on this invoice</div>
              <div className="grid gap-2">
                {q.data.courses.map((c) => {
                  const on = picked.includes(c.lead.lead_id);
                  return (
                    <label key={c.lead.lead_id} className={cn("check-tile items-center", on && "check-tile-on", !c.eligible && "cursor-not-allowed opacity-70")}>
                      <Checkbox
                        aria-label={c.course?.course_title ?? c.lead.lead_code}
                        checked={on}
                        disabled={!c.eligible}
                        onCheckedChange={(v) => setPicked((prev) => (v === true ? [...prev, c.lead.lead_id] : prev.filter((x) => x !== c.lead.lead_id)))}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{c.course?.course_title ?? "No course"}</span>
                        <span className="block text-xs text-muted-foreground">
                          {c.lead.lead_code} · {c.eligible ? "Delivery plan accepted" : c.reasons.join(" · ")}
                        </span>
                      </span>
                      <span className="font-semibold">{money(c.amount)}</span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Only uninvoiced deals of this learner at {q.data.branch.branch_name} with an approved fee and an accepted delivery plan can be combined.
              </p>
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">Payment schedule (1–3 instalments)</span>
                <span className="flex gap-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => preset(1)}>
                    Full
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => preset(2)}>
                    50/50
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => preset(3)}>
                    50/25/25
                  </Button>
                </span>
              </div>
              <div className="grid gap-2">
                {schedule.map((r, i) => (
                  <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
                    <span className="w-6 text-xs text-muted-foreground">#{i + 1}</span>
                    <Input type="date" aria-label={`Instalment ${i + 1} due date`} min={todayIST()} value={r.due_date} onChange={(e) => update(i, { due_date: e.target.value })} />
                    <Input inputMode="decimal" aria-label={`Instalment ${i + 1} amount`} value={r.amount} onChange={(e) => update(i, { amount: e.target.value })} />
                    <Button type="button" size="icon" variant="ghost" aria-label="Remove instalment" disabled={schedule.length === 1} onClick={() => setRows(schedule.filter((_, n) => n !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              {schedule.length < 3 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-1"
                  onClick={() => setRows([...schedule, { due_date: schedule[schedule.length - 1]?.due_date ?? todayIST(), amount: "0.00" }])}
                >
                  <Plus />
                  Add instalment
                </Button>
              )}
              {scheduled !== total && (
                <p className="mt-1 text-xs text-destructive">
                  Instalments add up to {money(scheduled)} but the invoice total is {money(total)}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-sm text-muted-foreground">
                {picked.length} course{picked.length === 1 ? "" : "s"} · Invoice total
              </span>
              <span className="text-2xl font-bold">{money(total)}</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || create.isPending} onClick={() => create.mutate(undefined)}>
            <FileText />
            Create invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
