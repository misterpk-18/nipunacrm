/**
 * Book a demo by picking a free trainer slot: choose the course, then a day and a time under a trainer who is free
 * (branch hours and holidays, minus their other demos and batch sessions). The backend refuses a clash too, so a slot
 * taken meanwhile fails with a clear message and the list refreshes.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck } from "lucide-react";
import { post } from "@/api/client";
import { demoKeys, demosApi, type DemoSlot, type SlotTrainer } from "@/api/demos";
import { leadKeys, type Lead } from "@/api/leads";
import { pipelineKeys } from "@/api/pipeline";
import { Input } from "@/components/ui/input";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { Empty, ErrorPanel, LoadingRows } from "@/components/crm/ui";
import { useApiMutation } from "@/lib/mutation";
import { FormDialog } from "./shared";

const TZ = "Asia/Kolkata";
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

type Picked = { trainer: SlotTrainer; slot: DemoSlot };
type BookBody = { scheduled_at: string; course_id: number; demo_type: string; mode: string; duration_minutes: number; trainer_user_id: number; meeting_link: string | null };

export function BookDemoDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [courseId, setCourseId] = useState(lead.course ? String(lead.course.course_id) : "");
  const [type, setType] = useState<"Standard" | "Practical">("Standard");
  const [mode, setMode] = useState("In-person");
  const [link, setLink] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);

  const query = { course_id: Number(courseId), branch_id: lead.branch.branch_id, type, days: 7 };
  const slots = useQuery({ queryKey: demoKeys.slots(query), queryFn: () => demosApi.slots(query), enabled: Boolean(courseId), refetchOnWindowFocus: false });

  // Every day of the window with how many slots are free that day (across trainers)
  const days = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const trainer of slots.data?.trainers ?? [])
      for (const slot of trainer.slots) {
        const key = dayKey(slot.start);
        const entry = counts.get(key) ?? { label: dayLabel(slot.start), count: 0 };
        counts.set(key, { ...entry, count: entry.count + 1 });
      }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, ...value }));
  }, [slots.data]);

  // Land on the first day with free time; drop a pick that is no longer on offer
  useEffect(() => {
    if (!days.length) return setDay(null);
    if (!day || !days.some((d) => d.key === day)) setDay(days[0]!.key);
  }, [days, day]);
  useEffect(() => setPicked(null), [courseId, type]);

  const book = useApiMutation(
    (body: BookBody) => post<{ demo_code: string }>(`/leads/${lead.lead_id}/demos`, body),
    {
      success: (d) => `Demo ${d.demo_code} booked`,
      invalidate: [leadKeys.all, pipelineKeys.all, ["demos"], ["persons"], ["tasks"]],
      onSuccess: onClose,
      onError: () => {
        setPicked(null);
        void slots.refetch(); // the slot was taken meanwhile
      },
    },
  );

  const trainers = (slots.data?.trainers ?? []).map((t) => ({ ...t, slots: t.slots.filter((s) => dayKey(s.start) === day) }));
  const teaching = trainers.filter((t) => t.teaches_course);
  const others = trainers.filter((t) => !t.teaches_course);
  const canBook = Boolean(picked) && (mode !== "Online" || link.trim() !== "");

  const submit = () => {
    if (!picked || !slots.data) return;
    book.mutate({
      scheduled_at: picked.slot.start,
      course_id: Number(courseId),
      demo_type: type,
      mode,
      duration_minutes: slots.data.duration_minutes,
      trainer_user_id: picked.trainer.user_id,
      meeting_link: mode === "Online" ? link.trim() : null,
    });
  };

  return (
    <FormDialog
      title={`Book demo · ${lead.name}`}
      description="Pick a trainer's free slot. Times are IST and follow branch hours, holidays and the trainer's other demos and batches."
      onClose={onClose}
      busy={book.isPending}
      disabled={!canBook}
      submitLabel="Book demo"
      onSubmit={submit}
    >
      {lead.course ? (
        <div className="text-sm">
          <span className="text-muted-foreground">Course: </span>
          <b>{lead.course.course_title}</b>
        </div>
      ) : (
        <Field label="Course" htmlFor="book-course">
          <CourseSelect id="book-course" branchCode={lead.branch.branch_code} placeholder="Choose a course to see trainers" value={courseId} onChange={(e) => setCourseId(e.target.value)} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" htmlFor="book-type">
          <NativeSelect
            id="book-type"
            value={type}
            options={[
              { value: "Standard", label: "Standard · 45 min" },
              { value: "Practical", label: "Practical · 60 min" },
            ]}
            onChange={(e) => setType(e.target.value as "Standard" | "Practical")}
          />
        </Field>
        <Field label="Mode" htmlFor="book-mode">
          <NativeSelect id="book-mode" value={mode} options={["In-person", "Online"].map((m) => ({ value: m, label: m }))} onChange={(e) => setMode(e.target.value)} />
        </Field>
      </div>
      {mode === "Online" && (
        <Field label="Meeting link" htmlFor="book-link">
          <Input id="book-link" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://meet…" />
        </Field>
      )}

      {!courseId ? (
        <Empty title="Choose a course">Free trainer slots for the next 7 days appear here.</Empty>
      ) : slots.isLoading ? (
        <LoadingRows rows={3} />
      ) : slots.error ? (
        <ErrorPanel error={slots.error} onRetry={() => void slots.refetch()} />
      ) : !days.length ? (
        <Empty title="No free slots in the next 7 days">No trainer is free at this branch. Try the other demo type or check the branch hours and holidays.</Empty>
      ) : (
        <div className="grid gap-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Day">
            {days.map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={day === d.key}
                onClick={() => setDay(d.key)}
                className={`shrink-0 rounded-md border px-3 py-1.5 text-left text-xs ${day === d.key ? "border-primary bg-primary/10 font-semibold text-primary" : "bg-card text-muted-foreground hover:bg-muted"}`}
              >
                {d.label}
                <small className="block font-normal">{d.count} free</small>
              </button>
            ))}
          </div>
          <TrainerSlots title="Trainers for this course" trainers={teaching} picked={picked} onPick={setPicked} />
          <TrainerSlots title={teaching.length ? "Other trainers at this branch" : "Trainers at this branch"} trainers={others} picked={picked} onPick={setPicked} />
          {picked && (
            <p className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-2 text-sm" aria-live="polite">
              <CalendarCheck className="size-4 text-primary" />
              {dayLabel(picked.slot.start)}, {timeLabel(picked.slot.start)} – {timeLabel(picked.slot.end)} with <b>{picked.trainer.full_name}</b>
            </p>
          )}
        </div>
      )}
    </FormDialog>
  );
}

function TrainerSlots({ title, trainers, picked, onPick }: { title: string; trainers: SlotTrainer[]; picked: Picked | null; onPick: (p: Picked) => void }) {
  if (!trainers.length) return null;
  return (
    <section aria-label={title} className="grid gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {trainers.map((trainer) => (
        <div key={trainer.user_id} className="rounded-md border p-2.5">
          <div className="mb-1.5 text-sm font-semibold">{trainer.full_name}</div>
          {trainer.slots.length === 0 ? (
            <p className="text-xs text-muted-foreground">Not free on this day</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {trainer.slots.map((slot) => {
                const active = picked?.trainer.user_id === trainer.user_id && picked.slot.start === slot.start;
                return (
                  <button
                    key={slot.start}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onPick({ trainer, slot })}
                    className={`rounded-md border px-2.5 py-1 text-xs ${active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
                  >
                    {timeLabel(slot.start)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
