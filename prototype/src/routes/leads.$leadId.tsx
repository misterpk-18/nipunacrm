import { createFileRoute } from "@tanstack/react-router";
import { Lead360 } from "@/components/crm/screens";
export const Route=createFileRoute("/leads/$leadId")({head:()=>({meta:[{title:"Lead 360 — Nipuna CRM Prototype"},{name:"description",content:"Complete synthetic lead history and advisory AI."},{property:"og:title",content:"Lead 360 — Nipuna CRM"},{property:"og:description",content:"Complete synthetic lead history and advisory AI."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:Lead360});
