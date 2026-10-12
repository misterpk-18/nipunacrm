import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { feeKeys, feesApi } from "@/api/fees";

/** Live "does this extra concession need approval, and from whom" while the counsellor types (debounced). */
export function usePricePreview(discussionId: number, offerId: number | null, extra: string) {
  const [settled, setSettled] = useState(extra);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(extra), 300);
    return () => clearTimeout(timer);
  }, [extra]);
  const amount = Number(settled || 0);
  return useQuery({
    queryKey: feeKeys.pricePreview(discussionId, offerId, String(amount)),
    queryFn: () => feesApi.pricePreview(discussionId, { offer_id: offerId, extra: String(amount) }),
    enabled: Number.isFinite(amount) && amount >= 0,
    placeholderData: (previous) => previous,
    retry: false,
  });
}
