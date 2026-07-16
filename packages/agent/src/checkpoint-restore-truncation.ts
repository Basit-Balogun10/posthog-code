import { POSTHOG_NOTIFICATIONS } from "./acp-extensions";
import type { PostHogAPIClient } from "./posthog-api";
import type { StoredEntry } from "./types";

/** Serialize stored log entries back to newline-delimited JSON. */
export function entriesToNdjson(entries: StoredEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/**
 * Trim a re-seeded logs.ndjson cache to the restore target's turn, keyed off the
 * checkpoint marker's TIMESTAMP rather than its line position or promptId.
 *
 * Why timestamp: after a local→cloud→local round-trip the pre-handoff checkpoint
 * markers are re-appended to the END of the run log (handoff `uploadPriorLocal-
 * Checkpoints`), so a pre-handoff checkpoint's marker is no longer in chronological
 * line order — the backend's checkpoint-id truncation and a line-position trim both
 * no-op (observed: 119→119 lines). promptId is also unusable: it collides across
 * the two session numbering spaces (observed: two distinct checkpoints both pid=2).
 * The marker keeps its ORIGINAL timestamp through the re-append, and every log entry
 * carries an ISO-8601 `…Z` timestamp (lexicographically == chronologically sortable),
 * so the marker's timestamp is a stable, handoff-safe boundary.
 *
 * Keeps entries with `timestamp <= boundary` plus the target marker itself (its
 * re-appended copy may carry a fresh restore-time timestamp). Returns null when the
 * target marker can't be located (caller leaves the cache as-is).
 */
export function trimReseededCacheToCheckpoint(
  logText: string,
  checkpointId: string,
): string | null {
  const lines = logText.split("\n").filter((l) => l.trim());
  const isTargetMarker = (parsed: {
    notification?: { method?: string; params?: { checkpointId?: string } };
  }): boolean =>
    parsed.notification?.method === POSTHOG_NOTIFICATIONS.GIT_CHECKPOINT &&
    parsed.notification.params?.checkpointId === checkpointId;

  // Boundary = the target checkpoint's TURN-completion time. Prefer the
  // `turnCompletedAt` carried in the marker's params: it's the true turn boundary
  // and is stable across the S3 round-trip and the restore-time re-append. Only
  // when no target marker carries it (pre-fix or cloud-registered checkpoints) do
  // we fall back to the earliest marker ENTRY timestamp — which is
  // capture-completion time and therefore keeps later turns when the snapshot
  // outlives the next prompt, but preserves prior behavior for older logs.
  let turnBoundaryTs: string | null = null;
  let markerTs: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        notification?: {
          method?: string;
          params?: { checkpointId?: string; turnCompletedAt?: string };
        };
      };
      if (!isTargetMarker(parsed)) continue;
      const tca = parsed.notification?.params?.turnCompletedAt;
      if (tca && (turnBoundaryTs === null || tca < turnBoundaryTs)) {
        turnBoundaryTs = tca;
      }
      // EARLIEST marker occurrence (the original, not a restore-time re-append
      // which sorts later).
      if (
        parsed.timestamp &&
        (markerTs === null || parsed.timestamp < markerTs)
      ) {
        markerTs = parsed.timestamp;
      }
    } catch {
      // skip unparseable lines
    }
  }
  const boundaryTs = turnBoundaryTs ?? markerTs;
  if (boundaryTs === null) return null;

  const kept: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        notification?: {
          method?: string;
          params?: { checkpointId?: string; turnCompletedAt?: string };
        };
      };
      // For a GIT_CHECKPOINT marker, compare by its TURN boundary
      // (params.turnCompletedAt), not its entry timestamp: captures are async and
      // land late, so an EARLIER surviving turn's marker can have an entry
      // timestamp past the boundary even though its turn completed before it.
      // Comparing by the entry timestamp would drop that survivor's marker,
      // leaving the (kept) turn with a "no checkpoint captured" icon. Non-marker
      // entries compare by their own timestamp as before.
      const isMarker =
        parsed.notification?.method === POSTHOG_NOTIFICATIONS.GIT_CHECKPOINT;
      const effectiveTs = isMarker
        ? (parsed.notification?.params?.turnCompletedAt ?? parsed.timestamp)
        : parsed.timestamp;
      // Keep everything up to and including the boundary, plus the target marker
      // itself regardless of its (possibly re-appended) timestamp.
      if (
        isTargetMarker(parsed) ||
        (effectiveTs != null && effectiveTs <= boundaryTs)
      ) {
        kept.push(line);
      }
    } catch {
      // Preserve unparseable lines conservatively (rare).
      kept.push(line);
    }
  }
  return `${kept.join("\n")}\n`;
}

