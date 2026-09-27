import { createFileRoute } from "@tanstack/react-router";
import { TASK_LINK_FIELDS } from "@/api/tasks";
import { TasksPage, type TaskSearch } from "@/features/operations/tasks-page";

const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export const Route = createFileRoute("/tasks")({
  validateSearch: (s: Record<string, unknown>): TaskSearch => {
    const out: Record<string, unknown> = {
      tab: str(s["tab"]),
      page: num(s["page"]),
      type: str(s["type"]),
      due_today: s["due_today"] === true || s["due_today"] === "true" ? true : undefined,
    };
    for (const field of TASK_LINK_FIELDS) out[field] = num(s[field]);
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as TaskSearch;
  },
  component: TasksRoute,
});

function TasksRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <TasksPage search={search} onSearch={(next) => void navigate({ search: next })} />;
}
