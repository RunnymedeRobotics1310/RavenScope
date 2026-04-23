import { useQuery } from "@tanstack/react-query"
import { fetchMe, type UserMeResponse } from "./api"

export function useMe() {
  return useQuery<UserMeResponse | null>({
    queryKey: ["me"],
    queryFn: fetchMe,
    retry: false,
    staleTime: 60_000,
  })
}
