import { createFileRoute } from "@tanstack/react-router";
import { AiCopilot } from "@/components/crm/screens";
export const Route=createFileRoute("/ask-nipuna")({head:()=>({meta:[{title:"Ask Nipuna — Nipuna CRM Prototype"},{name:"description",content:"Sample-data management analytics assistant."},{property:"og:title",content:"Ask Nipuna — Nipuna CRM"},{property:"og:description",content:"Sample-data management analytics assistant."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><AiCopilot ask />});
