import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as Icons from "lucide-react";
import { Bell, Bot, Building2, LogOut, Menu, Search, X, type LucideIcon } from "lucide-react";
import { list } from "@/api/client";
import { useAuth } from "@/auth/auth";
import { MORE_ITEMS, NAV_ITEMS, allowed, type NavItem } from "@/auth/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function Icon({ name, className }: { name: string; className?: string }) {
  const Component = (Icons as unknown as Record<string, LucideIcon>)[name] ?? Icons.Circle;
  return <Component className={cn("size-4", className)} />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState("");
  const { profile, roles, branches, branchId, setBranchId, logout, isCounsellor, isManager, hasRole } = useAuth();
  const nav = NAV_ITEMS.filter((i) => allowed(i, roles));
  const more = MORE_ITEMS.filter((i) => allowed(i, roles));
  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => list<unknown>("/notifications", { per_page: 1 }),
    refetchInterval: 60_000,
  });
  const unreadCount = (unread.data?.meta as { unread?: number } | undefined)?.unread ?? 0;
  const roleLabel = [...new Set(profile?.scopes.map((s) => s.role_name))].join(" · ");

  const signOut = async () => {
    await logout();
    void navigate({ to: "/login" });
  };

  const mobileItems: [string, string, string][] = isCounsellor
    ? [["Today", "/counsellor", "Headset"], ["Leads", "/leads", "Users"], ["Demos", "/demos", "Presentation"], ["Tasks", "/tasks", "ListChecks"], ["More", "/more", "Menu"]]
    : isManager
      ? [["Dashboard", "/branch-manager", "LayoutDashboard"], ["Leads", "/leads", "Users"], ["Tasks", "/tasks", "ListChecks"], ["Collections", "/collections", "Wallet"], ["More", "/more", "Menu"]]
      : [["Dashboard", "/dashboard", "LayoutDashboard"], ["Tasks", "/tasks", "ListChecks"], ["Students", "/students", "UserRound"], ["Alerts", "/notifications", "Bell"], ["More", "/more", "Menu"]];

  const navLink = (item: NavItem) => (
    <Link key={item.to} to={item.to} onClick={() => setMobile(false)} className={cn("nav-item", (path === item.to || path.startsWith(`${item.to}/`)) && "nav-active")}>
      <Icon name={item.icon} />
      {item.label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className={cn("sidebar", mobile && "sidebar-open")}>
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-5">
          <div className="logo-mark">N</div>
          <div className="ml-3">
            <div className="text-sm font-semibold">Nipuna CRM</div>
            <div className="text-[10px] text-sidebar-foreground/60">Nipuna Technologies</div>
          </div>
          <Button variant="ghost" size="icon" className="ml-auto md:hidden" onClick={() => setMobile(false)} aria-label="Close navigation">
            <X />
          </Button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Main">
          {nav.map(navLink)}
          {more.length > 0 && <div className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase text-sidebar-foreground/50">More</div>}
          {more.map(navLink)}
        </nav>
      </aside>
      {mobile && <button className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => setMobile(false)} aria-label="Close navigation" />}
      <div className="md:pl-60">
        <header className="topbar">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobile(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <div className="scope-select branch-select">
            <span>Branch</span>
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <select
                aria-label="Branch scope"
                className="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-2 text-sm disabled:opacity-70"
                value={branchId ?? ""}
                disabled={branches.length <= 1}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
              >
                {branches.length > 1 && <option value="">All branches</option>}
                {branches.map((b) => (
                  <option key={b.branch_id} value={b.branch_id}>
                    {b.branch_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", "SALES", "FRONT_OFFICE") && (
            <form
              className="relative hidden max-w-lg flex-1 xl:block"
              onSubmit={(e) => {
                e.preventDefault();
                void navigate({ to: "/leads", search: { q: search.trim() || undefined } });
              }}
            >
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search leads by name, phone, email or code" aria-label="Search leads" />
            </form>
          )}
          <div className="ml-auto flex items-center gap-1">
            {hasRole("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER") && (
              <Button variant="outline" size="sm" className="hidden sm:inline-flex" asChild>
                <Link to="/ask-nipuna">
                  <Bot />
                  Ask Nipuna
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="icon" title="Notifications" className="relative" asChild>
              <Link to="/notifications" aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}>
                <Bell />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="ml-1 flex items-center gap-2 rounded-md border-l py-1 pl-3 pr-1 text-left hover:bg-muted" aria-label="Account menu">
                  <div className="grid size-8 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {profile?.user.full_name
                      .split(" ")
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join("")}
                  </div>
                  <div className="hidden lg:block">
                    <div className="text-xs font-semibold">{profile?.user.full_name}</div>
                    <div className="max-w-48 truncate text-[10px] text-muted-foreground">{roleLabel}</div>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm">{profile?.user.full_name}</div>
                  <div className="text-xs font-normal text-muted-foreground">{profile?.user.email}</div>
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
        <main className="mx-auto min-w-0 max-w-[1600px] p-4 pb-24 sm:p-6 md:pb-8">{children}</main>
      </div>
      <nav className="mobile-nav" aria-label="Quick">
        {mobileItems.map(([label, to, icon]) => (
          <Link to={to} key={to} className={cn(path === to && "text-primary")}>
            <Icon name={icon} className="size-5" />
            <small>{label}</small>
          </Link>
        ))}
      </nav>
    </div>
  );
}
