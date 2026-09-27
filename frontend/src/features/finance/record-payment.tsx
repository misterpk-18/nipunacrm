import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { invoiceKeys, invoicesApi, type InvoiceRow } from "@/api/invoices";
import { paymentsApi, type NewPayment } from "@/api/payments";
import { useLookups } from "@/api/reference";
import { useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, LookupSelect, NativeSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FINANCE_INVALIDATE } from "./shared";

type Values = {
  invoice_id: string;
  amount: string;
  payment_mode_id: string;
  payment_date: string;
  reference: string;
  exception_approved_by: string;
  notes: string;
  split_excess: boolean;
};

/** Record a payment against an issued invoice (JSON, or multipart with a proof file). */
export function RecordPaymentDialog({
  open,
  onOpenChange,
  invoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preset invoice (from the invoice page); otherwise the user searches for one. */
  invoice?: Pick<InvoiceRow, "invoice_id" | "invoice_number" | "outstanding" | "person" | "collecting_branch">;
}) {
  const branchId = useBranchFilter();
  const lookups = useLookups();
  const [search, setSearch] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const defaults = (): Values => ({
    invoice_id: invoice ? String(invoice.invoice_id) : "",
    amount: invoice && Number(invoice.outstanding) > 0 ? invoice.outstanding : "",
    payment_mode_id: "",
    payment_date: todayIST(),
    reference: "",
    exception_approved_by: "",
    notes: "",
    split_excess: true,
  });
  const form = useForm<Values>({ defaultValues: defaults() });
  const { register, handleSubmit, watch, reset, formState, setValue } = form;

  useEffect(() => {
    if (open) {
      reset(defaults());
      setProof(null);
      setSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice?.invoice_id]);

  const candidates = useQuery({
    queryKey: invoiceKeys.list({ status: "Issued", q: search, branch_id: branchId, per_page: 50 }),
    queryFn: () => invoicesApi.list({ status: "Issued", q: search || undefined, branch_id: branchId, per_page: 50 }),
    enabled: open && !invoice,
  });
  const open_invoices = (candidates.data?.data ?? []).filter((i) => Number(i.outstanding) > 0);

  const invoiceId = watch("invoice_id");
  const selected = invoice ?? open_invoices.find((i) => String(i.invoice_id) === invoiceId);
  const mode = lookups.data?.payment_modes.find((m) => String(m.id) === watch("payment_mode_id"));

  const record = useApiMutation((v: { body: NewPayment; proof: File | null }) => paymentsApi.record(v.body, v.proof), {
    success: (r) =>
      `${r.payment.receipt_number} recorded as ${r.payment.verification_status}${r.advance ? ` · excess ${money(r.advance.amount)} kept as advance ${r.advance.receipt_number}` : ""}`,
    invalidate: FINANCE_INVALIDATE,
    silentValidation: true,
    onSuccess: () => onOpenChange(false),
    onError: (error) => applyServerErrors(form, error),
  });

  const submit = handleSubmit((v) => {
    record.mutate({
      body: {
        invoice_id: Number(v.invoice_id),
        amount: v.amount.trim(),
        payment_mode_id: Number(v.payment_mode_id),
        payment_date: v.payment_date || null,
        reference: v.reference.trim() || null,
        exception_approved_by: v.exception_approved_by ? Number(v.exception_approved_by) : null,
        notes: v.notes.trim() || null,
        split_excess: v.split_excess,
      },
      proof,
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>New payments start as Pending Verification. Outstanding and verified totals change only after Accounts verifies.</DialogDescription>
        </DialogHeader>
        <form id="record-payment" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          {invoice ? (
            <div className="rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2">
              <b>{invoice.invoice_number}</b> · {invoice.person.full_name} · outstanding {money(invoice.outstanding)}
            </div>
          ) : (
            <>
              <Field label="Find invoice" htmlFor="rp-search" className="sm:col-span-2">
                <Input id="rp-search" placeholder="Invoice number, name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
              </Field>
              <Field label="Invoice" htmlFor="rp-invoice" error={formState.errors.invoice_id?.message} className="sm:col-span-2">
                <NativeSelect
                  id="rp-invoice"
                  placeholder={candidates.isLoading ? "Loading…" : open_invoices.length ? "Select invoice…" : "No open invoices match"}
                  options={open_invoices.map((i) => ({ value: i.invoice_id, label: `${i.invoice_number} · ${i.person.full_name} · outstanding ${money(i.outstanding)}` }))}
                  {...register("invoice_id", {
                    required: "Choose the invoice",
                    onChange: (e) => {
                      const inv = open_invoices.find((i) => String(i.invoice_id) === e.target.value);
                      if (inv) setValue("amount", inv.outstanding);
                    },
                  })}
                />
              </Field>
            </>
          )}
          <Field label="Amount (₹)" htmlFor="rp-amount" error={formState.errors.amount?.message}>
            <Input
              id="rp-amount"
              inputMode="decimal"
              {...register("amount", { required: "Enter the amount", pattern: { value: /^\d+(\.\d{1,2})?$/, message: "Rupees, up to 2 decimals" } })}
            />
          </Field>
          <Field label="Payment mode" htmlFor="rp-mode" error={formState.errors.payment_mode_id?.message}>
            <LookupSelect id="rp-mode" lookup="payment_modes" {...register("payment_mode_id", { required: "Choose the mode" })} />
          </Field>
          <Field label="Payment date" htmlFor="rp-date" error={formState.errors.payment_date?.message}>
            <Input id="rp-date" type="date" max={todayIST()} {...register("payment_date")} />
          </Field>
          <Field label={mode?.requires_reference ? "Reference (required)" : "Reference"} htmlFor="rp-ref" error={formState.errors.reference?.message}>
            <Input id="rp-ref" placeholder="UTR / transaction / cheque no." {...register("reference", { validate: (v) => !mode?.requires_reference || !!v.trim() || `${mode.label} needs a reference` })} />
          </Field>
          {mode?.requires_approval && (
            <Field label="Exception approved by" htmlFor="rp-approver" error={formState.errors.exception_approved_by?.message} className="sm:col-span-2" hint="A branch manager or admin other than you">
              <StaffSelect
                id="rp-approver"
                branchId={selected?.collecting_branch.branch_id}
                roles={["BRANCH_MANAGER", "FOUNDER_CEO", "SUPER_ADMIN"]}
                {...register("exception_approved_by", { required: `${mode.label} needs an approver` })}
              />
            </Field>
          )}
          <Field label="Proof (optional)" htmlFor="rp-proof" className="sm:col-span-2" hint="Screenshot or PDF of the transfer / receipt">
            <Input id="rp-proof" type="file" accept="image/*,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Notes" htmlFor="rp-notes" className="sm:col-span-2">
            <Textarea id="rp-notes" rows={2} {...register("notes")} />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-1" {...register("split_excess")} />
            <span>Keep any amount above the outstanding as an unallocated advance (otherwise the payment is refused)</span>
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="record-payment" disabled={record.isPending}>
            <CircleDollarSign />
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
