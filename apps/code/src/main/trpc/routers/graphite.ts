import { z } from "zod";
import { container } from "../../di/container";
import { MAIN_TOKENS } from "../../di/tokens";
import {
  createBranchInput,
  createBranchOutput,
  directoryPathInput,
  graphiteStackSchema,
  gtStatusOutput,
  modifyOutput,
  restackOutput,
  submitInput,
  submitOutput,
  syncOutput,
} from "../../services/graphite/schemas";
import type { GraphiteService } from "../../services/graphite/service";
import { publicProcedure, router } from "../trpc";

const getService = () =>
  container.get<GraphiteService>(MAIN_TOKENS.GraphiteService);

export const graphiteRouter = router({
  getGtStatus: publicProcedure
    .output(gtStatusOutput)
    .query(() => getService().getGtStatus()),

  isGraphiteRepo: publicProcedure
    .input(directoryPathInput)
    .output(z.boolean())
    .query(({ input }) => getService().isGraphiteRepo(input.directoryPath)),

  getStack: publicProcedure
    .input(directoryPathInput)
    .output(graphiteStackSchema.nullable())
    .query(({ input }) => getService().getStack(input.directoryPath)),

  submit: publicProcedure
    .input(submitInput)
    .output(submitOutput)
    .mutation(({ input }) =>
      getService().submit(input.directoryPath, {
        stack: input.stack,
        draft: input.draft,
      }),
    ),

  sync: publicProcedure
    .input(directoryPathInput)
    .output(syncOutput)
    .mutation(({ input }) => getService().sync(input.directoryPath)),

  restack: publicProcedure
    .input(directoryPathInput)
    .output(restackOutput)
    .mutation(({ input }) => getService().restack(input.directoryPath)),

  modify: publicProcedure
    .input(directoryPathInput)
    .output(modifyOutput)
    .mutation(({ input }) => getService().modify(input.directoryPath)),

  createBranch: publicProcedure
    .input(createBranchInput)
    .output(createBranchOutput)
    .mutation(({ input }) =>
      getService().createBranch(input.directoryPath, {
        message: input.message,
      }),
    ),
});
