import { createFileRoute } from "@tanstack/react-router";
import { Student360 } from "@/components/crm/screens";
export const Route=createFileRoute("/students/$personId")({head:()=>({meta:[{title:"Student 360 — Nipuna CRM Prototype"},{name:"description",content:"Canonical synthetic student commercial and learning record."},{property:"og:title",content:"Student 360 — Nipuna CRM"},{property:"og:description",content:"Canonical synthetic student commercial and learning record."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:Student360});
