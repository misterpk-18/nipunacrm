/** Pieces shared by the WhatsApp screens: consent dialog, retry dialog, status chip. */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { canRetry, needsDeliveryCheck, problemOf, useMarketingTemplates, statusTone, whatsappApi, whatsappInvalidate, type ConsentStatus, type WhatsappMessage } from "@/api/whatsapp";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/crm/forms";
import { Status } from "@/components/crm/ui";
import { useApiMutation } from "@/lib/mutation";

/** Roles that may send a failed or skipped message again (mirrors the server). */
export function useCanRetry() {
  return useAuth().hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "ACCOUNTS");
}

/** Roles that may record or withdraw consent. */
export function useCanRecordConsent() {
  return useAuth().hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE");
}

/** The marketing catalogue, for template labels; Accounts may not read it, so they see readable template names instead. */
export function useTemplateCatalogue() {
  return useMarketingTemplates(useCanRecordConsent()).data;
}

export const StatusChip = ({ status }: { status: string }) => <Status kind={statusTone(status)}>{status}</Status>;

const SOURCE_HINT = "e.g. Counsellor call, Web form";

/** Record or withdraw a learner's WhatsApp marketing consent. */
export function ConsentDialog({ personId, mode, onClose }: { personId: number; mode: Extract<ConsentStatus, "Explicit Consent" | "Withdrawn">; onClose: () => void }) {
  const [source, setSource] = useState("");
  const withdraw = mode === "Withdrawn";
  const save = useApiMutation(() => whatsappApi.setConsent(personId, mode, source.trim() || undefined), {
    success: withdraw ? "Consent withdrawn" : "Consent recorded",
    invalidate: whatsappInvalidate(personId),
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{withdraw ? "Withdraw WhatsApp consent" : "Record WhatsApp consent"}</DialogTitle>
          <DialogDescription>
            {withdraw ? "Marketing templates will no longer be sent to this learner." : "Confirm the learner agreed to receive marketing messages on WhatsApp."}
          </DialogDescription>
        </DialogHeader>
        <form
          id="consent-form"
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <Field label={withdraw ? "Reason or source (optional)" : "Where did they agree? (optional)"} htmlFor="consent-source" hint={SOURCE_HINT}>
            <Input id="consent-source" maxLength={100} value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="consent-form" disabled={save.isPending} variant={withdraw ? "destructive" : "default"}>
            {withdraw ? "Withdraw" : "Record consent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Send a Failed / Skipped message again. When the provider's answer was lost, the user must confirm it was not delivered. */
export function RetryDialog({ message, onClose }: { message: WhatsappMessage; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsCheck = error !== null && needsDeliveryCheck(error);
  const retry = useMutation({
    mutationFn: () => whatsappApi.retry(message.outbox_id, needsCheck && confirmed),
    onSuccess: async () => {
      toast.success("Message queued to send again");
      await Promise.all(whatsappInvalidate(message.person_id ?? undefined).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const reason = problemOf(message);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send message again</DialogTitle>
          <DialogDescription>This puts the message back in the queue to send.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3">{message.body_text}</p>
          {reason && <p className="text-muted-foreground">{message.status}: {reason}</p>}
          {error && <p className="text-destructive" role="alert">{error}</p>}
          {needsCheck && (
            <label className="flex items-start gap-2">
              <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
              <span>I checked the learner's WhatsApp, it was not delivered</span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={retry.isPending || (needsCheck && !confirmed)} onClick={() => retry.mutate()}>
            {needsCheck ? "Send again" : "Retry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Retry button for one message; renders nothing when the role or status does not allow it. */
export function RetryButton({ message, onRetry }: { message: WhatsappMessage; onRetry: (m: WhatsappMessage) => void }) {
  const allowed = useCanRetry();
  if (!allowed || !canRetry(message)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={(e) => {
        e.stopPropagation();
        onRetry(message);
      }}
    >
      Retry
    </Button>
  );
}
