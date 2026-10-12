import type { FeeValidity as Validity } from "@/api/fees";
import { Status } from "@/components/crm/ui";

/** "Valid 5 more days" / "Valid 1 more day" / "Expired 2 days ago" for a fee version; nothing once it is superseded or invoiced.
 *  Also used on the deal (Lead 360) next to the fee discussion's current version. */
export function FeeValidity({ validity }: { validity: Validity | null | undefined }) {
  if (!validity?.label) return null;
  const kind = validity.state === "expired" ? "danger" : validity.state === "expiring" ? "warn" : "good";
  return <Status kind={kind}>{validity.label}</Status>;
}
