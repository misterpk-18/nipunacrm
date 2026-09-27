import { createFileRoute } from "@tanstack/react-router";
import { Pipeline } from "@/components/crm/screens";
export const Route=createFileRoute("/pipeline")({head:()=>({meta:[{title:"Sales Pipeline — Nipuna CRM Prototype"},{name:"description",content:"Sample lead pipeline in Kanban and table views."},{property:"og:title",content:"Sales Pipeline — Nipuna CRM"},{property:"og:description",content:"Sample lead pipeline in Kanban and table views."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Pipeline />});
