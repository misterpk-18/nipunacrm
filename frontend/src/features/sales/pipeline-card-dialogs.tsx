import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { leadKeys } from "@/api/leads";
import { pipelineApi, pipelineKeys, type PipelineCard } from "@/api/pipeline";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, LookupSelect, StaffSelect, applyServerErrors } from "@/components/crm/forms";
import { fromLocalInput, toLocalInput, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

const invalidateCards = [pipelineKeys.all, leadKeys.all, ["persons"]];

function CardDialog(props: { title: string; description?: string; onClose: () => void; onSubmit: () => void; submitLabel: string; busy?: boolean; destructive?: boolean; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        <form
          id="card-dialog-form"
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmit();
          }}
        >
          {props.children}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" form="card-dialog-form" disabled={props.busy} variant={props.destructive ? "destructive" : "default"}>
            {props.submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const courseList = (card: PipelineCard) => card.courses.map((c) => c.course?.course_title ?? c.lead_code).join(", ");

/** Mark the whole card lost: every open course on it closes with this reason. */
export function CardLostDialog({ card, onClose }: { card: PipelineCard; onClose: () => void }) {
  const form = useForm({ defaultValues: { lost_reason_id: "", lost_competitor: "", lost_notes: "", reactivation_date: "" } });
  const lost = useApiMutation(
    (v: { lost_reason_id: string; lost_competitor: string; lost_notes: string; reactivation_date: string }) =>
      pipelineApi.moveStage(card.pipeline_entry_id, {
        stage: "Lost - closed",
        lost_reason_id: Number(v.lost_reason_id),
        lost_competitor: v.lost_competitor || null,
        lost_notes: v.lost_notes || null,
        reactivation_date: v.reactivation_date || null,
      }),
    { success: `${card.person.full_name} marked lost`, invalidate: invalidateCards, onSuccess: onClose, silentValidation: true, onError: (e) => applyServerErrors(form, e) },
  );
  return (
    <CardDialog
      title={`Mark ${card.person.full_name} lost`}
      description={`Closes every open course on this card: ${courseList(card) || "no courses"}.`}
      onClose={onClose}
      busy={lost.isPending}
      submitLabel="Mark lost"
      destructive
      onSubmit={form.handleSubmit((v) => lost.mutate(v))}
    >
      <Field label="Reason" error={form.formState.errors.lost_reason_id?.message}>
        <LookupSelect lookup="lost_reasons" aria-label="Lost reason" {...form.register("lost_reason_id", { required: "Choose a reason" })} />
      </Field>
      <Field label="Competitor (optional)">
        <Input {...form.register("lost_competitor")} />
      </Field>
      <Field label="Notes">
        <Textarea {...form.register("lost_notes")} />
      </Field>
      <Field label="Reactivation date (optional)" error={form.formState.errors.reactivation_date?.message}>
        <Input type="date" min={todayIST()} {...form.register("reactivation_date")} />
      </Field>
    </CardDialog>
  );
}

/** Card owner (branch managers / admins) and next follow-up; both are copied to the card's open courses. */
export function CardManageDialog({ card, onClose }: { card: PipelineCard; onClose: () => void }) {
  const { hasRole } = useAuth();
  const canAssign = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER");
  const [owner, setOwner] = useState(String(card.owner?.user_id ?? ""));
  const [next, setNext] = useState(toLocalInput(card.next_follow_up_at));
  const [close, setClose] = useState(card.expected_close_date ?? "");
  const body = () => {
    const out: { assigned_to?: number; next_follow_up_at?: string; expected_close_date?: string | null } = {};
    if (canAssign && owner && Number(owner) !== card.owner?.user_id) out.assigned_to = Number(owner);
    const at = fromLocalInput(next);
    if (at && next !== toLocalInput(card.next_follow_up_at)) out.next_follow_up_at = at;
    if (close !== (card.expected_close_date ?? "")) out.expected_close_date = close || null;
    return out;
  };
  const save = useApiMutation(() => pipelineApi.update(card.pipeline_entry_id, body()), { success: "Card updated", invalidate: invalidateCards, onSuccess: onClose });
  return (
    <CardDialog
      title={`${card.person.full_name} · ${card.entry_code}`}
      description="Owner and follow-up apply to every open course on the card; expected close is the card's own."
      onClose={onClose}
      busy={save.isPending || Object.keys(body()).length === 0}
      submitLabel="Save"
      onSubmit={() => save.mutate(undefined)}
    >
      <Field label="Owner">
        {canAssign ? (
          <StaffSelect aria-label="Card owner" branchId={card.branch.branch_id} value={owner} onChange={(e) => setOwner(e.target.value)} />
        ) : (
          <p className="text-sm">{card.owner?.full_name ?? "Unassigned"} · only a branch manager can change it</p>
        )}
      </Field>
      <Field label="Next follow-up">
        <Input type="datetime-local" aria-label="Next follow-up" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Expected close">
        <Input type="date" aria-label="Expected close" value={close} onChange={(e) => setClose(e.target.value)} />
      </Field>
    </CardDialog>
  );
}
