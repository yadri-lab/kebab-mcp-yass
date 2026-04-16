/**
 * @vitest-environment jsdom
 */
import "./setup";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsTab } from "../../app/config/tabs/settings";

// Mock next/navigation — SettingsTab uses useRouter and useSearchParams
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/config",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock sub-components that would pull in too many deps
vi.mock("../../app/config/tabs/settings/context-file-field", () => ({
  ContextFileField: () => <div data-testid="context-file-field">context field</div>,
}));

vi.mock("../../app/config/tabs/settings/mcp-install-panel", () => ({
  McpInstallPanel: () => <div data-testid="mcp-install-panel">install panel</div>,
}));

vi.mock("../../app/config/tabs/settings/info-tooltip", () => ({
  InfoTooltip: () => <span data-testid="info-tooltip">?</span>,
}));

const mockConfig = {
  timezone: "Europe/Paris",
  locale: "fr-FR",
  displayName: "Yassine",
  contextPath: "System/context.md",
};

describe("SettingsTab", () => {
  it("renders user settings fields with config values", () => {
    render(
      <SettingsTab
        config={mockConfig}
        vaultEnabled={false}
        baseUrl="https://mymcp.example.com"
        hasAuthToken={true}
      />
    );

    // Check that the three user fields are visible
    expect(screen.getByText("Display Name")).toBeInTheDocument();
    expect(screen.getByText("Timezone")).toBeInTheDocument();
    expect(screen.getByText("Locale")).toBeInTheDocument();

    // Check that the input values are pre-filled from config
    const inputs = screen.getAllByRole("textbox");
    const values = inputs.map((i) => (i as HTMLInputElement).value);
    expect(values).toContain("Yassine");
    expect(values).toContain("Europe/Paris");
    expect(values).toContain("fr-FR");
  });

  it("shows the Save settings button", () => {
    render(
      <SettingsTab
        config={mockConfig}
        vaultEnabled={false}
        baseUrl="https://mymcp.example.com"
        hasAuthToken={true}
      />
    );

    expect(screen.getByRole("button", { name: /save settings/i })).toBeInTheDocument();
  });

  it("renders subtab buttons for User settings and MCP install", () => {
    render(
      <SettingsTab
        config={mockConfig}
        vaultEnabled={false}
        baseUrl="https://mymcp.example.com"
        hasAuthToken={true}
      />
    );

    expect(screen.getByRole("button", { name: /user settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mcp install/i })).toBeInTheDocument();
  });
});
