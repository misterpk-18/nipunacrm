import { createFileRoute } from "@tanstack/react-router";
import { Tasks } from "@/components/crm/screens";
export const Route=createFileRoute("/tasks")({head:()=>({meta:[{title:"Tasks — Nipuna CRM Prototype"},{name:"description",content:"Manage sample follow-up and operational tasks."},{property:"og:title",content:"Tasks — Nipuna CRM"},{property:"og:description",content:"Manage sample follow-up and operational tasks."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Tasks />});
