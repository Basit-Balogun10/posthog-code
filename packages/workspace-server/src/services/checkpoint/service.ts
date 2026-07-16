import { getSessionJsonlPath } from "@posthog/agent/adapters/claude/session/jsonl-hydration";
import { truncateRunLogToCheckpoint } from "@posthog/agent/checkpoint-restore-truncation";
import { PostHogAPIClient } from "@posthog/agent/posthog-api";
import { createGitClient } from "@posthog/git/client";
import { isLocked, waitForUnlock } from "@posthog/git/lock-detector";
import {
  deleteCheckpoint,
  RevertCheckpointSaga,
} from "@posthog/git/sagas/checkpoint";
import { inject, injectable } from "inversify";
import type { AgentService } from "../agent/agent";
import type { AgentAuthAdapter } from "../agent/auth-adapter";
import { AGENT_AUTH_ADAPTER, AGENT_SERVICE } from "../agent/identifiers";
import { LOGS_SERVICE } from "../local-logs/identifiers";

export interface CheckpointRestoreInput {
  checkpointId: string;
  repoPath: string;
  taskRunId?: string;
}

export interface CheckpointRestoreResult {
  restoredSessionId?: string;
  truncationFailed: boolean;
  adapter?: "claude" | "codex";
}

/** Minimal slice of the local-logs gateway the restore re-seed needs. */
interface CheckpointLocalLogs {
  writeLocalLogs(taskRunId: string, content: string): Promise<void>;
}

/**
 * Re-exported for the existing test suite (trimReseededCacheToCheckpoint's own
 * unit tests import it from here). The implementation now lives in
 * `@posthog/agent/checkpoint-restore-truncation` so the cloud-origin restore
 * path (running inside the sandbox, which cannot import workspace-server) can
 * share it instead of duplicating the survivor-marker defensive logic.
 */
export { trimReseededCacheToCheckpoint } from "@posthog/agent/checkpoint-restore-truncation";

/**
 * Restores a session to a git checkpoint: reverts working-tree files, truncates
 * the S3 log + local cache + agent memory to the checkpoint boundary, cleans up
 * orphaned checkpoint refs, and restarts the agent so it reconnects with memory
 * bounded to the restored turn.
 *
 * Runs in the host (main) process: it drives git/fs directly and reaches the
 * agent runtime + local-log cache through the injected AgentService and
 * local-logs gateway. Exposed to the renderer via the host-router checkpoint
 * router (this.d.trpc.checkpoint on the session service).
 */
/**
 * How long the restore waits for a busy `.git/index.lock` to clear before giving
 * up. A normal reset/read-tree releases the lock in well under a second, and a
 * turn's checkpoint capture works off a temp index (so it never holds this lock),
 * so a lock present here is almost always a brief external touch (editor, hook).
 * 15s comfortably covers those without hanging the UI if something is truly stuck.
 */
const RESTORE_INDEX_LOCK_WAIT_MS = 15_000;

/**
 * How many times to retry the revert when it fails specifically because an
 * external holder grabbed `.git/index.lock` mid-operation. A pre-flight wait
 * can't cover this (a holder can appear after the check but before the reset —
 * check-then-act), so we retry the operation itself, waiting for the lock to
 * clear between attempts. Bounded so a genuinely stuck lock still surfaces a
 * clear, retryable error instead of hanging.
 */
const RESTORE_INDEX_LOCK_MAX_RETRIES = 3;

/**
 * True when a git error is the transient `.git/index.lock` contention failure
 * (another process held the index lock when reset/read-tree tried to acquire it).
 * Git fails at lock-acquisition, before mutating anything, so the revert is safe
 * to retry once the lock clears.
 */
function isIndexLockError(message: string | undefined): boolean {
  if (!message) return false;
  return /index\.lock|Unable to create .*\.lock|File exists/i.test(message);
}

@injectable()
export class CheckpointService {
  // Guards against concurrent restores for the same session. Two restores racing
  // would truncate logs.ndjson + the rollout at different offsets and corrupt
  // both. Keyed by taskRunId (falling back to repoPath when there is no run).
  private readonly restoreInFlight = new Set<string>();

  constructor(
    @inject(AGENT_SERVICE)
    private readonly agentService: AgentService,
    @inject(AGENT_AUTH_ADAPTER)
    private readonly authAdapter: AgentAuthAdapter,
    @inject(LOGS_SERVICE)
    private readonly logs: CheckpointLocalLogs,
  ) {}

