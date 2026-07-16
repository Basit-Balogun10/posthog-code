import {
  SESSION_SERVICE,
  type SessionService,
} from "@posthog/core/sessions/sessionService";
import { sessionStoreSetters } from "@posthog/core/sessions/sessionStore";
import { useService } from "@posthog/di/react";
import { toast } from "@posthog/ui/primitives/toast";
import { useCallback, useState } from "react";

interface UseRestoreCheckpointOptions {
  repoPath: string | undefined;
  taskId: string | undefined;
  taskRunId: string | undefined;
}

export function useRestoreCheckpoint({
  repoPath,
  taskId,
  taskRunId,
}: UseRestoreCheckpointOptions) {
  const sessionService = useService<SessionService>(SESSION_SERVICE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingCheckpointId, setPendingCheckpointId] = useState<string | null>(
    null,
  );
  const [isRestoring, setIsRestoring] = useState(false);

  const requestRestore = useCallback(
    (checkpointId: string) => {
      // Don't let a new restore race the previous one's reconnect (the agent is
      // mid-respawn and can't accept the resume yet).
      const session = taskId
        ? sessionStoreSetters.getSessionByTaskId(taskId)
        : undefined;
      if (session?.isReconnecting) {
        toast.info("Hang on — finishing the previous restore.");
        return;
      }
      setPendingCheckpointId(checkpointId);
      setDialogOpen(true);
    },
    [taskId],
  );

  const confirmRestore = useCallback(async () => {
    const session = taskId
      ? sessionStoreSetters.getSessionByTaskId(taskId)
      : undefined;

    // repoPath is only required for the local restore path — a cloud-only
    // session can legitimately have no local repoPath at all (see
    // packages/core/src/task-detail/taskInput.ts). The cloud command path
    // (sessionService.restoreCheckpoint → restoreCloudCheckpoint) never
    // touches it.
    if (!pendingCheckpointId || (!repoPath && !session?.isCloud)) return;

    setIsRestoring(true);
    try {
      // If the agent is mid-response (restoring a PAST turn while the current one
      // is still streaming), stop it first — restore rewinds the code and history
      // to this checkpoint, so letting the in-flight turn keep streaming would
      // race the restore and leak output past the restore point. Mirrors the stop
      // button / Esc. Best-effort: the turn can finish between this check and the
      // call, so a no-op/failed cancel must never block the restore.
      if (taskId && session?.isPromptPending) {
        await sessionService.cancelPrompt(taskId).catch(() => {});
      }
      const restoreResult = await sessionService.restoreCheckpoint({
        checkpointId: pendingCheckpointId,
        repoPath,
        taskRunId,
      });
      let liveViewStale = false;
      if (taskId) {
        // Trim the live in-memory transcript to the restored checkpoint. Returns
        // false when the checkpoint's GIT_CHECKPOINT marker isn't present in the
        // live events (can happen for some cloud-origin checkpoints whose marker
        // only exists in the persisted log, not the in-memory stream). In that
        // case there's nothing to trim in place — the backend log + local cache
        // are still truncated correctly, so the view fully reconciles on the next
        // reload. Surface it instead of silently leaving stale turns on screen.
        liveViewStale = !sessionStoreSetters.truncateEventsToCheckpoint(
          taskId,
          pendingCheckpointId,
        );
        if (liveViewStale) {
          console.warn(
            "[restore] live event trim skipped — checkpoint marker not in live events; view will reconcile on reload",
            { taskId, checkpointId: pendingCheckpointId },
          );
        }
        // Reconnect the agent, resuming the same Codex/Claude session so the
        // agent has memory only up to the restored checkpoint. Cloud sessions
        // skip this: the sandbox tears down and rebuilds its own agent session
        // in-process (agent-server.ts handleRestoreCheckpoint), and the live
        // view reconciles reactively off the RESTORE_COMPLETE notification
        // (see sessionService.handleSessionEvent) instead of an explicit
        // desktop-driven reconnect call.
        if (!session?.isCloud && repoPath) {
          sessionService
            .restoreCheckpointReconnect(
              taskId,
              repoPath,
              restoreResult?.restoredSessionId,
              restoreResult?.adapter,
            )
            .catch(() => {});
        }
      }
      if (restoreResult?.truncationFailed) {
        toast.warning(
          "Checkpoint restored, but trimming the agent's history failed — it may still remember messages after this point.",
        );
      } else if (liveViewStale) {
        toast.info(
          "Checkpoint restored. Reload the task to fully refresh the conversation view.",
        );
      } else {
        toast.success("Checkpoint restored successfully");
      }
      setDialogOpen(false);
      setPendingCheckpointId(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to restore checkpoint";
      toast.error(message);
    } finally {
      setIsRestoring(false);
    }
  }, [pendingCheckpointId, repoPath, taskId, taskRunId, sessionService]);

  const cancelRestore = useCallback(() => {
    setDialogOpen(false);
    setPendingCheckpointId(null);
  }, []);

  return {
    dialogOpen,
    setDialogOpen,
    isRestoring,
    requestRestore,
    confirmRestore,
    cancelRestore,
  };
}
