import { createFileRoute } from "@tanstack/react-router";
import { Leads } from "@/components/crm/screens";
export const Route=createFileRoute("/counsellor")({head:()=>({meta:[{title:"Counsellor Workspace — Nipuna CRM Prototype"},{name:"description",content:"Mobile-ready sample lead queue and follow-ups."},{property:"og:title",content:"Counsellor Workspace — Nipuna CRM"},{property:"og:description",content:"Mobile-ready sample lead queue and follow-ups."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Leads workspace />});
