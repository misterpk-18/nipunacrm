/**
 * Optional next course for an existing student (playbook pages 13-14). Only approved course paths, never a course
 * already owned or included, ranked by usefulness (never by fee). Use = discussed with the learner; a deal exists only
 * after genuine interest is confirmed and staff add a lead for the course under the same person.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Person } from "@/api/leads";
import { playbookApi, playbookKeys, type CourseSuggestion, type Disposition } from "@/api/playbook";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiNote, Empty, LoadingRows, Section, Status } from "@/components/crm/ui";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { dateTime, fromLocalInput } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export function CourseSuggestionsPanel({ person }: { person: Person }) {
  const { hasRole } = useAuth();
  const q = useQuery({ queryKey: playbookKeys.suggestions(person.person_id), queryFn: () => playbookApi.courseSuggestions(person.person_id) });
  const [interest, setInterest] = useState<CourseSuggestion | null>(null);
  const canAct = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE");
  if (q.isLoading) return <LoadingRows rows={2} />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <Section title="Useful next course" subtitle="A counselling opportunity, not a sales target. No useful match is a valid result.">
      {d.stop_contact && <p className="mb-2 text-sm text-muted-foreground">Stop contact is recorded: suggestions are shown for reference only.</p>}
      {d.suggestions.length ? (
        <div className="space-y-3">
          {d.suggestions.map((s) => (
            <SuggestionCard key={s.course.course_id} person={person} s={s} canAct={canAct && !d.stop_contact} onInterest={() => setInterest(s)} />
          ))}
        </div>
      ) : (
        <Empty title="No recommendation">{d.note}</Empty>
      )}
      {(d.hidden.length > 0 || d.skipped.length > 0) && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {d.hidden.length} dismissed / snoozed · {d.skipped.length} not suggested
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {d.hidden.map((h) => (
              <li key={`h${h.course.course_id}`}>
                {h.course.course_title}: {h.disposition?.status}
                {h.disposition?.remind_at ? ` until ${dateTime(h.disposition.remind_at)}` : ""}
              </li>
            ))}
            {d.skipped.map((s) => (
              <li key={`s${s.course.course_id}`}>
                {s.course.course_title}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {interest && (
        <NewLeadDialog
          open
          onOpenChange={(o) => !o && setInterest(null)}
          person={person}
          courseId={interest.course.course_id}
          remarks={`Interest confirmed after next-course counselling (from ${interest.from_course.course_title})`}
        />
      )}
    </Section>
  );
}

function SuggestionCard({ person, s, canAct, onInterest }: { person: Person; s: CourseSuggestion; canAct: boolean; onInterest: () => void }) {
  const [snooze, setSnooze] = useState(false);
  const [remind, setRemind] = useState("");
  const used = s.disposition?.status === "Used" || s.disposition?.status === "Edited";
  const act = useApiMutation(
    (v: { status: Disposition; remind_at?: string }) => playbookApi.disposeCourseSuggestion(person.person_id, { course_id: s.course.course_id, ...v }),
    { success: (a) => `Suggestion ${a.status.toLowerCase()}`, invalidate: [playbookKeys.suggestions(person.person_id), ["playbook", "today"]], onSuccess: () => setSnooze(false) },
  );
  return (
    <AiNote
      title={`${s.course.course_title} · after ${s.from_course.course_title}`}
      actions={
        canAct &&
        (snooze ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), act.mutate({ status: "Snoozed", remind_at: fromLocalInput(remind)! }))}>
            <Input type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} aria-label="Remind at" className="max-w-56" />
            <Button size="sm" type="submit" disabled={!remind}>
              Remind me
            </Button>
          </form>
        ) : (
          <>
            {used ? (
              <Button size="sm" onClick={onInterest} disabled={!!s.open_lead}>
                Interest confirmed: add lead
              </Button>
            ) : (
              <Button size="sm" onClick={() => act.mutate({ status: "Used" })} disabled={act.isPending}>
                Discussed
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => act.mutate({ status: "Ignored" })} disabled={act.isPending}>
              Ignore
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSnooze(true)}>
              Remind later
            </Button>
          </>
        ))
      }
    >
      <p>
        <span className="font-medium">Benefit:</span> {s.learner_benefit}
      </p>
      <p className="mt-1">
        <span className="font-medium">Ask:</span> {s.suggested_question}
      </p>
      {s.goal && <p className="mt-1 text-xs">Recorded goal: {s.goal}</p>}
      <ul className="mt-1 list-disc pl-5 text-xs">
        {s.missing_checks.map((m) => (
          <li key={m}>{m}</li>
        ))}
        {s.overlap.length > 0 && <li>Overlaps with: {s.overlap.map((o) => o.course_title).join(", ")}</li>}
      </ul>
      <div className="mt-1 flex flex-wrap gap-2">
        <Status kind="neutral">{s.availability}</Status>
        {s.open_lead && <Status kind="info">Open lead {s.open_lead.lead_code} · {s.open_lead.stage}</Status>}
        {used && <Status kind="good">Discussed</Status>}
      </div>
    </AiNote>
  );
}
