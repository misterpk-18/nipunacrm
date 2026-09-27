/** Mobile "More" hub: every screen the current role may open, grouped as in the navigation. */
import { Link } from "@tanstack/react-router";
import * as Icons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MORE_ITEMS, NAV_ITEMS, allowed, type NavItem } from "@/auth/access";
import { useAuth } from "@/auth/auth";
import { PageHead, Section } from "@/components/crm/ui";

function ItemIcon({ name }: { name: string }) {
  const Icon = ((Icons as unknown as Record<string, LucideIcon>)[name] ??
    Icons.Circle) as LucideIcon;
  return <Icon className="size-5 text-primary" aria-hidden />;
}

function Grid({ items }: { items: NavItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="flex min-h-14 items-center gap-3 rounded-md border bg-card p-3 text-sm font-medium hover:bg-muted/50"
        >
          <ItemIcon name={item.icon} />
          <span className="min-w-0">{item.label}</span>
        </Link>
      ))}
    </div>
  );
}

export function MorePage() {
  const { roles, profile } = useAuth();
  const role = profile?.scopes
    .map((s) => s.role_name)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(" · ");
  const workspaces = NAV_ITEMS.filter((i) => allowed(i, roles));
  const more = MORE_ITEMS.filter((i) => allowed(i, roles));
  return (
    <>
      <PageHead title="More" description={role} />
      <div className="space-y-4">
        <Section title="Workspaces">
          <Grid items={workspaces} />
        </Section>
        {more.length > 0 && (
          <Section title="Management & settings">
            <Grid items={more} />
          </Section>
        )}
        <Section title="Account">
          <Grid
            items={[
              {
                label: "My account",
                to: "/account",
                icon: "UserCog",
                roles: [],
              },
            ]}
          />
        </Section>
      </div>
    </>
  );
}
