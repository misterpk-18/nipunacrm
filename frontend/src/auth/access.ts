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
export type NavGroup = { label: string; items: NavItem[] };

const LEADS: NavItem = { label: "Leads", to: "/leads", icon: "SquareUser", roles: SALES_TEAM };
const PIPELINE: NavItem = { label: "Deal pipeline", to: "/pipeline", icon: "Columns3", roles: SALES_TEAM };
const PAYMENTS: NavItem = { label: "Payments & receipts", to: "/payments", icon: "ReceiptText", roles: FINANCE_TEAM };
const AI_ASSISTANT: NavItem = { label: "AI assistant", to: "/ai-copilot", icon: "Sparkles", roles: SALES_TEAM };

/** Sidebar groups (V4 names and order). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { label: "Overview", to: "/dashboard", icon: "LayoutGrid", roles: ALL_STAFF },
      { label: "My work", to: "/my-work", icon: "ListTodo", roles: ALL_STAFF },
      AI_ASSISTANT,
    ],
  },
  {
    label: "Sales",
    items: [
      LEADS,
      PIPELINE,
      { label: "Demos & counselling", to: "/demos", icon: "CalendarDays", roles: [...SALES_TEAM, "ACADEMIC_COORDINATOR", "TRAINER"] },
    ],
  },
  {
    label: "Learning",
    items: [
      { label: "Students", to: "/students", icon: "Users", roles: ALL_STAFF },
      { label: "Admissions", to: "/admissions", icon: "GraduationCap", roles: ALL_STAFF },
      { label: "Batches", to: "/batches", icon: "CalendarRange", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "TRAINER"] },
      { label: "LMS access", to: "/lms-access", icon: "BookMarked", roles: ALL_STAFF },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Invoices", to: "/invoices", icon: "FileText", roles: FINANCE_TEAM },
      PAYMENTS,
      { label: "Collections", to: "/collections", icon: "Wallet", roles: FINANCE_TEAM },
      { label: "Refunds", to: "/refunds", icon: "Undo2", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACCOUNTS"] },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Tasks", to: "/tasks", icon: "ListChecks", roles: ALL_STAFF },
      { label: "Communications", to: "/communications", icon: "MessagesSquare", roles: SALES_TEAM },
      { label: "Placement & alumni", to: "/placement-alumni", icon: "Briefcase", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "PLACEMENT"] },
      { label: "Reports", to: "/reports", icon: "BarChart3", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACCOUNTS"] },
    ],
  },
];

/** Every main-navigation screen, flat (used by the More hub and the route guard). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Screens outside V4's groups: the sidebar's "More" group, the More hub and the admin area. */
export const MORE_ITEMS: NavItem[] = [
  { label: "Persons", to: "/persons", icon: "Contact", roles: SALES_TEAM },
  { label: "Counsellor Workspace", to: "/counsellor", icon: "Headset", roles: SALES_TEAM },
  { label: "Branch Manager", to: "/branch-manager", icon: "Building2", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Discount Approvals", to: "/discount-approval", icon: "BadgePercent", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Offer Master", to: "/offer-master", icon: "Tag", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Target Master", to: "/target-master", icon: "Target", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACCOUNTS"] },
  { label: "Course Master", to: "/course-master", icon: "BookOpen", roles: ALL_STAFF },
  { label: "Notifications", to: "/notifications", icon: "Bell", roles: ALL_STAFF },
  { label: "Ask Nipuna", to: "/ask-nipuna", icon: "Bot", roles: [...ADMIN_ROLES, "BRANCH_MANAGER"] },
  { label: "Admin / Settings", to: "/admin", icon: "Settings", roles: ADMIN_ROLES },
];

/** Static guide to the record flow, pinned to the bottom of the sidebar. */
export const WORKFLOW_GUIDE: NavItem = { label: "Workflow guide", to: "/workflow-guide", icon: "Workflow", roles: ALL_STAFF };

export function allowed(item: { roles: RoleCode[] }, roles: RoleCode[]) {
  return item.roles.some((r) => roles.includes(r));
}

const HOME: NavItem = { label: "Home", to: "/dashboard", icon: "House", roles: ALL_STAFF };
const MORE: NavItem = { label: "More", to: "/more", icon: "Menu", roles: ALL_STAFF };
const short = (item: NavItem, label: string): NavItem => ({ ...item, label });

/**
 * Phone bottom bar: always five items. Sales roles get V4's Home / Leads / Pipeline / Payments / AI; other roles get
 * their own most-used screens, topped up from Tasks / Students / Alerts / More.
 */
export function mobileNavItems(roles: RoleCode[]): NavItem[] {
  const byRole: [RoleCode[], NavItem[]][] = [
    [SALES_TEAM, [short(LEADS, "Leads"), short(PIPELINE, "Pipeline"), short(PAYMENTS, "Payments"), short(AI_ASSISTANT, "AI")]],
    [["ACCOUNTS"], [{ label: "Invoices", to: "/invoices", icon: "FileText", roles: FINANCE_TEAM }, short(PAYMENTS, "Payments"), { label: "Collections", to: "/collections", icon: "Wallet", roles: FINANCE_TEAM }]],
    [["ACADEMIC_COORDINATOR", "TRAINER"], [{ label: "Admissions", to: "/admissions", icon: "GraduationCap", roles: ALL_STAFF }, { label: "Batches", to: "/batches", icon: "CalendarRange", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "TRAINER"] }]],
    [["PLACEMENT"], [{ label: "Placement", to: "/placement-alumni", icon: "Briefcase", roles: [...ADMIN_ROLES, "BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "PLACEMENT"] }]],
  ];
  const picked: NavItem[] = [HOME];
  const add = (item: NavItem) => {
    if (picked.length < 5 && allowed(item, roles) && !picked.some((p) => p.to === item.to)) picked.push(item);
  };
  for (const [who, items] of byRole) if (who.some((r) => roles.includes(r))) items.forEach(add);
  [
    { label: "Tasks", to: "/tasks", icon: "ListChecks", roles: ALL_STAFF },
    { label: "Students", to: "/students", icon: "Users", roles: ALL_STAFF },
    { label: "Alerts", to: "/notifications", icon: "Bell", roles: ALL_STAFF },
  ].forEach(add);
  if (picked.length < 5) picked.push(MORE);
  return picked.slice(0, 5);
}

/** Route path → roles, for the route guard (first matching prefix wins). */
export function rolesForPath(path: string): RoleCode[] | null {
  const items = [...NAV_ITEMS, ...MORE_ITEMS, WORKFLOW_GUIDE].sort((a, b) => b.to.length - a.to.length);
  const extra: Record<string, RoleCode[]> = {
    "/fee-quote": SALES_TEAM,
  };
  for (const [prefix, roles] of Object.entries(extra)) if (path.startsWith(prefix)) return roles;
  return items.find((i) => path === i.to || path.startsWith(`${i.to}/`))?.roles ?? null;
}
