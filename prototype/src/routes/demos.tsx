import { createFileRoute } from "@tanstack/react-router";
import { Demos } from "@/components/crm/screens";
export const Route=createFileRoute("/demos")({head:()=>({meta:[{title:"Demo Management — Nipuna CRM Prototype"},{name:"description",content:"Schedule and track sample course demos."},{property:"og:title",content:"Demo Management — Nipuna CRM"},{property:"og:description",content:"Schedule and track sample course demos."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Demos />});
