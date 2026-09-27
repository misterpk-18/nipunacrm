import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Bell, Bot, Building2, ChevronDown, Menu, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { navItems, type Branch } from "@/lib/crm-data";
import { roleHome, useCrmScope, type PrototypeRole } from "./crm-scope";
import { cn } from "@/lib/utils";

const icons = ["▦", "◎", "◫", "◷", "◇", "▣", "♙", "₹", "▤", "◉", "↩", "✓", "✉", "▥", "♧", "✦", "▤"];
export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const { branch, setBranch, role, setRole, roles, allowedBranches, isCounsellor } = useCrmScope();
  if (path === "/") return <>{children}</>;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="prototype-strip">
        SAMPLE DATA — NO LIVE INTEGRATIONS <span>· NIPUNA CRM INTERACTIVE PROTOTYPE</span>
      </div>
      <aside className={cn("sidebar", mobile && "sidebar-open")}>
        <div className="flex h-16 items-center border-b border-sidebar-border px-5">
          <div className="logo-mark">N</div>
          <div className="ml-3">
            <div className="text-sm font-semibold">Nipuna CRM</div>
            <div className="text-[10px] text-sidebar-foreground/60">AI-enabled prototype</div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto md:hidden"
            onClick={() => setMobile(false)}
          >
            <X />
          </Button>
        </div>
        <nav className="space-y-0.5 p-3">
          {navItems.map(([name, to], i) => (
            <Link
              key={to}
              to={to}
              onClick={() => setMobile(false)}
              className={cn("nav-item", path === to && "nav-active")}
            >
              <span className="w-5 text-center text-base">{icons[i]}</span>
              {name}
            </Link>
          ))}
          {(role === "Founder / CEO" || role === "Super Admin") && (
            <Link
              to="/admin"
              onClick={() => setMobile(false)}
              className={cn("nav-item", path === "/admin" && "nav-active")}
            >
              <span className="w-5 text-center text-base">⚙</span>
              Admin / Settings
            </Link>
          )}
        </nav>
        <div className="mx-4 mt-auto border-t border-sidebar-border py-4 text-[10px] leading-5 text-sidebar-foreground/55">
          <div>CRM · nipuacrm.com</div>
          <div>Admin · admin.nipunatechnologies.com</div>
          <div>LMS · nipunalms.com</div>
          <div>API · api.nipunatechnologies.com</div>
          <div className="mt-2">Master recovery · recovery.admin@example.test</div>
          <div className="mt-2 font-semibold text-sidebar-foreground/80">
            Labels only · Not Connected
          </div>
        </div>
      </aside>
      {mobile && (
        <button
          className="fixed inset-0 z-30 bg-overlay md:hidden"
          onClick={() => setMobile(false)}
          aria-label="Close navigation"
        />
      )}
      <div className="md:pl-60">
        <header className="topbar">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobile(true)}>
            <Menu />
          </Button>
          <div className="scope-select">
            <span>Prototype Role</span>
            <Select
              value={role}
              onValueChange={(value) => {
                const next = value as PrototypeRole;
                setRole(next);
                void navigate({ to: roleHome(next) });
              }}
            >
              <SelectTrigger aria-label="Prototype Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem value={r} key={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="scope-select branch-select">
            <span>Branch Scope</span>
            <Select
              value={branch}
              onValueChange={(value) => setBranch(value as Branch)}
              disabled={allowedBranches.length === 1}
            >
              <SelectTrigger>
                <Building2 className="mr-2 size-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowedBranches.map((b) => (
                  <SelectItem value={b} key={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="relative hidden max-w-lg flex-1 xl:block">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search name, phone, email, Person ID, Admission ID"
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" asChild>
              <Link to="/ask-nipuna">
                <Bot />
                Ask Nipuna
              </Link>
            </Button>
            <Button variant="ghost" size="icon" title="Notification Centre" asChild>
              <Link to="/notifications"><Bell /></Link>
            </Button>
            <div className="ml-1 hidden border-l pl-3 lg:block">
              <div className="text-xs font-semibold">{role}</div>
              <div className="text-[10px] text-muted-foreground">Demo role · not authenticated</div>
            </div>
            <ChevronDown className="hidden size-4 lg:block" />
          </div>
        </header>
        <div className="branch-ribbon">
          <span className="font-semibold">Branch scope: {branch}</span>
          <span>{role}</span>
          <span className="ml-auto">Sample records only</span>
        </div>
        <main className="mx-auto min-w-0 max-w-[1600px] p-4 pb-24 sm:p-6 md:pb-8">{children}</main>
      </div>
      <nav className="mobile-nav">
        {(isCounsellor
          ? ([
              ["Today Queue", "/counsellor", 0],
              ["Leads", "/leads", 1],
              ["Demos", "/demos", 3],
              ["Tasks", "/tasks", 9],
              ["Communications", "/communications", 10],
            ] as const)
          : role.endsWith("Branch Manager")
            ? ([
                ["Dashboard", "/branch-manager", 0], ["Leads", "/leads", 1],
                ["Tasks", "/tasks", 9], ["Collections", "/collections", 7], ["More", "/more", 14],
              ] as const)
            : ([
                ["Dashboard", "/dashboard", 0], ["Reports", "/reports", 11],
                ["Ask Nipuna", "/ask-nipuna", 13], ["Notifications", "/notifications", 10], ["More", "/more", 14],
              ] as const)
        ).map(([n, to, i]) => (
          <Link to={to} key={to} className={cn(path === to && "text-primary")}>
            <span>{icons[i]}</span>
            <small>{n}</small>
          </Link>
        ))}
      </nav>
    </div>
  );
}
