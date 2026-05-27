import { z } from "zod";

export const directoryPathInput = z.object({
  directoryPath: z.string(),
});

export const gtStatusOutput = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
});

export type GtStatusOutput = z.infer<typeof gtStatusOutput>;

export const graphiteStackEntrySchema = z.object({
  branchName: z.string(),
  isCurrent: z.boolean(),
  isTrunk: z.boolean(),
  needsRestack: z.boolean(),
  parentRef: z.string().nullable(),
  parentSha: z.string().nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  prTitle: z.string().nullable(),
  prStatus: z.string().nullable(),
  submitStatus: z.string().nullable(),
});

export type GraphiteStackEntryOutput = z.infer<typeof graphiteStackEntrySchema>;

export const graphiteStackSchema = z.object({
  trunk: z.string(),
  entries: z.array(graphiteStackEntrySchema),
  currentStack: z.array(graphiteStackEntrySchema).nullable(),
});

export type GraphiteStackOutput = z.infer<typeof graphiteStackSchema>;

export const submitInput = z.object({
  directoryPath: z.string(),
  stack: z.boolean().optional(),
  draft: z.boolean().optional(),
});

export const submitOutput = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string().nullable(),
});

export type SubmitOutput = z.infer<typeof submitOutput>;

export const syncOutput = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string().nullable(),
});

export type SyncOutput = z.infer<typeof syncOutput>;

export const restackOutput = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string().nullable(),
});

export type RestackOutput = z.infer<typeof restackOutput>;

export const modifyOutput = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string().nullable(),
});

export type ModifyOutput = z.infer<typeof modifyOutput>;

export const createBranchInput = z.object({
  directoryPath: z.string(),
  message: z.string().optional(),
});

export const createBranchOutput = z.object({
  success: z.boolean(),
  branchName: z.string().nullable(),
  output: z.string(),
  error: z.string().nullable(),
});

export type CreateBranchOutput = z.infer<typeof createBranchOutput>;
