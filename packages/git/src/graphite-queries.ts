import { execGt } from "./gt";

export interface GtStatus {
  installed: boolean;
  version: string | null;
}

export interface GraphiteStackEntry {
  branchName: string;
  isCurrent: boolean;
  isTrunk: boolean;
  needsRestack: boolean;
  parentRef: string | null;
  parentSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prTitle: string | null;
  prStatus: string | null;
  submitStatus: string | null;
}

export interface GraphiteStack {
  trunk: string;
  /** All Graphite-tracked branches */
  entries: GraphiteStackEntry[];
  /** Only the branches in the current branch's stack (trunk→leaf order), null if on trunk */
  currentStack: GraphiteStackEntry[] | null;
}

// Shape returned by `gt state`
interface GtStateEntry {
  trunk: boolean;
  needs_restack?: boolean;
  parents?: Array<{ ref: string; sha: string }>;
}

type GtStateOutput = Record<string, GtStateEntry>;

export async function getGtStatus(
  options: { cwd?: string } = {},
): Promise<GtStatus> {
  const result = await execGt(["--version"], options);
  if (result.exitCode === 127) {
    return { installed: false, version: null };
  }
  const version = result.stdout.trim() || null;
  return { installed: result.exitCode === 0, version };
}

export async function isGraphiteRepo(baseDir: string): Promise<boolean> {
  const result = await execGt(["state"], { cwd: baseDir });
  return result.exitCode === 0;
}

/**
 * Parses `gt state` JSON output into a structured stack.
 *
 * `gt state` returns structured JSON with branch relationships:
 * ```json
 * {
 *   "main": { "trunk": true },
 *   "my-branch": {
 *     "trunk": false,
 *     "needs_restack": false,
 *     "parents": [{ "ref": "main", "sha": "abc123" }]
 *   }
 * }
 * ```
 */
export function parseState(
  output: string,
  currentBranch: string | null,
): { trunk: string; entries: GraphiteStackEntry[] } | null {
  let state: GtStateOutput;
  try {
    state = JSON.parse(output);
  } catch {
    return null;
  }

  const branchNames = Object.keys(state);
  if (branchNames.length === 0) return null;

  const trunkName = branchNames.find((name) => state[name].trunk);
  if (!trunkName) return null;

  const entries: GraphiteStackEntry[] = [];
  for (const [name, info] of Object.entries(state)) {
    const parent = info.parents?.[0] ?? null;
    entries.push({
      branchName: name,
      isCurrent: name === currentBranch,
      isTrunk: info.trunk,
      needsRestack: info.needs_restack ?? false,
      parentRef: parent?.ref ?? null,
      parentSha: parent?.sha ?? null,
      prNumber: null,
      prUrl: null,
      prTitle: null,
      prStatus: null,
      submitStatus: null,
    });
  }

  return { trunk: trunkName, entries };
}

/**
 * Given all branches from `gt state`, extract only the branches in the
 * current branch's stack — walk up to trunk via parents, then include
 * all descendants of those branches that form a linear chain.
 *
 * Returns entries ordered from trunk → leaf (bottom to top of the stack).
 * Returns null if currentBranch is trunk or not found.
 */
export function filterCurrentStack(
  allEntries: GraphiteStackEntry[],
  _trunk: string,
  currentBranch: string | null,
): GraphiteStackEntry[] | null {
  if (!currentBranch) return null;

  const byName = new Map(allEntries.map((e) => [e.branchName, e]));
  const current = byName.get(currentBranch);
  if (!current || current.isTrunk) return null;

  // Walk up from current branch to trunk
  const ancestors: GraphiteStackEntry[] = [];
  let walk: GraphiteStackEntry | undefined = current;
  while (walk && !walk.isTrunk) {
    ancestors.unshift(walk);
    walk = walk.parentRef ? byName.get(walk.parentRef) : undefined;
  }

  // Build a set of branch names in the upward chain (excluding trunk)
  const chainNames = new Set(ancestors.map((e) => e.branchName));

  // Walk down: find children of the current branch and continue linearly
  // (only follow single-child chains to avoid ambiguity with forks)
  const childrenOf = new Map<string, GraphiteStackEntry[]>();
  for (const entry of allEntries) {
    if (entry.parentRef && !entry.isTrunk) {
      const siblings = childrenOf.get(entry.parentRef) ?? [];
      siblings.push(entry);
      childrenOf.set(entry.parentRef, siblings);
    }
  }

  const descendants: GraphiteStackEntry[] = [];
  let tip = currentBranch;
  while (true) {
    const children = childrenOf.get(tip) ?? [];
    // Only follow unambiguous single-child linear chains
    const next = children.filter((c) => !chainNames.has(c.branchName));
    if (next.length !== 1) break;
    descendants.push(next[0]);
    chainNames.add(next[0].branchName);
    tip = next[0].branchName;
  }

  return [...ancestors, ...descendants];
}

