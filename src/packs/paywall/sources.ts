/**
 * Paywall source registry.
 *
 * Each source describes how to detect a URL that belongs to it, where its
 * session cookie lives (env var + cookie name), and how a user can obtain
 * the cookie from their logged-in browser. The `/config → Packs → Paywall`
 * card renders the `howToGetCookie` markdown verbatim.
 */

export interface PaywallSource {
  /** Stable source id (used in tool output) */
  id: "medium" | "substack";
  /** Human-readable label for UI */
  displayName: string;
  /** Returns true if the URL belongs to this source */
  domainMatch: (url: URL) => boolean;
  /** Env var holding the session cookie value */
  cookieEnvVar: string;
  /** Name of the cookie to send in the `Cookie` header */
  cookieName: string;
  /** Human-readable cookie lifetime, shown in /config */
  cookieLifetime: string;
  /** Markdown instructions, rendered in /config */
  howToGetCookie: string;
}

function isMediumDomain(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "medium.com" || host.endsWith(".medium.com")) return true;
  // Medium-hosted community publications
  const mediumHosted = [
    "towardsdatascience.com",
    "betterprogramming.pub",
    "levelup.gitconnected.com",
    "uxdesign.cc",
    "blog.bitsrc.io",
    "medium.freecodecamp.org",
  ];
  return mediumHosted.includes(host);
}

function isSubstackDomain(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "substack.com" || host.endsWith(".substack.com")) return true;
  // Substack-hosted custom domains are harder to detect from the URL alone.
  // V1: only match the *.substack.com pattern. Custom domains can be handled
  // by the Tier 2 `read_paywalled_hard` tool once rendered HTML is available.
  return false;
}

export const SOURCES: PaywallSource[] = [
  {
    id: "medium",
    displayName: "Medium",
    domainMatch: isMediumDomain,
    cookieEnvVar: "MEDIUM_SID",
    cookieName: "sid",
    cookieLifetime: "~1 year",
    howToGetCookie: [
      "1. Open [medium.com](https://medium.com) in Chrome while logged in",
      "2. Open DevTools → **Application** → **Cookies** → `medium.com`",
      "3. Copy the value of the `sid` cookie",
      "4. Paste it here and click **Save**",
      "",
      "_Tip: if articles come back empty, your cookie has expired — re-extract it._",
    ].join("\n"),
  },
  {
    id: "substack",
    displayName: "Substack",
    domainMatch: isSubstackDomain,
    cookieEnvVar: "SUBSTACK_SID",
    cookieName: "substack.sid",
    cookieLifetime: "~30 days",
    howToGetCookie: [
      "1. Open any Substack you are subscribed to, logged in",
      "2. Open DevTools → **Application** → **Cookies** → `*.substack.com`",
      "3. Copy the value of the `substack.sid` cookie",
      "4. Paste it here and click **Save**",
      "",
      "_Substack cookies expire roughly every 30 days; refresh when articles start returning empty._",
    ].join("\n"),
  },
];

/** True if at least one paywall source has its cookie configured. */
export function hasAtLeastOneSource(env: NodeJS.ProcessEnv = process.env): boolean {
  return SOURCES.some((s) => !!env[s.cookieEnvVar]?.trim());
}
