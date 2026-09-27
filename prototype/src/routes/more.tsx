import { createFileRoute, Link } from "@tanstack/react-router";
import { useCrmScope } from "@/components/crm/crm-scope";
import { PageHead, Section } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/more")({
  head: () => ({ meta: [
    { title: "More — Nipuna CRM Prototype" },
    { name: "description", content: "Role-aware sample CRM navigation." },
    { property: "og:title", content: "More — Nipuna CRM" },
    { property: "og:description", content: "Role-aware sample CRM navigation." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: More,
});

function More() {
  const { role } = useCrmScope();
  const global = role === "Founder / CEO" || role === "Super Admin";
  return <>
    <PageHead title="More" description={`${role} · sample navigation`} />
    <Section title="Workspaces">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild><Link to="/demos">Demos</Link></Button>
        <Button variant="outline" asChild><Link to="/admissions">Admissions</Link></Button>
        <Button variant="outline" asChild><Link to="/payments">Payments</Link></Button>
        <Button variant="outline" asChild><Link to="/reports">Reports</Link></Button>
        <Button variant="outline" asChild><Link to="/course-master">Course Master</Link></Button>
        <Button variant="outline" asChild><Link to="/placement-alumni">Placement & Alumni</Link></Button>
        {global && <Button variant="outline" asChild><Link to="/admin">Admin / Settings</Link></Button>}
      </div>
    </Section>
    <p className="mt-4 text-xs text-muted-foreground">Prototype navigation only · production permissions Pending Verification</p>
  </>;
}