import { createFileRoute } from "@tanstack/react-router";
import { AiCopilot } from "@/components/crm/screens";
export const Route=createFileRoute("/ai-copilot")({head:()=>({meta:[{title:"AI Copilot — Nipuna CRM Prototype"},{name:"description",content:"Advisory AI grounded in synthetic CRM facts."},{property:"og:title",content:"AI Copilot — Nipuna CRM"},{property:"og:description",content:"Advisory AI grounded in synthetic CRM facts."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><AiCopilot />});
