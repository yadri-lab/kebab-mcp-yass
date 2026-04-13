import { z } from "zod";
import { linearQuery } from "../lib/linear-api";

export const linearListProjectsSchema = {
  team: z.string().optional().describe("Team key to filter by (e.g. 'ENG')"),
  limit: z.number().optional().describe("Max projects to return (default: 25, max: 100)"),
};

interface LinearProject {
  id: string;
  name: string;
  description?: string | null;
  state: string;
  progress: number;
  startDate?: string | null;
  targetDate?: string | null;
  teams: { nodes: Array<{ key: string; name: string }> };
  url: string;
}

interface ListProjectsData {
  projects: { nodes: LinearProject[] };
}

export async function handleLinearListProjects(params: { team?: string; limit?: number }) {
  const limit = Math.min(params.limit ?? 25, 100);
  const filter = params.team ? { teams: { some: { key: { eq: params.team.toUpperCase() } } } } : {};

  const data = await linearQuery<ListProjectsData>(
    `query($filter: ProjectFilter, $first: Int) {
      projects(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes {
          id name description state progress startDate targetDate
          teams { nodes { key name } }
          url
        }
      }
    }`,
    { filter, first: limit }
  );

  const projects = data.projects.nodes;
  if (projects.length === 0) {
    return { content: [{ type: "text" as const, text: "No projects found." }] };
  }

  const lines = projects.map((p) => {
    const teams = p.teams.nodes.map((t) => t.key).join(", ");
    const progress = `${Math.round(p.progress * 100)}%`;
    const dates =
      p.startDate || p.targetDate
        ? ` | ${p.startDate?.slice(0, 10) ?? "?"} → ${p.targetDate?.slice(0, 10) ?? "?"}`
        : "";
    return `- **${p.name}** [${p.state}] ${progress}${dates} (teams: ${teams})`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `## Linear Projects (${projects.length})\n\n${lines.join("\n")}`,
      },
    ],
  };
}
