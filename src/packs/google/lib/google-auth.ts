let cachedToken: { access_token: string; expires_at: number } | null = null;

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export async function getGoogleAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5min margin)
  if (cachedToken && Date.now() < cachedToken.expires_at - 300_000) {
    return cachedToken.access_token;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && "GOOGLE_CLIENT_ID",
      !clientSecret && "GOOGLE_CLIENT_SECRET",
      !refreshToken && "GOOGLE_REFRESH_TOKEN",
    ].filter(Boolean);
    throw new GoogleAuthError(
      `Missing env vars: ${missing.join(", ")}`,
      "missing_config",
      "Add the missing variables in Vercel → Settings → Environment Variables, then redeploy."
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();

  if (!data.access_token) {
    const errorCode = data.error || "unknown";
    const errorDesc = data.error_description || "";

    const hints: Record<string, string> = {
      invalid_client:
        "OAuth client does not exist or was deleted. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel, then verify the app exists in Google Cloud Console → Credentials.",
      invalid_grant:
        "Refresh token was revoked or expired. Use the /setup page to re-authenticate, then update GOOGLE_REFRESH_TOKEN in Vercel.",
      unauthorized_client:
        "OAuth client is not authorized for this grant type. Verify the app type in Google Cloud Console.",
      invalid_scope:
        "One or more requested scopes are not authorized. Check scopes in Google Cloud Console → OAuth consent screen → Scopes.",
    };

    throw new GoogleAuthError(
      `Google OAuth failed: ${errorCode} — ${errorDesc}`,
      errorCode,
      hints[errorCode] || `Unknown error (${errorCode}). Check the 3 GOOGLE_* env vars in Vercel.`
    );
  }

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return cachedToken.access_token;
}
