"use client";

import { useState } from "react";
import type { InstanceConfig } from "@/core/types";

const FIELDS: {
  key: string;
  label: string;
  placeholder: string;
  help: string;
}[] = [
  {
    key: "MYMCP_DISPLAY_NAME",
    label: "Display Name",
    placeholder: "Your name",
    help: "Shown in the dashboard and tool greetings.",
  },
  {
    key: "MYMCP_TIMEZONE",
    label: "Timezone",
    placeholder: "Europe/Paris",
    help: "IANA format. Used to format dates in tool responses.",
  },
  {
    key: "MYMCP_LOCALE",
    label: "Locale",
    placeholder: "fr-FR",
    help: "Used to format numbers and currencies.",
  },
  {
    key: "MYMCP_CONTEXT_PATH",
    label: "Context File Path",
    placeholder: "System/context.md",
    help: "Vault path for the personal context file read by my_context.",
  },
];

export function SettingsTab({ config }: { config: InstanceConfig }) {
  const [values, setValues] = useState<Record<string, string>>({
    MYMCP_DISPLAY_NAME: config.displayName,
    MYMCP_TIMEZONE: config.timezone,
    MYMCP_LOCALE: config.locale,
    MYMCP_CONTEXT_PATH: config.contextPath,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vars: values }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        alert(data.error || "Save failed");
      }
    } catch {
      alert("Network error");
    }
    setSaving(false);
  };

  return (
    <div className="max-w-2xl">
      <div className="border border-border rounded-lg p-5 space-y-5">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-sm font-medium">{f.label}</label>
              <code className="text-[11px] text-text-muted">{f.key}</code>
            </div>
            <input
              type="text"
              placeholder={f.placeholder}
              value={values[f.key] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
            <p className="text-xs text-text-muted mt-1">{f.help}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="bg-accent text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-accent/90 disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        {saved && <span className="text-xs text-green">Saved</span>}
      </div>
    </div>
  );
}