/** A single checkpoint capture known to the caller, used to re-derive dropped survivor markers. */
export interface SurvivingCheckpointEntry {
  checkpointId: string;
  promptId: number | undefined;
  turnCompletedAt?: string;
}

export interface TruncateRunLogToCheckpointInput {
  apiClient: PostHogAPIClient;
  taskId: string;
  runId: string;
  checkpointId: string;
  /**
   * Checkpoints that must NOT have their git refs deleted even if the backend's
   * orphan list wrongly includes them (the restore target is always implicitly a
   * survivor — callers don't need to add it themselves).
   */
  survivorCheckpointIds: Set<string>;
  /** Every checkpoint capture the caller knows survives the restore, used to re-derive markers the backend's position-based truncate drops. */
  survivingEntries: SurvivingCheckpointEntry[];
}

export interface TruncateRunLogToCheckpointResult {
  /** Whether the S3 log was actually truncated (false if the backend no-op'd). */
  truncated: boolean;
  /** The truncated (and, if needed, survivor-marker-repaired) NDJSON log text, ready to seed a local cache. Null when truncation didn't happen or failed. */
  truncatedLog: string | null;
  /** Checkpoint IDs it is safe to delete the git ref for (backend-orphaned, minus every known survivor). */
  idsToDelete: string[];
}

/**
 * Truncates a task run's S3 log to a checkpoint boundary, re-appending any
 * surviving checkpoint markers the backend's position-based truncation drops,
 * and returns which orphaned checkpoint refs are safe to delete.
 *
 * Host-agnostic: operates purely through `PostHogAPIClient` (importable both from
 * workspace-server, which is desktop/Node-only, and from inside a cloud sandbox's
 * agent-server process) — extracted from `CheckpointService.runRestore` so the
 * cloud-origin restore path (which runs this same truncation from inside the
 * sandbox) doesn't duplicate the survivor-marker defensive logic.
 */
