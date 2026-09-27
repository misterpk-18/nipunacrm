import { createFileRoute } from "@tanstack/react-router";
import { Admission } from "@/components/crm/screens";
export const Route=createFileRoute("/admissions/new")({head:()=>({meta:[{title:"Create Admission — Nipuna CRM Prototype"},{name:"description",content:"Create a sample admission with duplicate checks."},{property:"og:title",content:"Create Admission — Nipuna CRM"},{property:"og:description",content:"Create a sample admission with duplicate checks."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Admission />});
