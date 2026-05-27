import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GtExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export async function execGt(
  args: string[],
  options: { cwd?: string } = {},
): Promise<GtExecResult> {
  try {
    // --no-interactive must come before subcommand flags to avoid being
    // consumed by yargs array-type options like --message
    const [subcommand, ...rest] = args;
    const fullArgs = [subcommand, "--no-interactive", ...rest];
    const { stdout, stderr } = await execFileAsync("gt", fullArgs, {
      cwd: options.cwd,
      env: process.env,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };

    const exitCode =
      typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;

    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode,
      error: err.message,
    };
  }
}
