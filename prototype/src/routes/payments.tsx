import { createFileRoute } from "@tanstack/react-router";
import { Payments } from "@/components/crm/screens";
export const Route=createFileRoute("/payments")({head:()=>({meta:[{title:"Payments & Receipts — Nipuna CRM Prototype"},{name:"description",content:"Record sample payments in an immutable ledger."},{property:"og:title",content:"Payments & Receipts — Nipuna CRM"},{property:"og:description",content:"Record sample payments in an immutable ledger."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Payments />});
