import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, UserCheck, UserPlus } from "lucide-react";
import { leadKeys, leadsApi, MANUAL_INTAKE, type NewLead, type Person } from "@/api/leads";
import { useLookups, type Lookups } from "@/api/reference";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, CourseSelect, Field, LookupSelect, NativeSelect, StaffSelect, applyServerErrors, useBranchCode } from "@/components/crm/forms";
import { Warning } from "@/components/crm/ui";
import { chipValue, useStaffedInTwoHours } from "@/features/leads/follow-up-chips";
import { dateTime, fromLocalInput } from "@/lib/format";
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

/** Fields that live under "More details" (an error there opens the section so it is never hidden). */
const MORE_FIELDS: (keyof Values)[] = [
  "alternate_phone", "email", "whatsapp_number", "city", "branch_id", "campaign", "contact_channel_id", "entry_method_id",
  "intake_status", "assigned_to", "next_follow_up_at", "remarks",
];

/** Last-used channel and entry method are remembered per user in this browser (never required to work). */
const rememberKey = (userId: number | undefined) => `nipuna.newLead.defaults.${userId ?? "anon"}`;
function readRemembered(userId: number | undefined): { contact_channel_id?: string; entry_method_id?: string } {
  try {
    return JSON.parse(localStorage.getItem(rememberKey(userId)) ?? "{}") as { contact_channel_id?: string; entry_method_id?: string };
  } catch {
    return {};
  }
}
function remember(userId: number | undefined, value: { contact_channel_id: string; entry_method_id: string }) {
  try {
    localStorage.setItem(rememberKey(userId), JSON.stringify(value));
  } catch {
    /* private window or blocked storage: the default is just the first value next time */
  }
}

/** The remembered value while it is still an active lookup value, else the first active one. */
function pickDefault(options: Lookups["contact_channels"] | undefined, remembered: string | undefined): string {
  const active = (options ?? []).filter((o) => o.is_active);
  if (remembered && active.some((o) => String(o.id) === remembered)) return remembered;
  return active[0] ? String(active[0].id) : "";
}

/** 10 digits, optionally with a leading 0 or 91 — the point at which the duplicate lookup runs. */
const isCompletePhone = (raw: string) => /^(0|91)?\d{10}$/.test(raw.replace(/\D/g, ""));

/**
 * Quick add: name, mobile, course and source; everything else is defaulted (shown under "More details").
 * Also "Add another course" for an existing person (person given, or picked from the duplicate-phone notice →
 * person fields locked). Duplicates are never merged: the phone check only offers to add a course to the person.
 */
