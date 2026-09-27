import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { authApi } from "@/api/auth";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { DataTable, Facts, PageHead, Section, Status } from "@/components/crm/ui";
import { dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { ChangePasswordForm } from "./change-password";

export const Route = createFileRoute("/account")({ component: Account });

function Account() {
  const { profile } = useAuth();
  const sessions = useQuery({ queryKey: ["auth", "sessions"], queryFn: authApi.sessions });
  const revoke = useApiMutation(authApi.revokeSession, { success: "Session signed out", invalidate: [["auth", "sessions"]] });
  if (!profile) return null;
  return (
    <>
      <PageHead title="Account & sessions" description="Your profile, access and signed-in devices." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Profile">
          <Facts
            items={[
              ["Name", profile.user.full_name],
              ["Email", profile.user.email],
              ["Last sign-in", dateTime(profile.user.last_login_at)],
              ["Branches", profile.allowed_branches.map((b) => b.branch_name).join(", ")],
            ]}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            {profile.scopes.map((s) => (
              <Status key={s.scope_id} kind="neutral">
                {s.role_name}
                {s.branch_code ? ` · ${s.branch_code}` : " · All branches"}
                {s.expires_at ? ` · until ${dateTime(s.expires_at)}` : ""}
              </Status>
            ))}
          </div>
        </Section>
        <Section title="Change password">
          <ChangePasswordForm onDone={() => toast.success("Password changed. Other sessions were signed out.")} />
        </Section>
      </div>
      <Section title="Active sessions" className="mt-4">
        <DataTable
          rows={sessions.data}
          loading={sessions.isLoading}
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
          rowKey={(s) => s.session_id}
          columns={[
            { header: "Device", cell: (s) => <span className="block max-w-80 truncate">{s.user_agent ?? "Unknown"}</span> },
            { header: "IP", cell: (s) => s.ip_address ?? "—" },
            { header: "Signed in", cell: (s) => dateTime(s.created_at) },
            { header: "Last active", cell: (s) => dateTime(s.last_seen_at) },
            {
              header: "",
              cell: (s) =>
                s.current ? (
                  <Status kind="good">This device</Status>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => revoke.mutate(s.session_id)}>
                    Sign out
                  </Button>
                ),
            },
          ]}
        />
      </Section>
    </>
  );
}
