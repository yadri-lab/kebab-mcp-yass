"use client";

export function SkillsTab() {
  return (
    <div className="border border-border rounded-lg p-10 text-center">
      <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mx-auto mb-4">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent"
        >
          <path d="M12 2v20M2 12h20" />
        </svg>
      </div>
      <h2 className="font-semibold text-sm mb-1">Skills</h2>
      <p className="text-sm text-text-dim max-w-sm mx-auto">
        Skills (Claude-style procedural playbooks) are coming in Phase 2. You&rsquo;ll be able to
        author, test, and share reusable multi-tool workflows here.
      </p>
    </div>
  );
}
