import { Tooltip } from "@components/ui/Tooltip";
import {
  ArrowSquareOut,
  GitBranch,
  GitPullRequest,
  Warning,
} from "@phosphor-icons/react";
import { Badge, Box, Flex, IconButton, Popover, Text } from "@radix-ui/themes";
import { trpcClient } from "@renderer/trpc";

interface StackEntry {
  branchName: string;
  isCurrent: boolean;
  isTrunk: boolean;
  needsRestack: boolean;
  prNumber: number | null;
  prUrl: string | null;
  prTitle: string | null;
  prStatus: string | null;
}

interface StackVisualizationProps {
  trunk?: string;
  entries: StackEntry[];
}

function PrBadge({ entry }: { entry: StackEntry }) {
  if (!entry.prNumber) return null;

  const colorMap: Record<string, "green" | "purple" | "red" | "gray"> = {
    open: "green",
    draft: "purple",
    closed: "red",
    merged: "purple",
  };
  const color = colorMap[entry.prStatus?.toLowerCase() ?? ""] ?? "gray";
  const label = `#${entry.prNumber}`;

  return (
    <Tooltip content={entry.prTitle ?? `PR #${entry.prNumber}`}>
      <Badge
        size="1"
        color={color}
        variant="soft"
        style={{ cursor: "default" }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}

function StackEntryRow({
  entry,
  isLast,
}: {
  entry: StackEntry;
  isLast: boolean;
}) {
  const openPr = () => {
    if (entry.prUrl) {
      trpcClient.os.openExternal.mutate({ url: entry.prUrl });
    }
  };

  return (
    <Flex align="stretch" gap="0" style={{ minHeight: 28 }}>
      {/* Connector line + dot */}
      <Flex
        direction="column"
        align="center"
        style={{ width: 20, flexShrink: 0 }}
      >
        {!isLast && (
          <Box
            style={{
              width: 1,
              flex: 1,
              backgroundColor: "var(--gray-7)",
            }}
          />
        )}
        <Box
          style={{
            width: entry.isCurrent ? 8 : 6,
            height: entry.isCurrent ? 8 : 6,
            borderRadius: "50%",
            backgroundColor: entry.isCurrent
              ? "var(--accent-9)"
              : entry.isTrunk
                ? "var(--gray-8)"
                : "var(--gray-7)",
            flexShrink: 0,
          }}
        />
        {!entry.isTrunk && (
          <Box
            style={{
              width: 1,
              flex: 1,
              backgroundColor: "var(--gray-7)",
            }}
          />
        )}
      </Flex>

      {/* Branch info */}
      <Flex align="center" gap="2" py="1" style={{ flex: 1, minWidth: 0 }}>
        <GitBranch
          size={12}
          weight={entry.isCurrent ? "bold" : "regular"}
          style={{ flexShrink: 0 }}
        />
        <Text
          size="1"
          weight={entry.isCurrent ? "medium" : "regular"}
          truncate
          style={{ flex: 1 }}
        >
          {entry.branchName}
        </Text>

        {entry.needsRestack && (
          <Tooltip content="Needs restack">
            <Warning
              size={12}
              weight="fill"
              color="var(--amber-9)"
              style={{ flexShrink: 0 }}
            />
          </Tooltip>
        )}

        <PrBadge entry={entry} />

        {entry.prUrl && (
          <Tooltip content="Open PR">
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              onClick={openPr}
              style={{ flexShrink: 0 }}
            >
              <ArrowSquareOut size={12} />
            </IconButton>
          </Tooltip>
        )}
      </Flex>
    </Flex>
  );
}

export function StackVisualization({ entries }: StackVisualizationProps) {
  // Show branches top-down: newest at top, trunk at bottom
  const ordered = [...entries].reverse();

  return (
    <Flex direction="column" gap="0" style={{ minWidth: 200 }}>
      {ordered.map((entry, i) => (
        <StackEntryRow
          key={entry.branchName}
          entry={entry}
          isLast={i === ordered.length - 1}
        />
      ))}
    </Flex>
  );
}

interface StackPopoverProps {
  trunk: string;
  entries: StackEntry[];
}

export function StackPopover({ entries }: StackPopoverProps) {
  const count = entries.length;
  const needsRestack = entries.some((e) => e.needsRestack);

  return (
    <Popover.Root>
      <Popover.Trigger>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--gray-6)] bg-[var(--gray-2)] px-1.5 py-0.5 text-[11px] text-[var(--gray-11)] leading-none hover:bg-[var(--gray-3)]"
        >
          <GitPullRequest size={12} />
          <span>
            {count} {count === 1 ? "branch" : "branches"} in stack
          </span>
          {needsRestack && (
            <Warning size={12} weight="fill" color="var(--amber-9)" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Content size="1" style={{ maxWidth: 340 }}>
        <Flex direction="column" gap="2">
          <Text size="1" weight="medium" color="gray">
            Current Stack
          </Text>
          <StackVisualization entries={entries} />
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
