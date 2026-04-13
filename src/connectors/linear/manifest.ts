import type { ConnectorManifest } from "@/core/types";
import { linearQuery } from "./lib/linear-api";
import { linearListIssuesSchema, handleLinearListIssues } from "./tools/linear_list_issues";
import { linearGetIssueSchema, handleLinearGetIssue } from "./tools/linear_get_issue";
import { linearSearchIssuesSchema, handleLinearSearchIssues } from "./tools/linear_search_issues";
import { linearListProjectsSchema, handleLinearListProjects } from "./tools/linear_list_projects";
import { linearCreateIssueSchema, handleLinearCreateIssue } from "./tools/linear_create_issue";
import { linearUpdateIssueSchema, handleLinearUpdateIssue } from "./tools/linear_update_issue";

export const linearConnector: ConnectorManifest = {
  id: "linear",
  label: "Linear",
  description: "Create, read, update, and search Linear issues and projects",
  requiredEnvVars: ["LINEAR_API_KEY"],
  diagnose: async () => {
    try {
      const data = await linearQuery<{ viewer: { name: string; email: string } }>(
        `query { viewer { name email } }`
      );
      return { ok: true, message: `Connected as ${data.viewer.name} (${data.viewer.email})` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Cannot reach Linear API",
      };
    }
  },
  tools: [
    {
      name: "linear_list_issues",
      description:
        "List Linear issues. Filters: team key, project name, workflow state, assignee. Returns identifiers, titles, state, and assignees.",
      schema: linearListIssuesSchema,
      handler: async (params) =>
        handleLinearListIssues(
          params as {
            team?: string;
            project?: string;
            state?: string;
            assignee?: string;
            limit?: number;
          }
        ),
    },
    {
      name: "linear_get_issue",
      description:
        "Get full details of a Linear issue by identifier (e.g. 'ENG-123'), including description and comments.",
      schema: linearGetIssueSchema,
      handler: async (params) =>
        handleLinearGetIssue(
          params as {
            identifier: string;
            include_comments?: boolean;
          }
        ),
    },
    {
      name: "linear_search_issues",
      description: "Full-text search across Linear issues.",
      schema: linearSearchIssuesSchema,
      handler: async (params) =>
        handleLinearSearchIssues(
          params as {
            query: string;
            limit?: number;
          }
        ),
    },
    {
      name: "linear_list_projects",
      description:
        "List Linear projects with optional team filter. Returns state, progress, and dates.",
      schema: linearListProjectsSchema,
      handler: async (params) =>
        handleLinearListProjects(
          params as {
            team?: string;
            limit?: number;
          }
        ),
    },
    {
      name: "linear_create_issue",
      description:
        "Create a new Linear issue. Requires team key. Resolves state, assignee, and label names automatically. Always confirm with the user before calling.",
      schema: linearCreateIssueSchema,
      handler: async (params) =>
        handleLinearCreateIssue(
          params as {
            title: string;
            team: string;
            description?: string;
            priority?: "no_priority" | "urgent" | "high" | "medium" | "low";
            state?: string;
            assignee?: string;
            labels?: string[];
          }
        ),
      destructive: true,
    },
    {
      name: "linear_update_issue",
      description:
        "Update a Linear issue by identifier. Resolves state, assignee, and label names automatically. Always confirm changes with the user before calling.",
      schema: linearUpdateIssueSchema,
      handler: async (params) =>
        handleLinearUpdateIssue(
          params as {
            identifier: string;
            title?: string;
            description?: string;
            priority?: "no_priority" | "urgent" | "high" | "medium" | "low";
            state?: string;
            assignee?: string | null;
            labels?: string[];
          }
        ),
      destructive: true,
    },
  ],
};
