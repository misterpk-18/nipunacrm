/** Small building blocks shared by the academics screens. */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLmsSyncStatus } from "@/api/lms";
import { Warning } from "@/components/crm/ui";
import { dateTime } from "@/lib/format";

/** A button that opens a small form dialog; `onSubmit` returns a promise, the dialog closes when it resolves. */
export function FormDialog({
  trigger,
  title,
  description,
  submitLabel = "Save",
  children,
  onSubmit,
  disabled,
  onOpen,
  wide,
}: {
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  submitLabel?: string;
  children: ReactNode;
  onSubmit: () => Promise<unknown> | unknown;
  disabled?: boolean;
  onOpen?: () => void;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit();
      setOpen(false);
    } catch {
      /* toast already shown by the mutation */
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span
        className="contents"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={wide ? "max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto" : "max-h-[90vh] overflow-y-auto"}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {children}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || disabled}>
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CheckResult({ ok, reason, owner }: { ok: boolean; reason: string; owner?: string | null }) {
  return (
    <div role="status" className={`rounded-md border p-3 text-sm ${ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"}`}>
      <b>{ok ? "Ready to allocate" : "Blocked"}</b> — {reason}
      {owner && <div className="mt-1 text-xs text-muted-foreground">Recovery / decision owner: {owner}</div>}
    </div>
  );
}

export const num = (v: unknown) => (v === undefined || v === "" || v === null || Number.isNaN(Number(v)) ? undefined : Number(v));
export const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
export const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

/** Shown where academic work moved to the Nipuna LMS (db 028): the rows here are the LMS's, mirrored by the status pull. */
export function LmsOwnedNote({ what }: { what: string }) {
  const status = useLmsSyncStatus();
  if (!(status.data?.academics_managed_in_lms ?? true)) return null;
  const synced = status.data?.pull.last_success_at;
  return (
    <Warning>
      {what} are managed in the Nipuna LMS and mirrored here read-only{synced ? ` · last synced ${dateTime(synced)}` : " · not synced yet"}.
    </Warning>
  );
}
