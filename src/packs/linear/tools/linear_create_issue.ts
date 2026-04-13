import { z } from "zod";
import {
  linearQuery,
  resolveTeamId,
  resolveUserId,
  resolveStateId,
  resolveLabelIds,
} from "../lib/linear-api";

export const linearCreateIssueSchema = {
  title: z.string().describe("Issue title"),
  team: z.string().describe("Team key (e.g. 'ENG')"),
  description: z.string().optional().describe("Issue description (markdown supported)"),
  priority: z
    .enum(["no_priority", "urgent", "high", "medium", "low"])
    .optional()
    .describe("Issue priority"),
  state: z
    .string()
    .optional()
    .describe("Workflow state name (e.g. 'In Progress'). Defaults to team's default state."),
  assignee: z.string().optional().describe("Assignee name or email"),
  labels: z.array(z.string()).optional().describe("Label names to apply"),
};

const PRIORITY_VALUES: Record<string, number> = {
  no_priority: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

interface CreateIssueData {
  issueCreate: {
    success: boolean;
    issue: { id: string; identifier: string; title: string; url: string };
  };
}

export async function handleLinearCreateIssue(params: {
  title: string;
  team: string;
  description?: string;
  priority?: "no_priority" | "urgent" | "high" | "medium" | "low";
  state?: string;
  assignee?: string;
  labels?: string[];
}) {
  const teamId = await resolveTeamId(params.team);

  const input: Record<string, unknown> = {
    title: params.title,
    teamId,
  };

  if (params.description) input.description = params.description;
  if (params.priority) input.priority = PRIORITY_VALUES[params.priority];
  if (params.state) input.stateId = await resolveStateId(teamId, params.state);
  if (params.assignee) input.assigneeId = await resolveUserId(params.assignee);
  if (params.labels?.length) input.labelIds = await resolveLabelIds(teamId, params.labels);

  const data = await linearQuery<CreateIssueData>(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }`,
    { input }
  );

  const issue = data.issueCreate.issue;
  return {
    content: [
      {
        type: "text" as const,
        text: `Issue created: **${issue.identifier}** ${issue.title}\n${issue.url}`,
      },
    ],
  };
}
