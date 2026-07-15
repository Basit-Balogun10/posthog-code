import type { TaskRunStatus } from "@posthog/shared";
import { z } from "zod";
import type { CloudTaskUpdatePayload } from "./cloud-task-types";

export type { CloudTaskUpdatePayload, TaskRunStatus };

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isTerminalStatus(
  status: TaskRunStatus | string | null | undefined,
): boolean {
  return (
    status !== null &&
    status !== undefined &&
    TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number])
  );
}

// --- Events ---

export const CloudTaskEvent = {
  Update: "cloud-task-update",
} as const;

export interface CloudTaskEvents {
  [CloudTaskEvent.Update]: CloudTaskUpdatePayload;
}

// --- tRPC Schemas ---

export const watchInput = z.object({
  taskId: z.string(),
  runId: z.string(),
  apiHost: z.string(),
  teamId: z.number(),
  resumeFromEntryCount: z.number().optional(),
});

export type WatchInput = z.infer<typeof watchInput>;

export const unwatchInput = z.object({
  taskId: z.string(),
  runId: z.string(),
});

export const retryInput = z.object({
  taskId: z.string(),
  runId: z.string(),
});

export const onUpdateInput = z.object({
  taskId: z.string(),
  runId: z.string(),
});

export const sendCommandInput = z.object({
  taskId: z.string(),
  runId: z.string(),
  apiHost: z.string(),
  teamId: z.number(),
  method: z.enum([
    "user_message",
    "cancel",
    "close",
    "permission_response",
    "set_config_option",
    "restore_checkpoint",
  ]),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type SendCommandInput = z.infer<typeof sendCommandInput>;

export const sendCommandOutput = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type SendCommandOutput = z.infer<typeof sendCommandOutput>;

// Server-side cloud-origin restore (option B): truncate the durable S3 run log at a checkpoint
// with no live sandbox, bounding the agent's memory. The git tree follows on the next sandbox
// resume (agent-server reconcileResumeGitCheckpoint). Backend endpoint:
// POST /api/projects/{teamId}/tasks/{taskId}/runs/{runId}/truncate_log/
export const truncateLogInput = z.object({
  taskId: z.string(),
  runId: z.string(),
  apiHost: z.string(),
  teamId: z.number(),
  checkpointId: z.string(),
  promptId: z.number().optional(),
});

export type TruncateLogInput = z.infer<typeof truncateLogInput>;

export const truncateLogOutput = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export type TruncateLogOutput = z.infer<typeof truncateLogOutput>;