  /**
   * Re-emit stored checkpoint notifications for a session through the existing
   * SessionEvent channel so the renderer receives them after a reconnect.
   */
  replayCheckpoints(taskRunId: string): { count: number } {
    return { count: this.agentService.replayCheckpoints(taskRunId) };
  }

  async restore(
    input: CheckpointRestoreInput,
  ): Promise<CheckpointRestoreResult> {
    const lockKey = input.taskRunId ?? input.repoPath;
    if (this.restoreInFlight.has(lockKey)) {
      throw new Error(
        "A checkpoint restore is already in progress for this session. Please wait for it to finish.",
      );
    }
    this.restoreInFlight.add(lockKey);
    try {
      return await this.runRestore(input);
    } finally {
      this.restoreInFlight.delete(lockKey);
    }
  }

  private apiClientFor(info: {
    apiHost: string;
    projectId: number;
  }): PostHogAPIClient {
    return new PostHogAPIClient(
      this.authAdapter.createPosthogConfig({
        apiHost: info.apiHost,
        projectId: info.projectId,
      }),
    );
  }

  /**
   * Performs the actual checkpoint restore. Returns `truncationFailed: true` when
   * any log/rollout truncation step errored. The git revert still succeeded in
   * that case, but the agent may keep memory past the checkpoint, so the renderer
   * surfaces a warning to the user.
   */
  private async runRestore(
    input: CheckpointRestoreInput,
  ): Promise<CheckpointRestoreResult> {
    // 1. Revert git files to checkpoint state, retrying on `.git/index.lock`
    // contention. RevertCheckpointSaga's reset/read-tree acquire `.git/index.lock`,
    // and git fails hard ("Unable to create '.git/index.lock': File exists") if
    // anything else holds it at that instant — a git hook, the user's own editor/
    // terminal touching the same working tree, or a just-finishing operation.
    // That failure is transient (the lock clears in seconds) and happens at lock-
    // acquisition BEFORE git mutates anything, so the revert is safe to retry.
    // A pre-flight wait alone can't cover it: a holder can appear after the check
    // but before the reset (check-then-act race), which is why an earlier
    // pre-check-only guard still hit the error. So we wait for the lock to clear,
    // attempt the revert, and on a lock-specific failure wait + retry, bounded.
    // (Deliberately NOT auto-removing the lock: a live git process may hold it,
    // and force-deleting a live lock risks index corruption.)
    const saga = new RevertCheckpointSaga();
    let result: Awaited<ReturnType<typeof saga.run>> | undefined;
    for (let attempt = 0; ; attempt++) {
      // Give any current holder a chance to release before attempting.
      if (await isLocked(input.repoPath)) {
        await waitForUnlock(input.repoPath, RESTORE_INDEX_LOCK_WAIT_MS);
      }
      result = await saga.run({
        baseDir: input.repoPath,
        checkpointId: input.checkpointId,
      });
      if (result.success) break;

      const lockBusy = isIndexLockError(result.error);
      if (lockBusy && attempt < RESTORE_INDEX_LOCK_MAX_RETRIES) {
        // A holder raced us mid-operation; wait for it to clear, then retry.
        await waitForUnlock(input.repoPath, RESTORE_INDEX_LOCK_WAIT_MS);
        continue;
      }
      if (lockBusy) {
        throw new Error(
          "The repository's git index is busy — another git operation is still in progress. Wait a moment and try the restore again.",
        );
      }
      throw new Error(result.error ?? "Failed to revert checkpoint");
    }

    // 2. Truncate logs, clean up orphaned refs, and restart the agent.
    // Everything here is non-fatal: git files were already reverted.
    let restoredSessionId: string | undefined;
    // The live session's adapter (codex/claude), read before cancelSession kills it.
    // Returned so the renderer reconnects on the SAME runtime instead of trusting its
    // own stale session.adapter (which can default to "claude" for handed-off tasks).
    let restoredAdapter: "claude" | "codex" | undefined;
    // Tracks whether any truncation step failed, so the renderer can warn that
    // the restore was partial (agent memory may extend past the checkpoint).
    let truncationFailed = false;
    if (input.taskRunId) {
      try {
        const info = this.agentService.getSessionInfo(input.taskRunId);
        if (info) {
          restoredSessionId = info.sessionId;
          restoredAdapter = info.adapter;
          const apiClient = this.apiClientFor(info);

          // Checkpoints that must NOT have their git refs deleted: the restore
          // target is always a survivor; the rest are filled from the in-memory
          // map and the truncated log below. The backend's orphan list can wrongly
          // include survivors after a handoff (scrambled S3 log), and deleting a
          // survivor's ref makes that turn un-restorable ("Checkpoint not found").
          const survivorCheckpointIds = new Set<string>(
            this.agentService.getSurvivingCheckpointIds(
              input.taskRunId,
              input.checkpointId,
            ),
          );
          const survivingEntries =
            this.agentService.getSurvivingCheckpointEntries(
              input.taskRunId,
              input.checkpointId,
            );

          // Truncate S3 + local cache BEFORE cancelling the session.
          // cancelSession triggers reconnect; if reconnect reads local cache
          // before truncation, the stale full history would be loaded.
          let idsToDelete: string[] = [];
          try {
            const truncateResult = await truncateRunLogToCheckpoint({
              apiClient,
              taskId: info.taskId,
              runId: input.taskRunId,
              checkpointId: input.checkpointId,
              survivorCheckpointIds,
              survivingEntries,
            });
            idsToDelete = truncateResult.idsToDelete;

            // Re-seed the local logs.ndjson cache from the (now truncated, with any
            // dropped survivor markers re-appended) S3 run log. The cache is a live
            // append-mirror that, after a cloud→local handoff, was overwritten
            // wholesale with the cloud log (handoff seedLocalLogs) and so lacks the
            // pre-handoff checkpoint marker — a marker-based local trim can't cut at
            // the restore point. Reload reads this cache first, so without re-seeding
            // it the restore-truncated turns reappear on reload. Non-fatal: git files
            // are already reverted; a failure only means reload may show stale turns
            // or a disabled survivor icon.
            if (truncateResult.truncatedLog) {
              await this.logs.writeLocalLogs(
                input.taskRunId,
                truncateResult.truncatedLog,
              );
            }
          } catch {
            truncationFailed = true;
          }

          // Clean up git refs for orphaned checkpoints — but NEVER delete a
          // surviving checkpoint or the restore target. The backend's orphan list
          // is computed from the S3 log, which after a handoff mixes pre/post-handoff
          // checkpoints and can over-include survivors (even the restore target).
          // Deleting a survivor's ref is what made earlier turns un-restorable
          // ("Checkpoint not found"). A leftover orphan ref is benign, so over-
          // deletion is the only harmful direction — when in doubt, keep.
          if (idsToDelete.length > 0) {
            const git = createGitClient(input.repoPath);
            await Promise.all(
              idsToDelete.map((id) =>
                deleteCheckpoint(git, id).catch(() => {}),
              ),
            );
          }

          // Trim in-memory checkpoints so replayCheckpoints only re-emits
          // survivors — must happen before cancelSession triggers reconnect.
          this.agentService.truncateCheckpoints(
            input.taskRunId,
            input.checkpointId,
          );

          // Mark this taskRunId so the reconnect rebuilds agent memory bounded to
          // the checkpoint: Claude force-refetches the truncated S3 into its JSONL;
          // Codex (no JSONL hydration) starts a FRESH session seeded with a context
          // summary of the truncated conversation. Must be set before cancelSession
          // triggers the reconnect.
          this.agentService.markCheckpointRestore(input.taskRunId);

          // Cancel the session — the renderer reconnects and rebuilds bounded memory.
          await this.agentService.cancelSession(input.taskRunId);

          // Codex needs no on-disk rollout truncation here: the reconnect abandons
          // the stale rollout (fresh session) and injects a bounded summary. A
          // turn-count truncation couldn't strip history embedded inside the handoff
          // summary turn anyway, so it's both unnecessary and insufficient.
          if (info.adapter === "claude") {
            // Delete the stale local Claude JSONL so the SDK doesn't read full
            // conversation history before hydrateSessionJsonl re-fetches the
            // truncated version from S3. This fixes a race where an immediate
            // page-reload after restore causes the agent to remember turns that
            // should have been forgotten. Non-fatal if the file is already gone.
            const jsonlPath = getSessionJsonlPath(
              info.sessionId,
              info.repoPath,
            );
            try {
              const { unlink } = await import("node:fs/promises");
              await unlink(jsonlPath);
            } catch (err: unknown) {
              // ENOENT is fine — file may already be absent
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== "ENOENT") {
                // Non-fatal: hydrateSessionJsonl still re-fetches the truncated log.
              }
            }
          }
        }
      } catch {
        truncationFailed = true;
      }
    }

    return { restoredSessionId, truncationFailed, adapter: restoredAdapter };
  }
}
