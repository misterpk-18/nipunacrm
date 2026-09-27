import { createFileRoute } from "@tanstack/react-router";
import { Refunds } from "@/components/crm/screens";
export const Route=createFileRoute("/refunds")({head:()=>({meta:[{title:"Refunds & Cancellations — Nipuna CRM Prototype"},{name:"description",content:"Review sample refund cases with human approval."},{property:"og:title",content:"Refunds & Cancellations — Nipuna CRM"},{property:"og:description",content:"Review sample refund cases with human approval."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Refunds />});
