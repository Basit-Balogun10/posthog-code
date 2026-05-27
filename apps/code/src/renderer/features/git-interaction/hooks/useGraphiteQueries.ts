import { useTRPC } from "@renderer/trpc";
import { useQuery } from "@tanstack/react-query";

export function useGraphiteQueries(repoPath?: string) {
  const trpc = useTRPC();

  const { data: gtStatus } = useQuery(
    trpc.graphite.getGtStatus.queryOptions(undefined, {
      enabled: !!repoPath,
      staleTime: 60_000 * 5,
    }),
  );

  const gtInstalled = gtStatus?.installed ?? false;

  const { data: isGraphiteRepo = false } = useQuery(
    trpc.graphite.isGraphiteRepo.queryOptions(
      { directoryPath: repoPath as string },
      {
        enabled: !!repoPath && gtInstalled,
        staleTime: 30_000,
      },
    ),
  );

  const { data: stack } = useQuery(
    trpc.graphite.getStack.queryOptions(
      { directoryPath: repoPath as string },
      {
        enabled: !!repoPath && gtInstalled && isGraphiteRepo,
        staleTime: 30_000,
      },
    ),
  );

  return {
    gtInstalled,
    isGraphiteRepo: gtInstalled && isGraphiteRepo,
    stack: stack ?? null,
  };
}
