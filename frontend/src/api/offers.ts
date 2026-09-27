/** Offer Master: versioned campaign offers, scope and complimentary courses. */
import { useQuery } from "@tanstack/react-query";
import { get, post, patch, put } from "./client";
import type { CourseRef, DateOnly, DateTime, Money } from "./types";

export const OFFER_STATUSES = [
  "Draft",
  "Configured",
  "Active",
  "Inactive",
  "Expired",
] as const;
export const OFFER_BENEFIT_TYPES = [
  "Discount Amount",
  "Discount Percent",
  "Complimentary Course",
] as const;

export type ComplimentaryCourse = CourseRef & {
  min_final_fee: Money;
  access_period_days: number | null;
};

export type Offer = {
  offer_id: number;
  offer_code: string;
  version: number;
  offer_name: string;
  description: string | null;
  status: string;
  benefit_type: string;
  discount_amount: Money | null;
  discount_percent: string | null;
  applies_to_all_branches: boolean;
  branch_ids: number[];
  applies_to_all_courses: boolean;
  courses: CourseRef[];
  complimentary_courses: ComplimentaryCourse[];
  allows_stacking: boolean;
  qualifying_payment_rule: string | null;
  valid_from: DateOnly | null;
  valid_to: DateOnly | null;
  approved_by: number | null;
  approved_at: DateTime | null;
  created_by: number | null;
  created_at: DateTime;
};

export type OfferFields = {
  offer_name?: string;
  description?: string | null;
  benefit_type?: string;
  discount_amount?: string | null;
  discount_percent?: string | null;
  allows_stacking?: boolean;
  qualifying_payment_rule?: string | null;
  valid_from?: DateOnly | null;
  valid_to?: DateOnly | null;
  status?: "Draft" | "Configured";
};

export type OfferScope = {
  applies_to_all_branches?: boolean;
  branch_ids?: number[];
  applies_to_all_courses?: boolean;
  course_ids?: number[];
};
export type ComplimentaryInput = {
  course_id: number;
  min_final_fee: string;
  access_period_days?: number | null;
};

export const offersApi = {
  list: (query: { status?: string; offer_code?: string } = {}) =>
    get<Offer[]>("/offers", query),
  get: (id: number) => get<Offer>(`/offers/${id}`),
  create: (
    body: OfferFields &
      OfferScope & {
        offer_code: string;
        complimentary_courses?: ComplimentaryInput[];
      },
  ) => post<Offer>("/offers", body),
  update: (id: number, body: OfferFields) =>
    patch<Offer>(`/offers/${id}`, body),
  newVersion: (id: number) => post<Offer>(`/offers/${id}/new-version`),
  activate: (id: number) => post<Offer>(`/offers/${id}/activate`),
  deactivate: (id: number) => post<Offer>(`/offers/${id}/deactivate`),
  setScope: (id: number, body: OfferScope) =>
    put<Offer>(`/offers/${id}/scope`, body),
  setComplimentary: (id: number, courses: ComplimentaryInput[]) =>
    put<Offer>(`/offers/${id}/complimentary-courses`, { courses }),
};

export const offerKeys = {
  all: ["offers"] as const,
  list: (query: { status?: string }) => ["offers", "list", query] as const,
  detail: (id: number) => ["offers", "detail", id] as const,
};

export const useOffers = (query: { status?: string } = {}) =>
  useQuery({
    queryKey: offerKeys.list(query),
    queryFn: () => offersApi.list(query),
  });
export const useOffer = (id: number | null) =>
  useQuery({
    queryKey: offerKeys.detail(id ?? 0),
    queryFn: () => offersApi.get(id!),
    enabled: id !== null,
  });
