import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createGitClient } from "./client";
import {
  type GitHandoffApplyInput,
  type GitHandoffCaptureResult,
  GitHandoffTracker,
  type HandoffLocalGitState,
} from "./handoff";
import {
  CaptureCheckpointSaga,
  RevertCheckpointSaga,
} from "./sagas/checkpoint";

const execFileAsync = promisify(execFile);

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "posthog-code-handoff-"));
  const git = createGitClient(dir);
  await git.init();
  await git.addConfig("user.name", "PostHog Code Test");
  await git.addConfig("user.email", "posthog-code-test@example.com");
  await git.addConfig("commit.gpgsign", "false");
  await git.addConfig("core.autocrlf", "false");

  await writeFile(path.join(dir, "tracked.txt"), "base\n");
  await writeFile(path.join(dir, "unstaged.txt"), "base unstaged\n");
  await git.add(["tracked.txt", "unstaged.txt"]);
  await git.commit("initial");

  return dir;
}

async function cloneRepo(sourcePath: string): Promise<string> {
  const clonePath = await mkdtemp(
    path.join(tmpdir(), "posthog-code-handoff-clone-"),
  );
  await execFileAsync("git", ["clone", sourcePath, clonePath]);
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: clonePath,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], {
    cwd: clonePath,
  });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: clonePath,
  });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], {
    cwd: clonePath,
  });
  return clonePath;
}

interface RepoHarness {
  cloudRepo: string;
  localRepo: string;
  branch: string;
  cloudGit: ReturnType<typeof createGitClient>;
  localGit: ReturnType<typeof createGitClient>;
  localGitState: HandoffLocalGitState;
}

async function withRepos<T>(
  fn: (repos: RepoHarness) => Promise<T>,
): Promise<T> {
  const cloudRepo = await setupRepo();
  const localRepo = await cloneRepo(cloudRepo);
  const cloudGit = createGitClient(cloudRepo);
  const localGit = createGitClient(localRepo);
  try {
    const branch = (await cloudGit.revparse(["--abbrev-ref", "HEAD"])).trim();
    const localHead = (await localGit.revparse(["HEAD"])).trim();
    const upstreamHead = (await localGit.revparse([`origin/${branch}`])).trim();

    return await fn({
      cloudRepo,
      localRepo,
      branch,
      cloudGit,
      localGit,
      localGitState: {
        head: localHead,
        branch,
        upstreamHead,
        upstreamRemote: "origin",
        upstreamMergeRef: `refs/heads/${branch}`,
      },
    });
  } finally {
    await rm(localRepo, { recursive: true, force: true });
    await rm(cloudRepo, { recursive: true, force: true });
  }
}

async function makeCloudChanges(
  cloudRepo: string,
  cloudGit: ReturnType<typeof createGitClient>,
) {
  await writeFile(path.join(cloudRepo, "committed.txt"), "cloud commit\n");
  await cloudGit.add(["committed.txt"]);
  await cloudGit.commit("Cloud commit");

  await writeFile(path.join(cloudRepo, "tracked.txt"), "staged change\n");
  await cloudGit.add(["tracked.txt"]);
  await writeFile(path.join(cloudRepo, "unstaged.txt"), "unstaged change\n");
  await writeFile(path.join(cloudRepo, "untracked.txt"), "untracked\n");
}

async function cleanupCapture(capture: GitHandoffCaptureResult): Promise<void> {
  if (capture.headPack?.path) {
    await rm(capture.headPack.path, { force: true }).catch(() => {});
  }
  await rm(capture.indexFile.path, { force: true }).catch(() => {});
}

async function captureAndApply(
  repos: RepoHarness,
  options?: {
    captureState?: HandoffLocalGitState;
    applyState?: HandoffLocalGitState;
    onDivergedBranch?: GitHandoffApplyInput["onDivergedBranch"];
  },
): Promise<GitHandoffCaptureResult> {
  const captureTracker = new GitHandoffTracker({
    repositoryPath: repos.cloudRepo,
  });
  const capture = await captureTracker.captureForHandoff(
    options?.captureState ?? repos.localGitState,
  );

  const applyTracker = new GitHandoffTracker({
    repositoryPath: repos.localRepo,
  });

  try {
    await applyTracker.applyFromHandoff({
      checkpoint: capture.checkpoint,
      headPackPath: capture.headPack?.path,
      indexPath: capture.indexFile.path,
      localGitState: options?.applyState ?? repos.localGitState,
      onDivergedBranch: options?.onDivergedBranch,
    });
  } catch (error) {
    await cleanupCapture(capture);
    throw error;
  }

  return capture;
}

