import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Branch } from "@/lib/crm-data";

export type PrototypeRole =
  | "Founder / CEO"
  | "Super Admin"
  | "Guntur Branch Manager"
  | "Vijayawada Branch Manager"
  | "Guntur Sales"
  | "Vijayawada Sales"
  | "Guntur Front Office"
  | "Vijayawada Front Office"
  | "Guntur Accounts"
  | "Vijayawada Accounts"
  | "Guntur Academic Coordinator"
  | "Vijayawada Academic Coordinator"
  | "Guntur Trainer"
  | "Vijayawada Trainer"
  | "Guntur Placement Team"
  | "Vijayawada Placement Team"
  | "Guntur HR"
  | "Vijayawada HR"
  | "Guntur Student"
  | "Vijayawada Student";

const roles: PrototypeRole[] = [
  "Founder / CEO",
  "Super Admin",
  "Guntur Branch Manager",
  "Vijayawada Branch Manager",
  "Guntur Sales",
  "Vijayawada Sales",
  "Guntur Front Office",
  "Vijayawada Front Office",
  "Guntur Accounts",
  "Vijayawada Accounts",
  "Guntur Academic Coordinator",
  "Vijayawada Academic Coordinator",
  "Guntur Trainer",
  "Vijayawada Trainer",
  "Guntur Placement Team",
  "Vijayawada Placement Team",
  "Guntur HR",
  "Vijayawada HR",
  "Guntur Student",
  "Vijayawada Student",
];

function assignedBranch(role: PrototypeRole): Branch | null {
  if (role.startsWith("Guntur")) return "Guntur";
  if (role.startsWith("Vijayawada")) return "Vijayawada";
  return null;
}

type ScopeContext = {
  role: PrototypeRole;
  roles: PrototypeRole[];
  branch: Branch;
  allowedBranches: Branch[];
  isCounsellor: boolean;
  isManager: boolean;
  ready: boolean;
  setRole: (role: PrototypeRole) => void;
  setBranch: (branch: Branch) => void;
};

const CrmScopeContext = createContext<ScopeContext | null>(null);

export function CrmScopeProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<PrototypeRole>("Founder / CEO");
  const [globalBranch, setGlobalBranch] = useState<Branch>("All Branches");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const savedRole = window.sessionStorage.getItem("nipuna-prototype-role");
    if (roles.some((candidate) => candidate === savedRole)) setRoleState(savedRole as PrototypeRole);
    const savedBranch = window.sessionStorage.getItem("nipuna-prototype-branch");
    if (savedBranch === "All Branches" || savedBranch === "Guntur" || savedBranch === "Vijayawada") setGlobalBranch(savedBranch);
    setReady(true);
  }, []);
  const lockedBranch = assignedBranch(role);
  const branch = lockedBranch ?? globalBranch;

  const value = useMemo<ScopeContext>(
    () => ({
      role,
      roles,
      branch,
      allowedBranches: lockedBranch ? [lockedBranch] : ["All Branches", "Guntur", "Vijayawada"],
      isCounsellor: role.endsWith("Sales") || role.endsWith("Front Office"),
      isManager: role.endsWith("Branch Manager"),
      ready,
      setRole: (nextRole) => {
        setRoleState(nextRole);
        window.sessionStorage.setItem("nipuna-prototype-role", nextRole);
      },
      setBranch: (nextBranch) => {
        if (!lockedBranch) {
          setGlobalBranch(nextBranch);
          window.sessionStorage.setItem("nipuna-prototype-branch", nextBranch);
        }
      },
    }),
    [branch, globalBranch, lockedBranch, ready, role],
  );

  return <CrmScopeContext.Provider value={value}>{children}</CrmScopeContext.Provider>;
}

export function useCrmScope() {
  const context = useContext(CrmScopeContext);
  if (!context) throw new Error("useCrmScope must be used within CrmScopeProvider");
  return context;
}

export function roleHome(role: PrototypeRole) {
  if (role.endsWith("Sales") || role.endsWith("Front Office")) return "/counsellor" as const;
  if (role.endsWith("Branch Manager")) return "/branch-manager" as const;
  return "/dashboard" as const;
}
