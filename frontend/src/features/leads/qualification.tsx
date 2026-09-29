/** V4 lead qualification: the six-check review, Mark Qualified, and Convert to deal (db 019). */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Info } from "lucide-react";
import { leadKeys, leadsApi, type ConvertBody, type Lead } from "@/api/leads";
import { useCourses } from "@/api/reference";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { BranchSelect, Field, StaffSelect, useBranchCode } from "@/components/crm/forms";
import { Section, Status, Warning } from "@/components/crm/ui";
import { FormDialog } from "@/features/sales/shared";
import { dateTime, money, todayIST } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { cn } from "@/lib/utils";

const refresh = (leadId: number) => [leadKeys.detail(leadId), leadKeys.qualification(leadId), leadKeys.activities(leadId), ["leads", "list"], ["pipeline"], ["persons"]];

export function useQualification(leadId: number) {
  return useQuery({ queryKey: leadKeys.qualification(leadId), queryFn: () => leadsApi.qualification(leadId) });
}

/** "A deal starts only after every check is reviewed." Ticks record who reviewed and when; qualifying never changes the stage. */
export function QualificationPanel({ lead }: { lead: Lead }) {
  const q = useQualification(lead.lead_id);
  const toggle = useApiMutation(({ check, reviewed }: { check: string; reviewed: boolean }) => leadsApi.setCheck(lead.lead_id, check, reviewed), {
    invalidate: [leadKeys.qualification(lead.lead_id)],
  });
  const qualify = useApiMutation(() => leadsApi.qualify(lead.lead_id), { success: "Marked qualified", invalidate: refresh(lead.lead_id) });
  if (!q.data) return null;
  const data = q.data;
  const frozen = data.qualified_at !== null || !lead.is_open;
  const done = data.checks.filter((c) => c.reviewed).length;

  return (
    <Section title="Qualification checklist" subtitle="A deal starts only after every check is reviewed">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {data.checks.map((c) => (
          <label
            key={c.check}
            className={cn("check-tile", c.reviewed && "check-tile-on", frozen && "cursor-default")}
            title={c.reviewed_by ? `Reviewed by ${c.reviewed_by.full_name} · ${dateTime(c.reviewed_at)}` : c.hint}
          >
            <Checkbox
              checked={c.reviewed || (data.complete && frozen)}
              disabled={frozen || toggle.isPending}
              onCheckedChange={(value) => toggle.mutate({ check: c.check, reviewed: value === true })}
              aria-label={c.check}
            />
            <span className="min-w-0">
              <span className="block text-sm leading-snug">{c.check}</span>
              <span className="block text-[11px] text-muted-foreground">
                {c.reviewed_by ? `${c.reviewed_by.full_name} · ${dateTime(c.reviewed_at)}` : c.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {data.qualified_at ? (
          <Status kind="good">Qualified {dateTime(data.qualified_at)}</Status>
        ) : (
          <Button size="sm" disabled={done < data.checks.length || qualify.isPending || !lead.is_open} onClick={() => qualify.mutate(undefined)}>
            <CheckCircle2 />
            Mark Qualified
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {data.qualified_at ? (data.converted_at ? `Converted ${dateTime(data.converted_at)}` : "Ready to convert to a deal") : `${done} of ${data.checks.length} reviewed`}
        </span>
      </div>
    </Section>
  );
}

/** Convert a qualified lead: reuse the person, pick the courses (own course always included), branch, owner and expected close. */
export function ConvertDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const navigate = useNavigate();
  const courses = useCourses();
  const person = useQuery({ queryKey: ["persons", "overview", lead.person.person_id], queryFn: () => leadsApi.getPerson(lead.person.person_id) });
  const openDeals = useQuery({
    queryKey: ["leads", "list", { person: lead.person.person_id, deals: true }],
    queryFn: () => leadsApi.list({ q: lead.person.phone.slice(-10), lead_status: "Inactive", per_page: 50 }),
  });
  const [branchId, setBranchId] = useState(lead.branch.branch_id);
  const branchCode = useBranchCode(branchId);
  const own = lead.course?.course_id;
  const [picked, setPicked] = useState<number[]>(own ? [own] : []);
  const [owner, setOwner] = useState<string>(lead.owner ? String(lead.owner.user_id) : "");
  const [close, setClose] = useState<string>("");

  const existing = (openDeals.data?.data ?? []).filter((d) => d.branch.branch_id === branchId && d.stage !== "Admitted" && d.stage !== "Lost - closed" && d.name === lead.name);
  const convert = useApiMutation((body: ConvertBody) => leadsApi.convert(lead.lead_id, body), {
    success: (r) => `Converted to deal · ${r.pipeline_entry.entry_code}`,
    invalidate: refresh(lead.lead_id),
    onSuccess: () => {
      onClose();
      void navigate({ to: "/leads/$leadId", params: { leadId: String(lead.lead_id) } });
    },
  });
  const options = (courses.data ?? []).filter((c) => !branchCode || c.branches.includes(branchCode));

  return (
    <FormDialog
      title={`Convert ${lead.lead_code} to Deal`}
      description={`Reuse person ${lead.person.person_code}. Each selected course becomes its own priced deal on the person's card. Conversion creates no student, admission, receipt or LMS access.`}
      onClose={onClose}
      submitLabel="Convert lead to deal"
      busy={convert.isPending}
      disabled={picked.length === 0}
      onSubmit={() =>
        convert.mutate({
          course_ids: own ? [own, ...picked.filter((c) => c !== own)] : picked,
          branch_id: branchId,
          assigned_to: owner ? Number(owner) : null,
          expected_close_date: close || null,
        })
      }
    >
      {existing.length > 0 && (
        <Warning>
          Existing open deals: {existing.map((d) => `${d.lead_code} ${d.course?.course_title ?? ""}`).join(", ")}. Selected duplicates are returned, never recreated.
        </Warning>
      )}
      <div>
        <div className="mb-1.5 text-sm font-medium">Courses</div>
        <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
          {options.map((c) => {
            const on = picked.includes(c.course_id);
            const locked = c.course_id === own;
            return (
              <label key={c.course_id} className={cn("check-tile", on && "check-tile-on")}>
                <Checkbox
                  checked={on}
                  disabled={locked}
                  aria-label={c.course_title}
                  onCheckedChange={(v) => setPicked((prev) => (v === true ? [...prev, c.course_id] : prev.filter((x) => x !== c.course_id)))}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold leading-snug">{c.course_title}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {c.course_code} · {money(c.standard_fee)}
                    {locked ? " · this lead" : ""}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Deal branch">
          <BranchSelect value={branchId} onChange={(e) => setBranchId(Number(e.target.value))} aria-label="Deal branch" />
        </Field>
        <Field label="Owner">
          <StaffSelect branchId={branchId} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner" />
        </Field>
        <Field label="Expected close">
          <Input type="date" min={todayIST()} value={close} onChange={(e) => setClose(e.target.value)} aria-label="Expected close" />
        </Field>
        <Field label="Person">
          <Input readOnly value={`Reuse existing person · ${person.data?.person_code ?? lead.person.person_code}`} />
        </Field>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        The courses move to Counselling on the person's pipeline card at this branch (joining it if one is open).
      </p>
    </FormDialog>
  );
}
