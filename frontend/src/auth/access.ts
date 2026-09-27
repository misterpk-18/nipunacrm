/**
 * Which roles reach which screens. Mirrors the backend's @require_roles checks (probed against the API),
 * so the UI hides what the server would refuse anyway. The server remains the only real enforcement.
 */
import type { RoleCode } from "@/api/types";

export const ADMIN_ROLES: RoleCode[] = ["FOUNDER_CEO", "SUPER_ADMIN"];
export const COUNSELLOR_ROLES: RoleCode[] = ["SALES", "FRONT_OFFICE"];
const SALES_TEAM: RoleCode[] = [...ADMIN_ROLES, "BRANCH_MANAGER", ...COUNSELLOR_ROLES];
const FINANCE_TEAM: RoleCode[] = [...SALES_TEAM, "ACCOUNTS"];
const ALL_STAFF: RoleCode[] = [
  ...FINANCE_TEAM,
  "ACADEMIC_COORDINATOR",
  "TRAINER",
  "PLACEMENT",
  "HR",
];

export type NavItem = { label: string; to: string; icon: string; roles: RoleCode[] };

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", to: "/dashboard", icon: "LayoutDashboard", roles: ALL_STAFF },
  { label: "Leads", to: "/leads", icon: "Users", roles: SALES_TEAM },
  { label: "Pipeline", to: "/pipeline", icon: "KanbanSquare", roles: SALES_TEAM },
  { label: "Demos", to: "/demos", icon: "Presentation", roles: [...SALES_TEAM, "ACADEMIC_COORDINATOR", "TRAINER"] },
  { label: "Admissions", to: "/admissions", icon: "GraduationCap", roles: ALL_STAFF },
  { label: "Batches", to: "/batches", icon: "CalendarRange", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "TRAINER"] },
  { label: "Students", to: "/students", icon: "UserRound", roles: ALL_STAFF },
  { label: "Payments", to: "/payments", icon: "IndianRupee", roles: FINANCE_TEAM },
  { label: "Invoices", to: "/invoices", icon: "FileText", roles: FINANCE_TEAM },
  { label: "Collections", to: "/collections", icon: "Wallet", roles: FINANCE_TEAM },
  { label: "Refunds", to: "/refunds", icon: "Undo2", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACCOUNTS"] },
  { label: "Tasks", to: "/tasks", icon: "ListChecks", roles: ALL_STAFF },
  { label: "Communications", to: "/communications", icon: "MessagesSquare", roles: SALES_TEAM },
  { label: "Reports", to: "/reports", icon: "BarChart3", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACCOUNTS"] },
  { label: "Placement & Alumni", to: "/placement-alumni", icon: "Briefcase", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "PLACEMENT"] },
  { label: "AI Copilot", to: "/ai-copilot", icon: "Sparkles", roles: SALES_TEAM },
  { label: "Course Master", to: "/course-master", icon: "BookOpen", roles: ALL_STAFF },
];

/** Screens reached from "More" (and the admin area). */
export const MORE_ITEMS: NavItem[] = [
  { label: "Counsellor Workspace", to: "/counsellor", icon: "Headset", roles: SALES_TEAM },
  { label: "Branch Manager", to: "/branch-manager", icon: "Building2", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Discount Approvals", to: "/discount-approval", icon: "BadgePercent", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Offer Master", to: "/offer-master", icon: "Tag", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Target Master", to: "/target-master", icon: "Target", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACCOUNTS"] },
  { label: "Notifications", to: "/notifications", icon: "Bell", roles: ALL_STAFF },
  { label: "Ask Nipuna", to: "/ask-nipuna", icon: "Bot", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Admin / Settings", to: "/admin", icon: "Settings", roles: ADMIN_ROLES },
];

export function allowed(item: { roles: RoleCode[] }, roles: RoleCode[]) {
  return item.roles.some((r) => roles.includes(r));
}

/** Route path → roles, for the route guard (first matching prefix wins). */
export function rolesForPath(path: string): RoleCode[] | null {
  const items = [...NAV_ITEMS, ...MORE_ITEMS].sort((a, b) => b.to.length - a.to.length);
  const extra: Record<string, RoleCode[]> = {
    "/fee-quote": SALES_TEAM,
  };
  for (const [prefix, roles] of Object.entries(extra)) if (path.startsWith(prefix)) return roles;
  return items.find((i) => path === i.to || path.startsWith(`${i.to}/`))?.roles ?? null;
}
