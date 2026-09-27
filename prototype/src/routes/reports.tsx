import { createFileRoute } from "@tanstack/react-router";
import { Reports } from "@/components/crm/screens";
export const Route=createFileRoute("/reports")({head:()=>({meta:[{title:"Reports — Nipuna CRM Prototype"},{name:"description",content:"Sample CRM analytics and drilldowns."},{property:"og:title",content:"Reports — Nipuna CRM"},{property:"og:description",content:"Sample CRM analytics and drilldowns."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Reports />});
