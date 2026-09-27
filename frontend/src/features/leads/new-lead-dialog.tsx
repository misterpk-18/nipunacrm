import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { UserPlus } from "lucide-react";
import { leadKeys, leadsApi, MANUAL_INTAKE, type NewLead, type Person } from "@/api/leads";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, CourseSelect, Field, LookupSelect, NativeSelect, StaffSelect, applyServerErrors, useBranchCode } from "@/components/crm/forms";
import { fromLocalInput } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

type Values = {
  full_name: string;
  phone: string;
  alternate_phone: string;
  email: string;
  whatsapp_same: boolean;
  whatsapp_number: string;
  city: string;
  branch_id: string;
  course_id: string;
  lead_source_id: string;
  campaign: string;
  contact_channel_id: string;
  entry_method_id: string;
  intake_status: string;
  assigned_to: string;
  next_follow_up_at: string;
  remarks: string;
};

/** New lead, or "Add another course" for an existing person (person given → person fields locked). */
export function NewLeadDialog({ open, onOpenChange, person }: { open: boolean; onOpenChange: (open: boolean) => void; person?: Person }) {
  const { branches, branchId, profile, isCounsellor } = useAuth();
  const navigate = useNavigate();
  const defaults = (): Values => ({
    full_name: person?.full_name ?? "",
    phone: person?.phone ?? "",
    alternate_phone: "",
    email: person?.email ?? "",
    whatsapp_same: true,
    whatsapp_number: "",
    city: person?.city ?? "",
    branch_id: String(branchId ?? (branches.length === 1 ? branches[0]!.branch_id : "")),
    course_id: "",
    lead_source_id: "",
    campaign: "",
    contact_channel_id: "",
    entry_method_id: "",
    intake_status: "New",
    assigned_to: isCounsellor && profile ? String(profile.user.user_id) : "",
    next_follow_up_at: "",
    remarks: "",
  });
  const form = useForm<Values>({ defaultValues: defaults() });
  const { register, handleSubmit, watch, formState, reset, setValue } = form;
  const selectedBranch = watch("branch_id");
  const branchCode = useBranchCode(selectedBranch);

  useEffect(() => {
    if (open) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, person?.person_id]);

  const create = useApiMutation(leadsApi.create, {
    success: (lead) => `${lead.lead_code} created for ${lead.person.person_code}`,
    invalidate: [leadKeys.all],
    silentValidation: true,
    onSuccess: (lead) => {
      onOpenChange(false);
      void navigate({ to: "/leads/$leadId", params: { leadId: String(lead.lead_id) } });
    },
    onError: (error) => applyServerErrors(form, error),
  });

  const submit = handleSubmit((v) => {
    const body: NewLead = {
      branch_id: Number(v.branch_id),
      course_id: v.course_id ? Number(v.course_id) : null,
      lead_source_id: Number(v.lead_source_id),
      contact_channel_id: Number(v.contact_channel_id),
      entry_method_id: Number(v.entry_method_id),
      intake_status: v.intake_status,
      assigned_to: v.assigned_to ? Number(v.assigned_to) : null,
      next_follow_up_at: fromLocalInput(v.next_follow_up_at),
      campaign: v.campaign || null,
      remarks: v.remarks || null,
    };
    if (person) body.person_id = person.person_id;
    else
      body.person = {
        full_name: v.full_name.trim(),
        phone: v.phone,
        alternate_phone: v.alternate_phone || null,
        whatsapp_number: v.whatsapp_same ? null : v.whatsapp_number || null,
        email: v.email || null,
        city: v.city || null,
      };
    create.mutate(body);
  });

  const err = (name: keyof Values) => formState.errors[name]?.message;
  const required = { required: "Required" };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{person ? `Add another course · ${person.full_name}` : "New lead"}</DialogTitle>
          <DialogDescription>
            {person ? `A new opportunity for ${person.person_code}. Person details stay as recorded.` : "Duplicates are never merged automatically — a matching phone goes to Duplicate Review."}
          </DialogDescription>
        </DialogHeader>
        <form id="new-lead-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" error={err("full_name")} htmlFor="nl-name">
            <Input id="nl-name" disabled={!!person} {...register("full_name", person ? {} : required)} />
          </Field>
          <Field label="Primary mobile" error={err("phone")} htmlFor="nl-phone">
            <Input id="nl-phone" inputMode="tel" disabled={!!person} {...register("phone", person ? {} : required)} placeholder="98765 43210" />
          </Field>
          {!person && (
            <>
              <Field label="Alternate mobile (optional)" error={err("alternate_phone")} htmlFor="nl-alt">
                <Input id="nl-alt" inputMode="tel" {...register("alternate_phone")} />
              </Field>
              <Field label="Email (optional)" error={err("email")} htmlFor="nl-email">
                <Input id="nl-email" type="email" {...register("email")} />
              </Field>
              <div className="field sm:col-span-2">
                <label className="flex items-center gap-2 text-sm font-normal text-foreground">
                  <input type="checkbox" {...register("whatsapp_same")} />
                  WhatsApp number same as primary mobile
                </label>
                {!watch("whatsapp_same") && <Input className="mt-2" inputMode="tel" aria-label="WhatsApp number" {...register("whatsapp_number")} />}
              </div>
              <Field label="City (optional)" htmlFor="nl-city">
                <Input id="nl-city" {...register("city")} />
              </Field>
            </>
          )}
          <Field label="Branch" error={err("branch_id")} htmlFor="nl-branch">
            <BranchSelect
              id="nl-branch"
              {...register("branch_id", { ...required, onChange: () => setValue("assigned_to", "") })}
            />
          </Field>
          <Field label="Course" error={err("course_id")} htmlFor="nl-course">
            <CourseSelect id="nl-course" branchCode={branchCode} placeholder="Not decided yet" {...register("course_id")} />
          </Field>
          <Field label="Original source" error={err("lead_source_id")} htmlFor="nl-source">
            <LookupSelect id="nl-source" lookup="lead_sources" {...register("lead_source_id", required)} />
          </Field>
          <Field label="Campaign / referral (optional)" htmlFor="nl-campaign">
            <Input id="nl-campaign" {...register("campaign")} />
          </Field>
          <Field label="Contact channel" error={err("contact_channel_id")} htmlFor="nl-channel">
            <LookupSelect id="nl-channel" lookup="contact_channels" {...register("contact_channel_id", required)} />
          </Field>
          <Field label="Entry method" error={err("entry_method_id")} htmlFor="nl-entry">
            <LookupSelect id="nl-entry" lookup="entry_methods" {...register("entry_method_id", required)} />
          </Field>
          <Field label="Intake status" error={err("intake_status")} htmlFor="nl-intake">
            <NativeSelect id="nl-intake" options={MANUAL_INTAKE.map((s) => ({ value: s, label: s }))} {...register("intake_status")} />
          </Field>
          <Field label="Lead owner" error={err("assigned_to")} hint="Sales → Front Office → manager cover" htmlFor="nl-owner">
            <StaffSelect id="nl-owner" branchId={selectedBranch ? Number(selectedBranch) : undefined} placeholder="Unassigned" {...register("assigned_to")} />
          </Field>
          <Field label="Next follow-up (IST)" error={err("next_follow_up_at")} htmlFor="nl-follow">
            <Input id="nl-follow" type="datetime-local" {...register("next_follow_up_at")} />
          </Field>
          <Field label="Counsellor remarks" className="sm:col-span-2" htmlFor="nl-remarks">
            <Textarea id="nl-remarks" {...register("remarks")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-lead-form" disabled={create.isPending}>
            <UserPlus />
            {person ? "Create opportunity" : "Save lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
