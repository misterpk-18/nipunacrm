/** Admin / Settings hub (Founder / CEO and Super Admin). Tabs are kept in the URL (?tab=). */
import { Link } from "@tanstack/react-router";
import { Tag, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHead } from "@/components/crm/ui";
import { UsersTab } from "./admin-users";
import {
  BranchesTab,
  FinanceTab,
  LookupsTab,
  NotificationsTab,
  SettingsTab,
} from "./admin-config";
import { AuditTab, IntegrationsTab, SecurityTab } from "./admin-ops";

const TABS: [string, string][] = [
  ["users", "Users & Access"],
  ["settings", "Settings"],
  ["branches", "Branches, shifts & holidays"],
  ["lookups", "Lookups"],
  ["finance", "Concession limits"],
  ["notifications", "Notifications & channels"],
  ["integrations", "Integrations & incidents"],
  ["security", "Sessions & deletions"],
  ["audit", "Audit log"],
];

export function AdminPage({
  tab,
  onTab,
}: {
  tab: string;
  onTab: (tab: string) => void;
}) {
  return (
    <>
      <PageHead
        title="Admin / Settings"
        description="Restricted to Founder / CEO and Super Admin · sensitive changes ask for your password and are audited"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/offer-master">
                <Tag />
                Offer Master
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/target-master">
                <Target />
                Target Master
              </Link>
            </Button>
          </>
        }
      />
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList className="mb-4 h-auto max-w-full flex-wrap justify-start">
          {TABS.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="branches">
          <BranchesTab />
        </TabsContent>
        <TabsContent value="lookups">
          <LookupsTab />
        </TabsContent>
        <TabsContent value="finance">
          <FinanceTab />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationsTab />
        </TabsContent>
        <TabsContent value="integrations">
          <IntegrationsTab />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
