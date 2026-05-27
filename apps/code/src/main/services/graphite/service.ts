import {
  getGtStatus,
  getStack,
  isGraphiteRepo,
} from "@posthog/git/graphite-queries";
import { execGt } from "@posthog/git/gt";
import { getCurrentBranch } from "@posthog/git/queries";
import { injectable } from "inversify";
import { logger } from "../../utils/logger";
import type {
  CreateBranchOutput,
  ModifyOutput,
  RestackOutput,
  SubmitOutput,
  SyncOutput,
} from "./schemas";

const log = logger.scope("graphite-service");

@injectable()
export class GraphiteService {
  private cachedGtStatus: {
    installed: boolean;
    version: string | null;
  } | null = null;

  async getGtStatus() {
    if (this.cachedGtStatus) return this.cachedGtStatus;
    const status = await getGtStatus();
    this.cachedGtStatus = status;
    log.info("Graphite CLI status", status);
    return status;
  }

  async isGraphiteRepo(directoryPath: string): Promise<boolean> {
    const status = await this.getGtStatus();
    if (!status.installed) return false;
    return isGraphiteRepo(directoryPath);
  }

  async getStack(directoryPath: string) {
    const currentBranch = await getCurrentBranch(directoryPath);
    return getStack(directoryPath, currentBranch);
  }

  async submit(
    directoryPath: string,
    options?: { stack?: boolean; draft?: boolean },
  ): Promise<SubmitOutput> {
    const args = ["submit"];
    if (options?.stack) args.push("--stack");
    if (options?.draft) args.push("--draft");

    log.info("Submitting stack", { directoryPath, args });
    const result = await execGt(args, { cwd: directoryPath });

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error:
        result.exitCode !== 0 ? result.stderr || result.error || null : null,
    };
  }

  async sync(directoryPath: string): Promise<SyncOutput> {
    log.info("Syncing repo", { directoryPath });
    const result = await execGt(["sync"], { cwd: directoryPath });

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error:
        result.exitCode !== 0 ? result.stderr || result.error || null : null,
    };
  }

  async restack(directoryPath: string): Promise<RestackOutput> {
    log.info("Restacking", { directoryPath });
    const result = await execGt(["stack", "restack"], { cwd: directoryPath });

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error:
        result.exitCode !== 0 ? result.stderr || result.error || null : null,
    };
  }

  async modify(directoryPath: string): Promise<ModifyOutput> {
    log.info("Modifying stack branch", { directoryPath });
    const result = await execGt(["modify", "--all"], { cwd: directoryPath });

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error:
        result.exitCode !== 0 ? result.stderr || result.error || null : null,
    };
  }

  async createBranch(
    directoryPath: string,
    options?: { message?: string },
  ): Promise<CreateBranchOutput> {
    const args = ["create", "--all"];
    if (options?.message) args.push("--message", options.message);

    log.info("Creating stack branch", { directoryPath, args });
    const result = await execGt(args, { cwd: directoryPath });

    let branchName: string | null = null;
    if (result.exitCode === 0) {
      branchName = await getCurrentBranch(directoryPath);
    }

    return {
      success: result.exitCode === 0,
      branchName,
      output: result.stdout,
      error:
        result.exitCode !== 0 ? result.stderr || result.error || null : null,
    };
  }
}
