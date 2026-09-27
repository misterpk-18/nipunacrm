import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { ApiError, errorMessage } from "@/api/client";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search["redirect"] === "string" && search["redirect"].startsWith("/") ? { redirect: search["redirect"] } : {},
  component: Login,
});

function Login() {
  const { login } = useAuth();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const profile = await login(email.trim(), password);
      void navigate({ to: profile.user.must_change_password ? "/change-password" : (redirect ?? profile.home_route), replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.code === "VALIDATION_ERROR" ? "Enter a valid email and password" : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.15fr_.85fr]">
      <div className="hidden bg-sidebar p-12 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div>
          <div className="logo-mark">N</div>
          <h1 className="mt-10 max-w-xl text-4xl font-semibold leading-tight">Nipuna CRM</h1>
          <p className="mt-4 max-w-lg text-sidebar-foreground/65">
            One connected learner journey across sales, admissions, collections and learning operations.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {["Branch-separated operations", "Human-controlled approvals", "Advisory AI insights", "End-to-end audit trail"].map((x) => (
            <div className="rounded-md border border-sidebar-border p-3" key={x}>
              <Check className="mb-2 size-4" />
              {x}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-center p-5">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <div className="logo-mark">N</div>
            <h1 className="mt-3 text-2xl font-semibold">Nipuna CRM</h1>
          </div>
          <form
            className="panel space-y-4 p-6 sm:p-8"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <h2 className="text-xl font-semibold">Welcome back</h2>
              <p className="mt-1 text-sm text-muted-foreground">Sign in with your staff account.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || !email || !password}>
              {busy && <Loader2 className="animate-spin" />}
              Sign in
            </Button>
            <p className="text-xs text-muted-foreground">Sessions end after 30 minutes of inactivity. Forgot your password? Ask an administrator to reset it.</p>
          </form>
        </div>
      </div>
    </div>
  );
}
