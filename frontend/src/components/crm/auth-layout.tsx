/** The brand panel + centred card used by the public sign-in screens (login, forgot password). */
import type { ReactNode } from "react";
import { Check } from "lucide-react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.15fr_.85fr]">
      <div className="hidden bg-sidebar p-12 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div>
          <img src="/nipuna-logo.png" alt="Nipuna Technologies" className="h-16 w-auto" />
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
            <img src="/nipuna-logo.png" alt="Nipuna Technologies" className="h-12 w-auto" />
            <h1 className="mt-3 text-2xl font-semibold">Nipuna CRM</h1>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