describe("GitHandoffTracker", () => {
  it("captures and reapplies head, worktree, and index state from local files", async () => {
    await withRepos(async (repos) => {
      await makeCloudChanges(repos.cloudRepo, repos.cloudGit);
      const capture = await captureAndApply(repos);

      try {
        expect((await repos.localGit.revparse(["HEAD"])).trim()).toBe(
          capture.checkpoint.head,
        );
        expect(
          (await repos.localGit.revparse(["--abbrev-ref", "HEAD"])).trim(),
        ).toBe(repos.branch);
        expect(
          await readFile(path.join(repos.localRepo, "committed.txt"), "utf-8"),
        ).toBe("cloud commit\n");
        expect(
          await readFile(path.join(repos.localRepo, "tracked.txt"), "utf-8"),
        ).toBe("staged change\n");
        expect(
          await readFile(path.join(repos.localRepo, "unstaged.txt"), "utf-8"),
        ).toBe("unstaged change\n");
        expect(
          await readFile(path.join(repos.localRepo, "untracked.txt"), "utf-8"),
        ).toBe("untracked\n");

        const status = await repos.localGit.raw(["status", "--porcelain"]);
        expect(status).toContain("M  tracked.txt");
        expect(status).toContain(" M unstaged.txt");
        expect(status).toContain("?? untracked.txt");
      } finally {
        await cleanupCapture(capture);
      }
    });
  }, 30000);

  it("keeps shipped index consistent with worktreeTree for staged large files", async () => {
    await withRepos(async (repos) => {
      const largePath = path.join(repos.cloudRepo, "tracked.txt");
      const modified = Buffer.alloc(1024 * 1024 + 1, 9);
      await writeFile(largePath, modified);
      await repos.cloudGit.add(["tracked.txt"]);

      const capture = await captureAndApply(repos);

      try {
        const restored = await readFile(
          path.join(repos.localRepo, "tracked.txt"),
          "utf-8",
        );
        expect(restored).toBe("base\n");

        const status = await repos.localGit.raw(["status", "--porcelain"]);
        expect(status).not.toMatch(/^M[ M] tracked\.txt/m);
        expect(status).not.toMatch(/^MM tracked\.txt/m);
      } finally {
        await cleanupCapture(capture);
      }
    });
  }, 30000);

  it("removes tracked files absent from the checkpoint worktree", async () => {
    await withRepos(async (repos) => {
      await rm(path.join(repos.cloudRepo, "tracked.txt"));
      await repos.cloudGit.raw(["rm", "--cached", "tracked.txt"]);
      await repos.cloudGit.commit("Remove tracked file");

      const capture = await captureAndApply(repos);

      try {
        await expect(
          readFile(path.join(repos.localRepo, "tracked.txt"), "utf-8"),
        ).rejects.toThrow();

        const status = await repos.localGit.raw(["status", "--porcelain"]);
        expect(status).not.toContain("tracked.txt");
      } finally {
        await cleanupCapture(capture);
      }
    });
  }, 30000);

  it("prompts before resetting a diverged local branch", async () => {
    await withRepos(async (repos) => {
      await writeFile(
        path.join(repos.localRepo, "local-only.txt"),
        "local commit\n",
      );
      await repos.localGit.add(["local-only.txt"]);
      await repos.localGit.commit("Local only");
      const localHead = (await repos.localGit.revparse(["HEAD"])).trim();

      await writeFile(
        path.join(repos.cloudRepo, "cloud-only.txt"),
        "cloud commit\n",
      );
      await repos.cloudGit.add(["cloud-only.txt"]);
      await repos.cloudGit.commit("Cloud only");

      const captureTracker = new GitHandoffTracker({
        repositoryPath: repos.cloudRepo,
      });
      const capture = await captureTracker.captureForHandoff({
        ...repos.localGitState,
        head: localHead,
        upstreamHead: null,
      });

      const confirm = vi.fn().mockResolvedValue(false);
      const applyTracker = new GitHandoffTracker({
        repositoryPath: repos.localRepo,
      });

      try {
        await expect(
          applyTracker.applyFromHandoff({
            checkpoint: capture.checkpoint,
            headPackPath: capture.headPack?.path,
            indexPath: capture.indexFile.path,
            localGitState: {
              ...repos.localGitState,
              head: localHead,
              upstreamHead: null,
            },
            onDivergedBranch: confirm,
          }),
        ).rejects.toThrow("Handoff aborted");

        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: repos.branch,
            cloudHead: capture.checkpoint.head,
          }),
        );
        expect(
          (
            await repos.localGit.revparse([`refs/heads/${repos.branch}`])
          ).trim(),
        ).not.toBe(capture.checkpoint.head);
      } finally {
        await cleanupCapture(capture);
      }
    });
  }, 30000);

  it("preserves existing local upstream config", async () => {
    await withRepos(async (repos) => {
      await repos.localGit.raw([
        "remote",
        "set-url",
        "origin",
        "git@github.com:local/repo.git",
      ]);
      await repos.localGit.raw([
        "config",
        `branch.${repos.branch}.remote`,
        "origin",
      ]);
      await repos.localGit.raw([
        "config",
        `branch.${repos.branch}.merge`,
        `refs/heads/${repos.branch}`,
      ]);

      await repos.cloudGit.addRemote(
        "cloud-origin",
        "https://example.com/cloud.git",
      );
      await repos.cloudGit.raw([
        "config",
        `branch.${repos.branch}.remote`,
        "cloud-origin",
      ]);
      await repos.cloudGit.raw([
        "config",
        `branch.${repos.branch}.merge`,
        `refs/heads/${repos.branch}`,
      ]);

      await writeFile(
        path.join(repos.cloudRepo, "cloud-only.txt"),
        "cloud commit\n",
      );
      await repos.cloudGit.add(["cloud-only.txt"]);
      await repos.cloudGit.commit("Cloud only");

      const capture = await captureAndApply(repos, {
        captureState: {
          ...repos.localGitState,
          upstreamHead: null,
        },
      });

      try {
        expect(
          (
            await repos.localGit.raw([
              "config",
              "--get",
              `branch.${repos.branch}.remote`,
            ])
          ).trim(),
        ).toBe("origin");
        expect(
          (await repos.localGit.raw(["remote", "get-url", "origin"])).trim(),
        ).toBe("git@github.com:local/repo.git");
      } finally {
        await cleanupCapture(capture);
      }
    });
  }, 30000);

  it("adopts cloud upstream when the local branch has none", async () => {
    await withRepos(async (repos) => {
      await repos.localGit
        .raw(["config", "--unset-all", `branch.${repos.branch}.remote`])
        .catch(() => {});
      await repos.localGit
        .raw(["config", "--unset-all", `branch.${repos.branch}.merge`])
        .catch(() => {});
      await repos.localGit.removeRemote("origin");

      await repos.cloudGit.addRemote(
        "cloud-origin",
        "https://example.com/cloud.git",
      );
      await repos.cloudGit.raw([
        "config",
        `branch.${repos.branch}.remote`,
        "cloud-origin",
      ]);
      await repos.cloudGit.raw([
        "config",
        `branch.${repos.branch}.merge`,
        `refs/heads/${repos.branch}`,
      ]);

      await writeFile(
        path.join(repos.cloudRepo, "cloud-only.txt"),
        "cloud commit\n",
      );
      await repos.cloudGit.add(["cloud-only.txt"]);
      await repos.cloudGit.commit("Cloud only");

      const capture = await captureAndApply(repos, {
        captureState: {
          ...repos.localGitState,
          upstreamHead: null,
          upstreamRemote: null,
          upstreamMergeRef: null,
        },
        applyState: {
          ...repos.localGitState,
          upstreamRemote: null,
          upstreamMergeRef: null,
        },
      });

      try {
        expect(
          (
            await repos.localGit.raw([
              "config",
              "--get",
              `branch.${repos.branch}.remote`,
            ])
          ).trim(),
        ).toBe("cloud-origin");
        expect(
          (
            await repos.localGit.raw(["remote", "get-url", "cloud-origin"])
          ).trim(),
        ).toBe("https://example.com/cloud.git");
      } finally {
        await cleanupCapture(capture);
      }
    });
  }, 30000);

  it("packExistingCheckpoint ships the worktreeTree so a baseline-only receiver can apply it", async () => {
    await withRepos(async (repos) => {
      // Build a checkpoint whose commit tree differs from the recorded worktreeTree.
      // Staged + unstaged + untracked changes make the HEAD/index/worktree trees all
      // diverge — the exact precondition that exposed the local→cloud apply bug, where
      // packing only the checkpoint commit omitted the worktreeTree object.
      await writeFile(path.join(repos.cloudRepo, "tracked.txt"), "staged\n");
      await repos.cloudGit.add(["tracked.txt"]);
      await writeFile(path.join(repos.cloudRepo, "unstaged.txt"), "unstaged\n");
      await writeFile(
        path.join(repos.cloudRepo, "untracked.txt"),
        "untracked\n",
      );

      const saga = new CaptureCheckpointSaga();
      const result = await saga.run({ baseDir: repos.cloudRepo });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const checkpointId = result.data.checkpointId;

      const tracker = new GitHandoffTracker({
        repositoryPath: repos.cloudRepo,
      });
      // Baseline = the receiver's existing commit (origin tip): differential pack.
      const packed = await tracker.packExistingCheckpoint(
        checkpointId,
        repos.localGitState.upstreamHead,
      );
      expect(packed).not.toBeNull();
      if (!packed) return;

      try {
        // Precondition: the checkpoint commit's tree is NOT the worktreeTree, so a
        // commit-only pack would silently drop the worktreeTree object.
        const commitTree = (
          await repos.cloudGit.raw([
            "show",
            "-s",
            "--format=%T",
            packed.checkpoint.commit,
          ])
        ).trim();
        expect(commitTree).not.toBe(packed.checkpoint.worktreeTree);

        // The baseline-only receiver must not already have the worktreeTree
        // (cat-file -e exits non-zero when the object is absent; rev-parse --verify
        // would merely echo a well-formed SHA without checking existence).
        await expect(
          execFileAsync(
            "git",
            ["cat-file", "-e", packed.checkpoint.worktreeTree],
            {
              cwd: repos.localRepo,
            },
          ),
        ).rejects.toThrow();

        // Apply the pack the way the cloud does, then materialize the worktreeTree.
        const destPack = path.join(
          repos.localRepo,
          ".git",
          "objects",
          "pack",
          path.basename(packed.artifact.path),
        );
        await copyFile(packed.artifact.path, destPack);
        await execFileAsync("git", ["index-pack", destPack], {
          cwd: repos.localRepo,
        });

        // Without the fix this throws "failed to unpack tree object <worktreeTree>".
        await execFileAsync(
          "git",
          ["read-tree", "--reset", "-u", packed.checkpoint.worktreeTree],
          { cwd: repos.localRepo },
        );

        expect(
          await readFile(path.join(repos.localRepo, "untracked.txt"), "utf-8"),
        ).toBe("untracked\n");
        expect(
          await readFile(path.join(repos.localRepo, "tracked.txt"), "utf-8"),
        ).toBe("staged\n");
      } finally {
        await rm(packed.artifact.path, { force: true }).catch(() => {});
        await rm(path.dirname(packed.artifact.path), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    });
  }, 30000);

  it("keeps the handoff pack differential under a blob:none partial clone", async () => {
    // Regression for the local→cloud 413 (oversized `capture_git_checkpoint` pack). Under a
    // `blob:none` partial clone, `git pack-objects --revs ^baseline` can fail to keep the pack
    // differential: the working tree materializes large blobs locally (re-hashed into
    // `worktreeTree`), but the identical upstream copies are promisor-filtered, so the negative
    // `^baseline` walk cannot mark them uninteresting and packs the whole asset — blowing the
    // 30MB artifact cap. The fix subtracts the baseline's (locally-present) tree-object SHAs
    // from the pack list, so any object the receiver can reconstruct from its own baseline is
    // never shipped. This exercises the partial-clone path end to end and asserts the invariant:
    // the pack contains no object already present in the baseline and stays far smaller than the
    // large asset it must not re-ship.
    const upstreamBare = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-upstream-"),
    );
    const seedRepo = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-seed-"),
    );
    const senderRepo = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-sender-"),
    );
    const receiverRepo = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-receiver-"),
    );
    const bareUrl = `file:///${upstreamBare.replace(/\\/g, "/")}`;

    const gitIn = (cwd: string, args: string[]) =>
      execFileAsync("git", args, { cwd });

    let capture: GitHandoffCaptureResult | null = null;
    try {
      // Bare upstream that advertises partial-clone filtering.
      await execFileAsync("git", ["init", "-q", "--bare", upstreamBare]);
      await gitIn(upstreamBare, ["config", "uploadpack.allowFilter", "true"]);
      await gitIn(upstreamBare, [
        "config",
        "uploadpack.allowAnySHA1InWant",
        "true",
      ]);

      // Seed a commit carrying a large binary asset, then publish it as `main`.
      await execFileAsync("git", ["clone", "-q", upstreamBare, seedRepo]);
      await gitIn(seedRepo, ["config", "user.email", "t@t.com"]);
      await gitIn(seedRepo, ["config", "user.name", "Test"]);
      await gitIn(seedRepo, ["config", "commit.gpgsign", "false"]);
      await gitIn(seedRepo, ["config", "core.autocrlf", "false"]);
      const bigAsset = Buffer.alloc(2 * 1024 * 1024, 7);
      await writeFile(path.join(seedRepo, "big.bin"), bigAsset);
      await writeFile(path.join(seedRepo, "small.txt"), "hello\n");
      await gitIn(seedRepo, ["add", "-A"]);
      await gitIn(seedRepo, ["commit", "-qm", "base with large asset"]);
      await gitIn(seedRepo, ["branch", "-M", "main"]);
      await gitIn(seedRepo, ["push", "-q", "origin", "main"]);

      // Sender = a real blobless partial clone (`--no-local` forces the transport so the
      // filter is honored instead of hardlinking every object). Its HEAD sits at the first
      // commit; `big.bin` is materialized into the working tree by checkout.
      await execFileAsync("git", [
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        bareUrl,
        senderRepo,
      ]);
      await gitIn(senderRepo, ["config", "user.email", "t@t.com"]);
      await gitIn(senderRepo, ["config", "user.name", "Test"]);
      await gitIn(senderRepo, ["config", "commit.gpgsign", "false"]);
      await gitIn(senderRepo, ["config", "core.autocrlf", "false"]);

      // Advance upstream by one commit so the receiver's baseline (origin/main) is a real,
      // distinct differential base ahead of the sender's HEAD — mirroring "local is behind
      // upstream" at handoff time. The new commit keeps `big.bin` unchanged, so the baseline
      // still contains that (now promisor-filtered) large blob.
      await writeFile(path.join(seedRepo, "other.txt"), "upstream advance\n");
      await gitIn(seedRepo, ["add", "-A"]);
      await gitIn(seedRepo, ["commit", "-qm", "upstream advances"]);
      await gitIn(seedRepo, ["push", "-q", "origin", "main"]);
      await gitIn(senderRepo, ["fetch", "-q", "origin"]);

      const senderGit = createGitClient(senderRepo);
      const baseline = (await senderGit.revparse(["origin/main"])).trim();
      const head = (await senderGit.revparse(["HEAD"])).trim();
      expect(baseline).not.toBe(head);
      const bigSha = (await senderGit.revparse(["HEAD:big.bin"])).trim();

      // A small working-tree change: the only content the handoff legitimately needs to ship.
      await writeFile(path.join(senderRepo, "feature.txt"), "new feature\n");

      const tracker = new GitHandoffTracker({ repositoryPath: senderRepo });
      capture = await tracker.captureForHandoff({
        head,
        branch: "main",
        upstreamHead: baseline,
        upstreamRemote: "origin",
        upstreamMergeRef: "refs/heads/main",
      });

      const packPath = capture.headPack?.path;
      expect(packPath).toBeTruthy();
      if (!packPath) return;

      // Invariant 1: the large asset (present in the baseline) is never re-shipped.
      const { stdout: packListing } = await execFileAsync(
        "git",
        ["verify-pack", "-v", packPath],
        { cwd: senderRepo },
      );
      expect(packListing).not.toContain(bigSha);

      // Invariant 2: the pack stays far below the asset size (differential, not full-repo).
      expect(capture.headPack?.rawBytes ?? 0).toBeLessThan(256 * 1024);

      // Round-trip: a receiver that already has the baseline applies the pack and restores the
      // small change — proving the excluded baseline objects were genuinely unnecessary.
      await execFileAsync("git", ["clone", "-q", upstreamBare, receiverRepo]);
      await gitIn(receiverRepo, ["config", "user.email", "t@t.com"]);
      await gitIn(receiverRepo, ["config", "user.name", "Test"]);
      await gitIn(receiverRepo, ["config", "commit.gpgsign", "false"]);
      await gitIn(receiverRepo, ["config", "core.autocrlf", "false"]);

      const applyTracker = new GitHandoffTracker({
        repositoryPath: receiverRepo,
      });
      await applyTracker.applyFromHandoff({
        checkpoint: capture.checkpoint,
        headPackPath: capture.headPack?.path,
        indexPath: capture.indexFile.path,
        localGitState: {
          head: baseline,
          branch: "main",
          upstreamHead: baseline,
          upstreamRemote: "origin",
          upstreamMergeRef: "refs/heads/main",
        },
        // The receiver sits at the advanced baseline (one commit ahead of the checkpoint's
        // HEAD), so restoring the checkpoint is an intentional reset — accept it.
        onDivergedBranch: async () => true,
      });
      expect(
        await readFile(path.join(receiverRepo, "feature.txt"), "utf-8"),
      ).toBe("new feature\n");
    } finally {
      if (capture) await cleanupCapture(capture);
      await rm(upstreamBare, { recursive: true, force: true });
      await rm(seedRepo, { recursive: true, force: true });
      await rm(senderRepo, { recursive: true, force: true });
      await rm(receiverRepo, { recursive: true, force: true });
    }
  }, 30000);

  it("applies the differential pack on a blob:none receiver by lazy-fetching excluded baseline blobs", async () => {
    // Companion to the test above, closing the one assumption the fix rests on: "the receiver
    // already has the baseline objects." A full-clone receiver trivially does. But the real
    // cloud sandbox is ITSELF a `blob:none` partial clone, so the baseline blobs we deliberately
    // drop from the pack are promisor-absent on the receiver too. This proves that is still safe:
    // `read-tree --reset -u <worktreeTree>` materializes the checkpoint's full worktree by lazily
    // fetching those excluded blobs from the receiver's own promisor remote — so the small
    // differential pack applies and BOTH the shipped change (feature.txt, in the pack) and the
    // untouched large asset (big.bin, excluded from the pack) end up byte-correct.
    const upstreamBare = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-upstream-"),
    );
    const seedRepo = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-seed-"),
    );
    const senderRepo = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-sender-"),
    );
    const receiverRepo = await mkdtemp(
      path.join(tmpdir(), "posthog-code-handoff-receiver-"),
    );
    const bareUrl = `file:///${upstreamBare.replace(/\\/g, "/")}`;

    const gitIn = (cwd: string, args: string[]) =>
      execFileAsync("git", args, { cwd });

    let capture: GitHandoffCaptureResult | null = null;
    try {
      // Bare upstream that advertises partial-clone filtering, so BOTH the sender and the
      // receiver can clone blobless and lazily backfill blobs on demand.
      await execFileAsync("git", ["init", "-q", "--bare", upstreamBare]);
      await gitIn(upstreamBare, ["config", "uploadpack.allowFilter", "true"]);
      await gitIn(upstreamBare, [
        "config",
        "uploadpack.allowAnySHA1InWant",
        "true",
      ]);

      // Seed a commit carrying a large binary asset, then publish it as `main`.
      await execFileAsync("git", ["clone", "-q", upstreamBare, seedRepo]);
      await gitIn(seedRepo, ["config", "user.email", "t@t.com"]);
      await gitIn(seedRepo, ["config", "user.name", "Test"]);
      await gitIn(seedRepo, ["config", "commit.gpgsign", "false"]);
      await gitIn(seedRepo, ["config", "core.autocrlf", "false"]);
      const bigAsset = Buffer.alloc(2 * 1024 * 1024, 7);
      await writeFile(path.join(seedRepo, "big.bin"), bigAsset);
      await writeFile(path.join(seedRepo, "small.txt"), "hello\n");
      await gitIn(seedRepo, ["add", "-A"]);
      await gitIn(seedRepo, ["commit", "-qm", "base with large asset"]);
      await gitIn(seedRepo, ["branch", "-M", "main"]);
      await gitIn(seedRepo, ["push", "-q", "origin", "main"]);

      // Sender = a real blobless partial clone at the base commit.
      await execFileAsync("git", [
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        bareUrl,
        senderRepo,
      ]);
      await gitIn(senderRepo, ["config", "user.email", "t@t.com"]);
      await gitIn(senderRepo, ["config", "user.name", "Test"]);
      await gitIn(senderRepo, ["config", "commit.gpgsign", "false"]);
      await gitIn(senderRepo, ["config", "core.autocrlf", "false"]);

      // Advance upstream so origin/main (the baseline) is a distinct commit ahead of the
      // sender's HEAD, still carrying the unchanged (now promisor-filtered) large blob.
      await writeFile(path.join(seedRepo, "other.txt"), "upstream advance\n");
      await gitIn(seedRepo, ["add", "-A"]);
      await gitIn(seedRepo, ["commit", "-qm", "upstream advances"]);
      await gitIn(seedRepo, ["push", "-q", "origin", "main"]);
      await gitIn(senderRepo, ["fetch", "-q", "origin"]);

      const senderGit = createGitClient(senderRepo);
      const baseline = (await senderGit.revparse(["origin/main"])).trim();
      const head = (await senderGit.revparse(["HEAD"])).trim();
      expect(baseline).not.toBe(head);
      const bigSha = (await senderGit.revparse(["HEAD:big.bin"])).trim();

      // The only content the handoff legitimately needs to ship.
      await writeFile(path.join(senderRepo, "feature.txt"), "new feature\n");

      const tracker = new GitHandoffTracker({ repositoryPath: senderRepo });
      capture = await tracker.captureForHandoff({
        head,
        branch: "main",
        upstreamHead: baseline,
        upstreamRemote: "origin",
        upstreamMergeRef: "refs/heads/main",
      });

      const packPath = capture.headPack?.path;
      expect(packPath).toBeTruthy();
      if (!packPath) return;

      // Sanity: the large blob really is excluded from the pack (else this test is moot).
      const { stdout: packListing } = await execFileAsync(
        "git",
        ["verify-pack", "-v", packPath],
        { cwd: senderRepo },
      );
      expect(packListing).not.toContain(bigSha);

      // Receiver = ALSO a `blob:none` partial clone, so big.bin's blob is promisor-absent here
      // too — the receiver cannot have it "already", it must lazily backfill it during apply.
      await execFileAsync("git", [
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        bareUrl,
        receiverRepo,
      ]);
      await gitIn(receiverRepo, ["config", "user.email", "t@t.com"]);
      await gitIn(receiverRepo, ["config", "user.name", "Test"]);
      await gitIn(receiverRepo, ["config", "commit.gpgsign", "false"]);
      await gitIn(receiverRepo, ["config", "core.autocrlf", "false"]);

      // Precondition: the excluded blob is genuinely missing on the receiver before apply.
      // `--missing=print` lists promisor-absent objects WITHOUT triggering a lazy fetch, so this
      // confirms the receiver really lacks big.bin (making the post-apply reconstruction real).
      const { stdout: missingBefore } = await execFileAsync(
        "git",
        ["rev-list", "--objects", "--missing=print", "origin/main"],
        { cwd: receiverRepo },
      );
      expect(missingBefore).toContain(bigSha);

      const applyTracker = new GitHandoffTracker({
        repositoryPath: receiverRepo,
      });
      await applyTracker.applyFromHandoff({
        checkpoint: capture.checkpoint,
        headPackPath: capture.headPack?.path,
        indexPath: capture.indexFile.path,
        localGitState: {
          head: baseline,
          branch: "main",
          upstreamHead: baseline,
          upstreamRemote: "origin",
          upstreamMergeRef: "refs/heads/main",
        },
        // The receiver sits at the advanced baseline (ahead of the checkpoint's HEAD), so
        // restoring the checkpoint is an intentional reset — accept it.
        onDivergedBranch: async () => true,
      });

      // Line-ending-tolerant read: git may normalize LF→CRLF on checkout under a Windows
      // core.autocrlf; the invariant under test is content, not EOL.
      const readText = async (name: string) =>
        (await readFile(path.join(receiverRepo, name), "utf-8")).replace(
          /\r\n/g,
          "\n",
        );

      // The shipped change applied from the pack...
      expect(await readText("feature.txt")).toBe("new feature\n");
      // ...and the excluded large asset was reconstructed from the receiver's promisor remote:
      // read-tree -u materialized the full checkpoint worktree, lazy-fetching the dropped blob.
      // (Binary content is compared exactly — no EOL normalization applies.)
      const bigOut = await readFile(path.join(receiverRepo, "big.bin"));
      expect(bigOut.length).toBe(2 * 1024 * 1024);
      expect(bigOut[0]).toBe(7);
      expect(bigOut[bigOut.length - 1]).toBe(7);
      expect(await readText("small.txt")).toBe("hello\n");
    } finally {
      if (capture) await cleanupCapture(capture);
      await rm(upstreamBare, { recursive: true, force: true });
      await rm(seedRepo, { recursive: true, force: true });
      await rm(senderRepo, { recursive: true, force: true });
      await rm(receiverRepo, { recursive: true, force: true });
    }
  }, 30000);

  it("materializeCheckpointRef recreates a restorable ref from a pack without touching the worktree", async () => {
    await withRepos(async (repos) => {
      await makeCloudChanges(repos.cloudRepo, repos.cloudGit);

      const captureTracker = new GitHandoffTracker({
        repositoryPath: repos.cloudRepo,
      });
      const capture = await captureTracker.captureForHandoff(
        repos.localGitState,
      );
      const checkpointId = capture.checkpoint.checkpointId;

      // Snapshot the receiver's working tree + ref state BEFORE materializing: the
      // operation must be ref-only (no checkout/reset/clean), unlike applyFromHandoff.
      const localHeadBefore = (await repos.localGit.revparse(["HEAD"])).trim();
      const statusBefore = await repos.localGit.raw(["status", "--porcelain"]);

      const applyTracker = new GitHandoffTracker({
        repositoryPath: repos.localRepo,
      });

      try {
        const first = await applyTracker.materializeCheckpointRef({
          checkpoint: capture.checkpoint,
          headPackPath: capture.headPack?.path,
          localGitState: repos.localGitState,
        });
        expect(first.created).toBe(true);

        // The ref now exists locally and the working tree is untouched.
        const refName = `refs/posthog-code-checkpoint/${checkpointId}`;
        expect(
          (await repos.localGit.revparse(["--verify", refName])).trim(),
        ).toBe(first.commit);
        expect((await repos.localGit.revparse(["HEAD"])).trim()).toBe(
          localHeadBefore,
        );
        expect(await repos.localGit.raw(["status", "--porcelain"])).toBe(
          statusBefore,
        );

        // Idempotent: a second call is a no-op that reports the existing ref.
        const second = await applyTracker.materializeCheckpointRef({
          checkpoint: capture.checkpoint,
          headPackPath: capture.headPack?.path,
          localGitState: repos.localGitState,
        });
        expect(second.created).toBe(false);
        expect(second.commit).toBe(first.commit);

        // RevertCheckpointSaga can now restore the cloud state from the ref alone.
        const revert = new RevertCheckpointSaga();
        const result = await revert.run({
          baseDir: repos.localRepo,
          checkpointId,
        });
        expect(result.success).toBe(true);

        expect((await repos.localGit.revparse(["HEAD"])).trim()).toBe(
          capture.checkpoint.head,
        );
        expect(
          await readFile(path.join(repos.localRepo, "committed.txt"), "utf-8"),
        ).toBe("cloud commit\n");
        expect(
          await readFile(path.join(repos.localRepo, "tracked.txt"), "utf-8"),
        ).toBe("staged change\n");
        expect(
          await readFile(path.join(repos.localRepo, "untracked.txt"), "utf-8"),
        ).toBe("untracked\n");
      } finally {
        await cleanupCapture(capture);
      }
    });
    // 30s to match the other clone-heavy handoff cases: Windows git ops routinely push this
    // real pack/unpack round-trip just past a 15s budget (pre-existing flake, unrelated to the
    // fix under test).
  }, 30000);
});