export async function truncateRunLogToCheckpoint(
  input: TruncateRunLogToCheckpointInput,
): Promise<TruncateRunLogToCheckpointResult> {
  const { apiClient, taskId, runId, checkpointId, survivingEntries } = input;
  const survivorCheckpointIds = new Set(input.survivorCheckpointIds);
  survivorCheckpointIds.add(checkpointId);

  // Truncate by checkpoint_id only — do NOT send prompt_id. After a handoff
  // the per-taskRun checkpoint map mixes promptIds from two session numbering
  // spaces, so a checkpoint's stored promptId can point at the wrong entry and
  // keep restore-truncated turns. The backend locates the boundary by
  // checkpoint_id position — the same handoff-safe boundary the renderer's
  // truncateEventsToCheckpoint and trimReseededCacheToCheckpoint use.
  const s3Result = await apiClient.truncateTaskRunLog(
    taskId,
    runId,
    checkpointId,
  );
  if (!s3Result.truncated) {
    return { truncated: false, truncatedLog: null, idsToDelete: [] };
  }
  const orphanedCheckpointIds = s3Result.orphaned_checkpoint_ids ?? [];

  const buildMarkerEntry = (e: SurvivingCheckpointEntry): StoredEntry => ({
    type: "notification",
    // Prefer the true turn-completion time so the marker sits on the correct
    // boundary; only fall back to "now" (restore time) when the turn timestamp
    // is unknown (pre-fix/cloud-registered checkpoints).
    timestamp: e.turnCompletedAt ?? new Date().toISOString(),
    notification: {
      jsonrpc: "2.0",
      method: POSTHOG_NOTIFICATIONS.GIT_CHECKPOINT,
      params: {
        checkpointId: e.checkpointId,
        promptId: e.promptId,
        turnCompletedAt: e.turnCompletedAt,
      },
    },
  });

  let truncatedLog: string | null = null;
  try {
    const taskRun = await apiClient.getTaskRun(taskId, runId);
    let truncatedEntries = await apiClient.fetchTaskRunLogs(taskRun);

    // Which surviving markers did the position-based truncate drop? Re-append
    // those (target included — it's always dropped) so every survivor's marker
    // is durable in S3 and present in the cache the caller seeds.
    const presentCheckpointIds = new Set<string>();
    for (const entry of truncatedEntries) {
      const notif = (
        entry as {
          notification?: {
            method?: string;
            params?: { checkpointId?: string };
          };
        }
      ).notification;
      if (
        notif?.method === POSTHOG_NOTIFICATIONS.GIT_CHECKPOINT &&
        notif.params?.checkpointId
      ) {
        presentCheckpointIds.add(notif.params.checkpointId);
      }
    }
    const missingMarkers = survivingEntries
      .filter(
        (e) => e.promptId != null && !presentCheckpointIds.has(e.checkpointId),
      )
      .map(buildMarkerEntry);
    if (missingMarkers.length > 0) {
      await apiClient
        .appendTaskRunLog(taskId, runId, missingMarkers)
        .catch(() => {
          // Non-fatal: a survivor may show a disabled restore icon.
        });
      // Include locally without a second round-trip so the log text we return
      // below carries them even if the S3 append lagged.
      truncatedEntries = [...truncatedEntries, ...missingMarkers];
    }

    const rawLog = entriesToNdjson(truncatedEntries);
    if (rawLog.trim()) {
      // The backend truncates by checkpoint-id position, which no-ops when the
      // restore target is a pre-handoff checkpoint (its marker was re-appended
      // to the log tail). Trim by the marker's timestamp so reload doesn't
      // resurrect post-restore turns. Falls back to the backend log when the
      // marker can't be located.
      truncatedLog =
        trimReseededCacheToCheckpoint(rawLog, checkpointId) ?? rawLog;
      // Every GIT_CHECKPOINT marker still present in the truncated log is a
      // surviving checkpoint — protect its ref from the orphan-cleanup below.
      // This source survives an app restart (unlike an in-memory map).
      for (const entry of truncatedEntries) {
        const notif = (
          entry as {
            notification?: {
              method?: string;
              params?: { checkpointId?: string };
            };
          }
        ).notification;
        if (
          notif?.method === POSTHOG_NOTIFICATIONS.GIT_CHECKPOINT &&
          notif.params?.checkpointId
        ) {
          survivorCheckpointIds.add(notif.params.checkpointId);
        }
      }
    }
  } catch {
    // Non-fatal: reload may show stale turns; caller surfaces truncationFailed.
  }

  // Clean up git refs for orphaned checkpoints — but NEVER delete a surviving
  // checkpoint or the restore target. The backend's orphan list is computed from
  // the S3 log, which after a handoff mixes pre/post-handoff checkpoints and can
  // over-include survivors (even the restore target). Deleting a survivor's ref
  // is what made earlier turns un-restorable ("Checkpoint not found"). A leftover
  // orphan ref is benign, so over-deletion is the only harmful direction — when
  // in doubt, keep.
  const idsToDelete = orphanedCheckpointIds.filter(
    (id) => !survivorCheckpointIds.has(id),
  );

  return { truncated: true, truncatedLog, idsToDelete };
}
