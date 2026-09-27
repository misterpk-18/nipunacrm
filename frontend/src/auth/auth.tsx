/**
 * Session state: the current profile (/auth/me), login / logout, the branch the user is viewing,
 * and the fresh-auth password prompt used by sensitive actions.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi, type Profile } from "@/api/auth";
import { errorMessage, getToken, registerAuthHandlers, setToken } from "@/api/client";
import type { BranchRef, RoleCode } from "@/api/types";
import { ADMIN_ROLES, COUNSELLOR_ROLES } from "./access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const BRANCH_KEY = "nipuna-branch";

type AuthContextValue = {
  status: "anonymous" | "loading" | "authenticated";
  profile: Profile | null;
  roles: RoleCode[];
  isAdmin: boolean;
  isCounsellor: boolean;
  isManager: boolean;
  hasRole: (...roles: RoleCode[]) => boolean;
  /** Branches the user may view; a single entry means the branch is locked. */
  branches: BranchRef[];
  /** Selected branch filter (null = all allowed branches). */
  branchId: number | null;
  setBranchId: (id: number | null) => void;
  login: (email: string, password: string) => Promise<Profile>;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readBranch(): number | null {
  try {
    const value = window.sessionStorage.getItem(BRANCH_KEY);
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children, onSignedOut }: { children: ReactNode; onSignedOut: () => void }) {
  const queryClient = useQueryClient();
  const [hasToken, setHasToken] = useState(() => Boolean(getToken()));
  const [branchId, setBranchState] = useState<number | null>(readBranch);
  const [freshAuth, setFreshAuth] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const me = useQuery({ queryKey: ["me"], queryFn: authApi.me, enabled: hasToken, staleTime: 5 * 60_000, retry: false });

  const clearSession = useCallback(() => {
    setToken(null);
    setHasToken(false);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    registerAuthHandlers({
      unauthenticated: () => {
        clearSession();
        signedOut.current();
      },
      freshAuthRequired: () => new Promise<boolean>((resolve) => setFreshAuth({ resolve })),
      passwordChangeRequired: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
  }, [clearSession, queryClient]);

  const profile = hasToken ? (me.data ?? null) : null;
  const roles = useMemo(() => [...new Set(profile?.scopes.map((s) => s.role_code) ?? [])], [profile]);
  const branches = profile?.allowed_branches ?? [];
  const effectiveBranch = branches.length === 1 ? branches[0]!.branch_id : branches.some((b) => b.branch_id === branchId) ? branchId : null;

  const value = useMemo<AuthContextValue>(() => {
    const hasRole = (...wanted: RoleCode[]) => wanted.some((r) => roles.includes(r));
    return {
      status: !hasToken ? "anonymous" : profile ? "authenticated" : "loading",
      profile,
      roles,
      isAdmin: hasRole(...ADMIN_ROLES),
      isCounsellor: hasRole(...COUNSELLOR_ROLES),
      isManager: hasRole("BRANCH_MANAGER"),
      hasRole,
      branches,
      branchId: effectiveBranch,
      setBranchId: (id) => {
        setBranchState(id);
        try {
          if (id) window.sessionStorage.setItem(BRANCH_KEY, String(id));
          else window.sessionStorage.removeItem(BRANCH_KEY);
        } catch {
          /* ignore */
        }
      },
      login: async (email, password) => {
        const result = await authApi.login(email, password);
        setToken(result.token);
        const { token: _token, expires_at: _expires, ...rest } = result;
        queryClient.setQueryData(["me"], rest);
        setHasToken(true);
        return rest;
      },
      logout: async () => {
        try {
          await authApi.logout();
        } finally {
          clearSession();
        }
      },
      refresh: () => me.refetch(),
    };
  }, [branches, clearSession, effectiveBranch, hasToken, me, profile, queryClient, roles]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <FreshAuthDialog
        open={Boolean(freshAuth)}
        onDone={(ok) => {
          freshAuth?.resolve(ok);
          setFreshAuth(null);
        }}
      />
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

/** The branch filter to send with list requests (undefined = all branches the user can see). */
export function useBranchFilter(): number | undefined {
  return useAuth().branchId ?? undefined;
}

function FreshAuthDialog({ open, onDone }: { open: boolean; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await authApi.reauthenticate(password);
      onDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDone(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm your password</DialogTitle>
          <DialogDescription>This action needs a recent sign-in. Enter your password to continue.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-2"
        >
          <Label htmlFor="fresh-auth-password">Password</Label>
          <Input id="fresh-auth-password" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onDone(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || busy}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
