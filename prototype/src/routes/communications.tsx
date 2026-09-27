import { createFileRoute } from "@tanstack/react-router";
import { Communications } from "@/components/crm/screens";
export const Route=createFileRoute("/communications")({head:()=>({meta:[{title:"Communications — Nipuna CRM Prototype"},{name:"description",content:"Unified sample communication inbox."},{property:"og:title",content:"Communications — Nipuna CRM"},{property:"og:description",content:"Unified sample communication inbox."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Communications />});
