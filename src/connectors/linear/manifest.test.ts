import { describe, it, expect } from "vitest";
import { linearConnector } from "./manifest";

describe("linearConnector manifest", () => {
  it("registers all 6 tools with correct names", () => {
    const names = linearConnector.tools.map((t) => t.name);
    expect(names).toContain("linear_list_issues");
    expect(names).toContain("linear_get_issue");
    expect(names).toContain("linear_search_issues");
    expect(names).toContain("linear_list_projects");
    expect(names).toContain("linear_create_issue");
    expect(names).toContain("linear_update_issue");
    expect(names).toHaveLength(6);
  });

  it("marks write tools as destructive", () => {
    const destructiveTools = linearConnector.tools.filter((t) => t.destructive).map((t) => t.name);
    expect(destructiveTools).toContain("linear_create_issue");
    expect(destructiveTools).toContain("linear_update_issue");
  });

  it("does not mark read tools as destructive", () => {
    const readToolNames = [
      "linear_list_issues",
      "linear_get_issue",
      "linear_search_issues",
      "linear_list_projects",
    ];
    for (const name of readToolNames) {
      const tool = linearConnector.tools.find((t) => t.name === name);
      expect(tool?.destructive).toBeFalsy();
    }
  });

  it("requires LINEAR_API_KEY env var", () => {
    expect(linearConnector.requiredEnvVars).toContain("LINEAR_API_KEY");
  });

  it("has id 'linear'", () => {
    expect(linearConnector.id).toBe("linear");
  });
});
