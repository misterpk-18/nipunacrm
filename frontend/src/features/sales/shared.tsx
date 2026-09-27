/** Small helpers shared by the sales screens (counsellor workspace, pipeline, demos, fees, approvals). */
import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RoleCode } from "@/api/types";

export const SALES_SIDE: RoleCode[] = ["FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE"];
export const MANAGERS: RoleCode[] = ["FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER"];

export function FormDialog({
  title,
  description,
  onClose,
  onSubmit,
  busy,
  submitLabel = "Save",
  destructive = false,
  disabled = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  busy?: boolean;
  submitLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={busy || disabled}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Drop undefined / empty-string keys so search params stay clean. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export const num = (v: unknown) => (v === undefined || v === "" || v === null || Number.isNaN(Number(v)) ? undefined : Number(v));
export const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
