import type { ReactNode } from "react";
import { AccessDenied } from "./screens";
import { useCrmScope } from "./crm-scope";

/** Prototype-only UI visibility; production API authorization remains pending. */
export function ConfigAccess({ children }: { children: ReactNode }) {
  const { role, ready } = useCrmScope();
  if (!ready) return <p className="py-12 text-center text-sm text-muted-foreground">Checking prototype role…</p>;
  if (role !== "Founder / CEO" && role !== "Super Admin") {
    return <><AccessDenied /><p className="text-center text-xs text-muted-foreground">Prototype role restriction only · production enforcement Pending Verification</p></>;
  }
  return <>{children}</>;
}