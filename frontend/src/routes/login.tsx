import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { ApiError, errorMessage } from "@/api/client";
import { useAuth } from "@/auth/auth";
import { AuthLayout } from "@/components/crm/auth-layout";
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
    <AuthLayout>
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Sessions end after 30 minutes of inactivity.</span>
          <Link to="/forgot-password" className="font-medium text-primary">
            Forgot password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
