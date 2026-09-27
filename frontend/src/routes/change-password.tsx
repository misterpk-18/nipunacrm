import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { authApi } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/change-password")({ component: ChangePassword });

export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await authApi.changePassword(current, next);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <p className="text-xs text-muted-foreground">At least 10 characters. Your other sessions will be signed out.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && <p className="text-xs text-destructive">Passwords don't match</p>}
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !current || !next || next !== confirm}>
        Change password
      </Button>
    </form>
  );
}

function ChangePassword() {
  const { refresh, profile, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="panel w-full max-w-md p-6 sm:p-8">
        <h1 className="text-xl font-semibold">Set a new password</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          {profile?.user.must_change_password ? "Your account has a temporary password. Choose a new one to continue." : "Change your password."}
        </p>
        <ChangePasswordForm
          onDone={async () => {
            await refresh();
            void navigate({ to: "/" });
          }}
        />
        <button className="mt-4 text-xs text-muted-foreground underline" onClick={() => void logout().then(() => navigate({ to: "/login" }))}>
          Sign out instead
        </button>
      </div>
    </div>
  );
}
