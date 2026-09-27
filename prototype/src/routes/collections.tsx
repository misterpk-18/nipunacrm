import { createFileRoute } from "@tanstack/react-router";
import { Collections } from "@/components/crm/screens";
export const Route=createFileRoute("/collections")({head:()=>({meta:[{title:"Collections — Nipuna CRM Prototype"},{name:"description",content:"Prioritize sample student collections."},{property:"og:title",content:"Collections — Nipuna CRM"},{property:"og:description",content:"Prioritize sample student collections."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]}),component:()=><Collections />});
