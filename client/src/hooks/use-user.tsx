import { useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";

export function useUser() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const user = data?.user ?? null;
  const unitIds = data?.unitIds ?? [];
  const units = data?.units ?? [];

  const logout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.setQueryData(["/api/auth/me"], null);
  };

  return { user, unitIds, units, isLoading, logout };
}
