import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/api/client";

/**
 * useMutation with the app's defaults: success toast, error toast (field errors are left to the form
 * when `silentValidation` is set), and invalidation of the given query keys.
 */
export function useApiMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  options: {
    success?: string | ((result: TResult) => string);
    invalidate?: QueryKey[];
    onSuccess?: (result: TResult, vars: TVars) => void;
    onError?: (error: unknown) => void;
    silentValidation?: boolean;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      if (options.success) toast.success(typeof options.success === "function" ? options.success(result) : options.success);
      await Promise.all((options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      options.onSuccess?.(result, vars);
    },
    onError: (error) => {
      const validation = error instanceof ApiError && error.code === "VALIDATION_ERROR" && error.details;
      if (error instanceof ApiError && error.code === "FRESH_AUTH_REQUIRED") toast.error("Action cancelled — password confirmation is required");
      else if (!(validation && options.silentValidation)) toast.error(errorMessage(error));
      options.onError?.(error);
    },
  });
}
