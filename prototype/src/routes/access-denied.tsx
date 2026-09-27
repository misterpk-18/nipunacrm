import { createFileRoute } from "@tanstack/react-router";
import { AccessDenied } from "@/components/crm/screens";
export const Route=createFileRoute("/access-denied")({head:()=>({meta:[{title:"Access Denied — Nipuna CRM Prototype"},{name:"description",content:"Role-based access information for the CRM prototype."},{property:"og:title",content:"Access Denied — Nipuna CRM"},{property:"og:description",content:"Role-based access information for the CRM prototype."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><AccessDenied />});