export function NewLeadDialog({ open, onOpenChange, person: personProp, courseId, remarks }: { open: boolean; onOpenChange: (open: boolean) => void; person?: Person; courseId?: number; remarks?: string }) {
  const { branches, branchId, profile, isCounsellor } = useAuth();
  const userId = profile?.user.user_id;
  const navigate = useNavigate();
  const lookups = useLookups();
  const [linked, setLinked] = useState<Person | null>(null);
  const [more, setMore] = useState(false);
  const followTouched = useRef(false);
  const person = personProp ?? linked ?? undefined;
  const branchPreset = branchId ?? (branches.length === 1 ? branches[0]!.branch_id : null);
  const defaults = (): Values => ({
    full_name: personProp?.full_name ?? "",
    phone: personProp?.phone ?? "",
    alternate_phone: "",
    email: personProp?.email ?? "",
    whatsapp_same: true,
    whatsapp_number: "",
    city: personProp?.city ?? "",
    branch_id: branchPreset ? String(branchPreset) : "",
    course_id: courseId ? String(courseId) : "",
    lead_source_id: "",
    campaign: "",
    contact_channel_id: "",
    entry_method_id: "",
    intake_status: "New",
    assigned_to: isCounsellor && profile ? String(profile.user.user_id) : "",
    next_follow_up_at: "",
    remarks: remarks ?? "",
  });
  const form = useForm<Values>({ defaultValues: defaults() });
  const { register, handleSubmit, watch, formState, reset, setValue, getValues } = form;
  const selectedBranch = watch("branch_id");
  const branchCode = useBranchCode(selectedBranch);
  const phoneValue = watch("phone");

  useEffect(() => {
    if (open) {
      reset(defaults());
      setLinked(null);
      setMore(false);
      followTouched.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, personProp?.person_id]);

  // Smart defaults: last-used (or first) channel and entry method, follow-up in 2 staffed hours
  useEffect(() => {
    if (!open || !lookups.data) return;
    const remembered = readRemembered(userId);
    if (!getValues("contact_channel_id")) setValue("contact_channel_id", pickDefault(lookups.data.contact_channels, remembered.contact_channel_id));
    if (!getValues("entry_method_id")) setValue("entry_method_id", pickDefault(lookups.data.entry_methods, remembered.entry_method_id));
  }, [open, lookups.data, userId, getValues, setValue, selectedBranch]);

  const staffed = useStaffedInTwoHours(open && selectedBranch ? Number(selectedBranch) : undefined);
  useEffect(() => {
    if (!open || followTouched.current) return;
    setValue("next_follow_up_at", chipValue("in2h", staffed.data));
  }, [open, staffed.data, selectedBranch, setValue]);

  // Duplicate phone: as soon as 10 digits are typed (debounced) look the person up. Never merges anything.
  const [lookupPhone, setLookupPhone] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setLookupPhone(open && !person && isCompletePhone(phoneValue) ? phoneValue : ""), 400);
    return () => clearTimeout(timer);
  }, [open, person, phoneValue]);
  const lookup = useQuery({ queryKey: ["persons", "lookup", lookupPhone], queryFn: () => leadsApi.lookupPerson(lookupPhone), enabled: lookupPhone !== "", staleTime: 15_000 });
  const match = lookup.data?.matches[0];
  const useExisting = useApiMutation(leadsApi.getPerson, {
    onSuccess: (p) => {
      setLinked(p);
      setValue("full_name", p.full_name);
      setValue("phone", p.phone);
      setValue("email", p.email ?? "");
      setValue("city", p.city ?? "");
    },
  });

  const create = useApiMutation(leadsApi.create, {
    success: (lead) => `${lead.lead_code} created for ${lead.person.person_code}`,
    invalidate: [leadKeys.all, ["persons"], ["pipeline"]],
    silentValidation: true,
    onSuccess: (lead) => {
      remember(userId, { contact_channel_id: getValues("contact_channel_id"), entry_method_id: getValues("entry_method_id") });
      onOpenChange(false);
      void navigate({ to: "/leads/$leadId", params: { leadId: String(lead.lead_id) } });
    },
    onError: (error) => {
      applyServerErrors(form, error);
      setMore(true);
    },
  });

  const submit = handleSubmit(
    (v) => {
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
    },
    (errors) => {
      if (MORE_FIELDS.some((f) => errors[f])) setMore(true);
    },
  );

  const err = (name: keyof Values) => formState.errors[name]?.message;
  const required = { required: "Required" };
  const channel = lookups.data?.contact_channels.find((c) => String(c.id) === watch("contact_channel_id"))?.label;
  const entry = lookups.data?.entry_methods.find((c) => String(c.id) === watch("entry_method_id"))?.label;
  const branchName = branches.find((b) => String(b.branch_id) === selectedBranch)?.branch_name;
  const followUp = watch("next_follow_up_at");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{person ? `Add another course · ${person.full_name}` : "New lead"}</DialogTitle>
          <DialogDescription>
            {person ? `A new opportunity for ${person.person_code}. Person details stay as recorded.` : "Name, mobile, course and source are enough. Duplicates are never merged automatically."}
          </DialogDescription>
        </DialogHeader>
        <form id="new-lead-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" error={err("full_name")} htmlFor="nl-name">
            <Input id="nl-name" disabled={!!person} {...register("full_name", person ? {} : required)} />
          </Field>
          <Field label="Primary mobile" error={err("phone")} htmlFor="nl-phone">
            <Input id="nl-phone" inputMode="tel" disabled={!!person} {...register("phone", person ? {} : required)} placeholder="98765 43210" />
          </Field>
          {linked && !personProp && (
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2">
              <span className="flex items-center gap-1.5">
                <UserCheck className="size-4 text-primary" />
                Adding a course to {linked.full_name} · {linked.person_code}
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setLinked(null)}>
                Not this person
              </Button>
            </div>
          )}
          {!person && match && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm sm:col-span-2">
              <span>
                <span className="font-medium">
                  Already a person: {match.full_name} · {match.courses_count} {match.courses_count === 1 ? "course" : "courses"}
                </span>
                {match.courses.length > 0 && <span className="block text-xs text-muted-foreground">{match.courses.join(", ")}</span>}
                {(lookup.data?.matches.length ?? 0) > 1 && <span className="block text-xs text-muted-foreground">{lookup.data!.matches.length - 1} more with this number</span>}
              </span>
              <Button type="button" size="sm" disabled={useExisting.isPending} onClick={() => useExisting.mutate(match.person_id)}>
                Add course to this person
              </Button>
            </div>
          )}
          {!person && !match && lookup.data?.other_branch && (
            <div className="sm:col-span-2">
              <Warning>This number is already registered at another branch (details are not shown to you). You can still save; a manager can review possible duplicates.</Warning>
            </div>
          )}
          {!branchPreset && (
            <Field label="Branch" error={err("branch_id")} htmlFor="nl-branch-main">
              <BranchSelect id="nl-branch-main" {...register("branch_id", { ...required, onChange: () => setValue("assigned_to", "") })} />
            </Field>
          )}
          <Field label="Course" error={err("course_id")} htmlFor="nl-course">
            <CourseSelect id="nl-course" branchCode={branchCode} placeholder="Not decided yet" {...register("course_id")} />
          </Field>
          <Field label="Original source" error={err("lead_source_id")} htmlFor="nl-source">
            <LookupSelect id="nl-source" lookup="lead_sources" {...register("lead_source_id", required)} />
          </Field>

          <details className="rounded-md border px-3 py-2 text-sm sm:col-span-2" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-medium">
              <span>
                More details
                <span className="block text-xs font-normal text-muted-foreground">
                  {[branchName, channel, entry, followUp ? `follow-up ${dateTime(fromLocalInput(followUp))}` : null].filter(Boolean).join(" · ") || "Branch, owner, channel, follow-up, contact info"}
                </span>
              </span>
              <ChevronDown className="size-4 shrink-0" />
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
              {branchPreset && (
                <Field label="Branch" error={err("branch_id")} htmlFor="nl-branch">
                  <BranchSelect id="nl-branch" {...register("branch_id", { ...required, onChange: () => setValue("assigned_to", "") })} />
                </Field>
              )}
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
              <Field label="Next follow-up (IST)" error={err("next_follow_up_at")} hint="Defaults to 2 staffed hours from now" htmlFor="nl-follow">
                <Input
                  id="nl-follow"
                  type="datetime-local"
                  {...register("next_follow_up_at", {
                    onChange: () => {
                      followTouched.current = true;
                    },
                  })}
                />
              </Field>
              <Field label="Counsellor remarks" className="sm:col-span-2" htmlFor="nl-remarks">
                <Textarea id="nl-remarks" {...register("remarks")} />
              </Field>
            </div>
          </details>
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