interface PrInfo {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prStatus: string;
  submitStatus: string | null;
}

/**
 * Parses `gt log` text output to extract PR info for each branch.
 * Used to enrich the structured data from `gt state` with PR details.
 *
 * gt log uses Unicode box-drawing characters as branch markers.
 * We strip all non-ASCII decoration and look for PR number/URL patterns.
 */
export function parseLogPrInfo(output: string): Map<string, PrInfo> {
  const prInfoMap = new Map<string, PrInfo>();
  const lines = output.split("\n");
  let currentBranch: string | null = null;
  let blockLines: string[] = [];

  for (const line of lines) {
    // Branch lines start with a Unicode box-drawing marker (◉, ◯, etc.)
    // Strip all non-ASCII decoration and check if this is a branch header line
    const stripped = line.replace(/[^\x20-\x7E]/g, "").trim();
    const isBranchLine =
      /[^\x20-\x7E]/.test(line) && stripped && !stripped.startsWith("PR #");

    if (isBranchLine) {
      if (currentBranch) {
        const prInfo = extractPrInfo(blockLines);
        if (prInfo) prInfoMap.set(currentBranch, prInfo);
      }
      currentBranch = stripped
        .replace(/\(needs restack\)/g, "")
        .replace(/\(frozen\)/g, "")
        .replace(/\(current\)/g, "")
        .trim();
      blockLines = [];
    } else {
      blockLines.push(line);
    }
  }
  if (currentBranch) {
    const prInfo = extractPrInfo(blockLines);
    if (prInfo) prInfoMap.set(currentBranch, prInfo);
  }

  return prInfoMap;
}

function extractPrInfo(lines: string[]): PrInfo | null {
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let prTitle: string | null = null;
  let prStatus: string | null = null;
  let submitStatus: string | null = null;

  for (const rawLine of lines) {
    // Strip all non-ASCII decoration characters
    const line = rawLine.replace(/[^\x20-\x7E]/g, "").trim();

    const prMatch = line.match(/^PR #(\d+)\s*(?:\(([^)]+)\)\s*)?(.+)?$/);
    if (prMatch) {
      prNumber = Number.parseInt(prMatch[1], 10);
      prStatus = prMatch[2] ?? "Open";
      prTitle = prMatch[3]?.trim() ?? null;
      continue;
    }

    const urlMatch = line.match(
      /(https:\/\/app\.graphite\.com\/github\/pr\/[^\s]+)/,
    );
    if (urlMatch) {
      prUrl = urlMatch[1];
      continue;
    }

    const submitMatch = line.match(/^Last submitted version:\s*(.+)$/);
    if (submitMatch) {
      submitStatus = submitMatch[1];
    }
  }

  if (prNumber === null) return null;

  return {
    prNumber,
    prUrl: prUrl ?? "",
    prTitle: prTitle ?? "",
    prStatus: prStatus ?? "Open",
    submitStatus,
  };
}

/**
 * Get all Graphite-tracked branches and their relationships.
 * Uses `gt state` (structured JSON) as primary data source,
 * enriched with PR info from `gt log` (text parsing).
 */
export async function getStack(
  baseDir: string,
  currentBranch: string | null,
): Promise<GraphiteStack | null> {
  const stateResult = await execGt(["state"], { cwd: baseDir });
  if (stateResult.exitCode !== 0) return null;

  const parsed = parseState(stateResult.stdout, currentBranch);
  if (!parsed) return null;

  // Enrich with PR info from `gt log`
  const logResult = await execGt(["log"], { cwd: baseDir });
  if (logResult.exitCode === 0) {
    const prInfoMap = parseLogPrInfo(logResult.stdout);
    for (const entry of parsed.entries) {
      const prInfo = prInfoMap.get(entry.branchName);
      if (prInfo) {
        entry.prNumber = prInfo.prNumber;
        entry.prUrl = prInfo.prUrl;
        entry.prTitle = prInfo.prTitle;
        entry.prStatus = prInfo.prStatus;
        entry.submitStatus = prInfo.submitStatus;
      }
    }
  }

  const currentStack = filterCurrentStack(
    parsed.entries,
    parsed.trunk,
    currentBranch,
  );

  return { trunk: parsed.trunk, entries: parsed.entries, currentStack };
}
