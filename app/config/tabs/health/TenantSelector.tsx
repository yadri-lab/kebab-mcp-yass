"use client";

/**
 * Phase 53 — tenant dropdown for the Health tab metrics section.
 *
 * Root-scope only. A scoped admin (tenant cookie set) sees nothing;
 * their metrics are already filtered to their own namespace by the
 * request-context layer, so a selector would be misleading.
 *
 * `__all__` is the cross-tenant aggregate sentinel; the default value.
 */

import type { ChangeEventHandler } from "react";

export interface TenantSelectorProps {
  tenantIds: string[];
  value: string;
  onChange: (next: string) => void;
  rootScope: boolean;
}

export const ALL_TENANTS_SENTINEL = "__all__";

export function TenantSelector({ tenantIds, value, onChange, rootScope }: TenantSelectorProps) {
  if (!rootScope) return null;

  const handleChange: ChangeEventHandler<HTMLSelectElement> = (event) => {
    onChange(event.target.value);
  };

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "13px",
        color: "#9ca3af",
      }}
    >
      Tenant
      <select
        value={value}
        onChange={handleChange}
        style={{
          background: "#111827",
          color: "#e5e7eb",
          border: "1px solid #1f2937",
          borderRadius: "4px",
          padding: "4px 8px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "13px",
        }}
      >
        <option value={ALL_TENANTS_SENTINEL}>All tenants (aggregate)</option>
        {tenantIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}
