import { createFileRoute } from "@tanstack/react-router";
import { Login } from "@/components/crm/screens";
export const Route=createFileRoute("/")({head:()=>({meta:[{title:"Sign In — Nipuna CRM Prototype"},{name:"description",content:"Enter the sample-only Nipuna CRM interactive prototype."},{property:"og:title",content:"Nipuna CRM Interactive Prototype"},{property:"og:description",content:"Sample-only CRM experience for Nipuna Technologies."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:Login});
