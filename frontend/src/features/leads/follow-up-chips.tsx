/** Quick next-action times for Save outcome: In 2 hrs · Today 5pm · Tomorrow 11am · +3 days · Next week (IST). */
import { useQuery } from "@tanstack/react-query";
import { leadsApi } from "@/api/leads";
import { toLocalInput } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ChipKey = "in2h" | "today5pm" | "tomorrow11am" | "plus3d" | "nextweek";

export const FOLLOW_UP_CHIPS: { key: ChipKey; label: string }[] = [
  { key: "in2h", label: "In 2 hrs" },
  { key: "today5pm", label: "Today 5pm" },
  { key: "tomorrow11am", label: "Tomorrow 11am" },
  { key: "plus3d", label: "+3 days" },
  { key: "nextweek", label: "Next week" },
];

/** The chip each outcome starts on; outcomes that close the conversation take no date. */
export function chipForOutcome(outcome: string, now = new Date()): ChipKey | "none" | null {
  if (outcome === "No answer") return "in2h";
  if (outcome === "Callback requested") return istHour(now) >= 15 ? "in2h" : "today5pm";
  if (outcome === "Interested") return "tomorrow11am";
  if (outcome === "Later") return "nextweek";
  if (outcome === "Not interested" || outcome === "Wrong number" || outcome === "Stop contact") return "none";
  return null; // Connected / Demo booked: the counsellor picks
}

function istHour(now: Date): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCHours();
}

/** IST calendar date `days` after today as YYYY-MM-DD. */
function istDay(now: Date, days: number): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000 + days * 86_400_000);
  return ist.toISOString().slice(0, 10);
}

/** datetime-local value (IST) for a chip. `staffedIso` is the server's "2 staffed hours from now", when known. */
export function chipValue(key: ChipKey, staffedIso?: string | null, now = new Date()): string {
  switch (key) {
    case "in2h":
      return toLocalInput(staffedIso ?? new Date(now.getTime() + 2 * 3600_000).toISOString());
    case "today5pm":
      return `${istDay(now, 0)}T17:00`;
    case "tomorrow11am":
      return `${istDay(now, 1)}T11:00`;
    case "plus3d":
      return `${istDay(now, 3)}T11:00`;
    case "nextweek":
      return `${istDay(now, 7)}T11:00`;
  }
}

/** "In 2 hrs" respects the branch's staffed hours (server); falls back to a plain 2 hours while it loads. */
export function useStaffedInTwoHours(branchId: number | undefined) {
  return useQuery({
    queryKey: ["leads", "staffed-time", branchId, 120],
    queryFn: () => leadsApi.staffedTime(branchId!, 120),
    enabled: branchId !== undefined,
    staleTime: 60_000,
    select: (r) => r.at,
  });
}

export function FollowUpChips({ active, onPick, staffedIso }: { active: ChipKey | null; onPick: (key: ChipKey, value: string) => void; staffedIso?: string | null | undefined }) {
  const now = new Date();
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick times">
      {FOLLOW_UP_CHIPS.map(({ key, label }) => {
        const v = chipValue(key, staffedIso, now);
        const past = new Date(`${v}:00+05:30`).getTime() <= now.getTime();
        const on = key === active;
        return (
          <button
            key={key}
            type="button"
            disabled={past}
            aria-pressed={on}
            onClick={() => onPick(key, v)}
            className={cn("rounded-full border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40", on ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
