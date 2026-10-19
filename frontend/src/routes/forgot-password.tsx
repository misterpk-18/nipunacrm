/** Forgot password (db 046): mobile → 6-digit code on WhatsApp → new password. Public; never says whether the number has an account. */
import { useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/api/client";
import { authApi } from "@/api/auth";
import { AuthLayout } from "@/components/crm/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/forgot-password")({ component: ForgotPassword });

function fieldError(e: unknown, field: string): string | null {
  return e instanceof ApiError ? ((e.details as Record<string, string[]> | undefined)?.[field]?.[0] ?? null) : null;
}

function ForgotPassword() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await authApi.forgotPassword(phone.trim());
      setSentTo(phone.trim());
      setNotice(r.message);
      setWait(r.resend_after_seconds);
    } catch (e) {
      setError(fieldError(e, "phone") ? "Enter a valid mobile number" : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (password !== confirm) {
      setError("The two passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.resetPassword(sentTo ?? phone.trim(), code.trim(), password);
      toast.success("Password changed. Sign in with your new password.");
      void navigate({ to: "/login", replace: true });
    } catch (e) {
      setError(fieldError(e, "new_password") ?? fieldError(e, "code") ?? errorMessage(e));
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
          void (sentTo ? resetPassword() : sendCode());
        }}
      >
        <div>
          <h2 className="text-xl font-semibold">Forgot password</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {sentTo
              ? "Enter the 6-digit code from WhatsApp and choose a new password."
              : "Enter the mobile number on your staff account. We'll send a 6-digit code on WhatsApp."}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fp-phone">Mobile number</Label>
          <Input
            id="fp-phone"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            placeholder="98765 43210"
            value={phone}
            disabled={Boolean(sentTo)}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>
        {sentTo && (
          <>
            {notice && <p className="rounded-md bg-muted p-2.5 text-sm">{notice}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="fp-code">Code</Label>
              <Input
                id="fp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="font-mono tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fp-new">New password</Label>
              <Input id="fp-new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <p className="text-xs text-muted-foreground">At least 10 characters.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fp-confirm">Confirm new password</Label>
              <Input id="fp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={busy || (sentTo ? code.length !== 6 || !password || !confirm : !phone.trim())}
        >
          {busy && <Loader2 className="animate-spin" />}
          {sentTo ? "Set new password" : "Send code on WhatsApp"}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <Link to="/login" className="inline-flex items-center gap-1 font-medium text-primary">
            <ArrowLeft className="size-3.5" />
            Back to sign in
          </Link>
          {sentTo && (
            <button
              type="button"
              className="font-medium text-primary disabled:text-muted-foreground"
              disabled={busy || wait > 0}
              onClick={() => void sendCode()}
            >
              {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
            </button>
          )}
        </div>
        {sentTo && (
          <p className="text-xs text-muted-foreground">
            No code? Check the number, or ask an administrator to reset your password.{" "}
            <button
              type="button"
              className="font-medium text-primary"
              onClick={() => {
                setSentTo(null);
                setCode("");
                setError(null);
              }}
            >
              Change number
            </button>
          </p>
        )}
      </form>
    </AuthLayout>
  );
}
