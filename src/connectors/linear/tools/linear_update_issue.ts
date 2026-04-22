import { z } from "zod";
import { linearQuery, resolveUserId, resolveStateId, resolveLabelIds } from "../lib/linear-api";
import { McpToolError, ErrorCode } from "@/core/errors";

export const linearUpdateIssueSchema = {
  identifier: z.string().describe("Issue identifier (e.g. 'ENG-123')"),
  title: z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description (replaces existing)"),
  priority: z
    .enum(["no_priority", "urgent", "high", "medium", "low"])
    .optional()
    .describe("New priority"),
  state: z.string().optional().describe("New workflow state name"),
  assignee: z.string().nullable().optional().describe("New assignee name/email, or null to clear"),
  labels: z.array(z.string()).optional().describe("Replace label list (full list)"),
};

const PRIORITY_VALUES: Record<string, number> = {
  no_priority: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

interface SearchData {
  issues: { nodes: Array<{ id: string; identifier: string; team: { id: string } }> };
}

interface UpdateIssueData {
  issueUpdate: {
    success: boolean;
    issue: { id: string; identifier: string; title: string; url: string; state: { name: string } };
  };
}

export async function handleLinearUpdateIssue(params: {
  identifier: string;
  title?: string | undefined;
  description?: string | undefined;
  priority?: "no_priority" | "urgent" | "high" | "medium" | "low" | undefined;
  state?: string | undefined;
  assignee?: string | null | undefined;
  labels?: string[] | undefined;
}) {
  // Resolve identifier to ID
  const searchData = await linearQuery<SearchData>(
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 1) {
        nodes { id identifier team { id } }
      }
    }`,
    { filter: { identifier: { eq: params.identifier.toUpperCase() } } }
  );

  const found = searchData.issues.nodes[0];
  if (!found) {
    throw new McpToolError({
      code: ErrorCode.NOT_FOUND,
      toolName: "linear",
      message: `Issue "${params.identifier}" not found`,
      userMessage: `No Linear issue found with identifier "${params.identifier}".`,
      retryable: false,
    });
  }

  const teamId = found.team.id;
  const input: Record<string, unknown> = {};

  if (params.title !== undefined) input.title = params.title;
  if (params.description !== undefined) input.description = params.description;
  if (params.priority !== undefined) input.priority = PRIORITY_VALUES[params.priority];
  if (params.state !== undefined) input.stateId = await resolveStateId(teamId, params.state);
  if (params.assignee === null) {
    input.assigneeId = null;
  } else if (params.assignee !== undefined) {
    input.assigneeId = await resolveUserId(params.assignee);
  }
  if (params.labels !== undefined) input.labelIds = await resolveLabelIds(teamId, params.labels);

  const data = await linearQuery<UpdateIssueData>(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id identifier title url state { name } }
      }
    }`,
    { id: found.id, input }
  );

  const issue = data.issueUpdate.issue;
  return {
    content: [
      {
        type: "text" as const,
        text: `Issue updated: **${issue.identifier}** ${issue.title} [${issue.state.name}]\n${issue.url}`,
      },
    ],
  };
}
