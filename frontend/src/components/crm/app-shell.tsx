import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as Icons from "lucide-react";
import { Bell, Bot, Building2, ChevronDown, LogOut, PanelLeft, Search, X, type LucideIcon } from "lucide-react";
import { list } from "@/api/client";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { MORE_ITEMS, NAV_GROUPS, WORKFLOW_GUIDE, allowed, mobileNavItems, type NavItem } from "@/auth/access";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar } from "@/components/crm/ui";
import { cn } from "@/lib/utils";

function Icon({ name, className }: { name: string; className?: string }) {
  const Component = (Icons as unknown as Record<string, LucideIcon>)[name] ?? Icons.Circle;
  return <Component className={cn("size-4", className)} />;
}

const isActive = (path: string, to: string) => path === to || path.startsWith(`${to}/`);

/** Sidebar badge counts (V4): new enquiries on Leads, payment claims awaiting verification on Payments. */
function useNavCounts(enabled: { leads: boolean; payments: boolean }) {
  const branchId = useBranchFilter();
  const leads = useQuery({
    queryKey: ["leads", "nav-count", branchId ?? null],
    queryFn: () => list<unknown>("/leads", { per_page: 1, branch_id: branchId }),
    enabled: enabled.leads,
    refetchInterval: 120_000,
  });
  const payments = useQuery({
    queryKey: ["payments", "nav-count", branchId ?? null],
    queryFn: () => list<unknown>("/payments", { status: "Pending Verification", per_page: 1, branch_id: branchId }),
    enabled: enabled.payments,
    refetchInterval: 120_000,
  });
  return { "/leads": leads.data?.meta.total, "/payments": payments.data?.meta.total } as Record<string, number | undefined>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState("");
  const { profile, roles, branches, branchId, setBranchId, logout, hasRole } = useAuth();
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i, roles)) })).filter((g) => g.items.length);
  const more = MORE_ITEMS.filter((i) => allowed(i, roles));
  const counts = useNavCounts({
    leads: groups.some((g) => g.items.some((i) => i.to === "/leads")),
    payments: groups.some((g) => g.items.some((i) => i.to === "/payments")),
  });
  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => list<unknown>("/notifications", { per_page: 1 }),
    refetchInterval: 60_000,
  });
  const unreadCount = (unread.data?.meta as { unread?: number } | undefined)?.unread ?? 0;
  const roleLabel = [...new Set(profile?.scopes.map((s) => s.role_name))].join(" · ");
  const fullName = profile?.user.full_name ?? "";

  const signOut = async () => {
    await logout();
    void navigate({ to: "/login" });
  };

  const navLink = (item: NavItem) => {
    const count = counts[item.to];
    return (
      <Link key={item.to} to={item.to} onClick={() => setMobile(false)} className={cn("nav-item", isActive(path, item.to) && "nav-active")} aria-current={isActive(path, item.to) ? "page" : undefined}>
        <Icon name={item.icon} />
        <span className="min-w-0 truncate">{item.label}</span>
        {count ? (
          <span className="nav-count" aria-label={`${count} waiting`}>
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className={cn("sidebar", mobile && "sidebar-open")}>
        <div className="sidebar-brand">
          <div className="logo-mark" aria-hidden>
            N
          </div>
          <div className="brand-name">
            nipuna<small>CRM</small>
          </div>
          <Button variant="ghost" size="icon" className="ml-auto md:hidden" onClick={() => setMobile(false)} aria-label="Close navigation">
            <X />
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto pb-2" aria-label="Main">
          {groups.map((g) => (
            <div key={g.label} className="nav-group" role="group" aria-label={g.label}>
              <div className="nav-group-label">{g.label}</div>
              <div className="grid gap-[3px]">{g.items.map(navLink)}</div>
            </div>
          ))}
          {more.length > 0 && (
            <div className="nav-group" role="group" aria-label="More">
              <div className="nav-group-label">More</div>
              <div className="grid gap-[3px]">{more.map(navLink)}</div>
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          {navLink(WORKFLOW_GUIDE)}
          <Link to="/account" onClick={() => setMobile(false)} className="sidebar-person mt-2">
            <Avatar name={fullName} />
            <span className="min-w-0">
              <b className="truncate">{fullName}</b>
              <small className="truncate">{roleLabel}</small>
            </span>
          </Link>
        </div>
      </aside>
      {mobile && <button className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => setMobile(false)} aria-label="Close navigation" />}
      <div className="md:pl-60">
        <header className="topbar">
          <Button variant="ghost" size="icon" className="shrink-0 md:hidden" onClick={() => setMobile(true)} aria-label="Open navigation">
            <PanelLeft />
          </Button>
          {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE") ? (
            <form
              className="top-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                void navigate({ to: "/persons", search: { q: search.trim() || undefined } });
              }}
            >
              <Search aria-hidden />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search persons by name or mobile number" aria-label="Search all persons" />
            </form>
          ) : (
            <div className="hidden flex-1 md:block" />
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2 md:gap-3">
            <div className="branch-select">
              <Building2 aria-hidden />
              <select aria-label="Branch scope" value={branchId ?? ""} disabled={branches.length <= 1} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}>
                {branches.length > 1 && <option value="">All Branches</option>}
                {branches.map((b) => (
                  <option key={b.branch_id} value={b.branch_id}>
                    {b.branch_name}
                  </option>
                ))}
              </select>
              {branches.length > 1 && <ChevronDown aria-hidden />}
            </div>
            {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER") && (
              <Button variant="ghost" size="icon" className="hidden shrink-0 sm:inline-flex" title="Ask Nipuna" asChild>
                <Link to="/ask-nipuna" aria-label="Ask Nipuna">
                  <Bot />
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="icon" title="Notifications" className="relative shrink-0" asChild>
              <Link to="/notifications" aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}>
                <Bell className="!size-5" />
                {unreadCount > 0 && (
                  <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="shrink-0 rounded-full" aria-label="Account menu" title={`${fullName} · ${roleLabel}`}>
                  <Avatar name={fullName} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm">{fullName}</div>
                  <div className="text-xs font-normal text-muted-foreground">{profile?.user.email}</div>
                  <div className="mt-0.5 text-xs font-normal text-muted-foreground">{roleLabel}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/account">Account & sessions</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {profile?.user.is_recovery_account && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs font-medium text-destructive">
            Recovery account — every action is audited
          </div>
        )}
        <main className="workspace-main">{children}</main>
      </div>
      <nav className="mobile-nav" aria-label="Quick">
        {mobileNavItems(roles).map((item) => (
          <Link to={item.to} key={item.to} className={cn(isActive(path, item.to) && "active")} aria-current={isActive(path, item.to) ? "page" : undefined}>
            <Icon name={item.icon} />
            <small>{item.label}</small>
          </Link>
        ))}
      </nav>
    </div>
  );
}
