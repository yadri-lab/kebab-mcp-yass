# Security Policy

## Supported Versions

Only the latest minor release of MyMCP receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.x (latest) | :white_check_mark: |
| < 0.x (older minor) | :x: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report security vulnerabilities by emailing the maintainer at the address listed on the [GitHub profile](https://github.com/Yassinello). You can also open a [GitHub Security Advisory](https://github.com/Yassinello/mymcp/security/advisories/new) directly.

Please include as much of the following as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Affected versions
- Any suggested mitigation or fix

**Response timeline:**

- **48 hours** — acknowledgement of your report
- **7 days** — initial assessment and severity determination
- **30 days** — target resolution (complex issues may take longer; we will keep you informed)

We take all security reports seriously and will respond as promptly as possible.

## Scope

The following are considered in-scope vulnerabilities:

- Authentication bypass or privilege escalation (admin token, user token, per-tool access controls)
- Server-Side Request Forgery (SSRF) via tool handlers or proxy routes
- Injection vulnerabilities (command injection, prompt injection with data exfiltration)
- Token or credential leakage through logs, error messages, or API responses
- Insecure default configurations that expose sensitive data
- OAuth flow vulnerabilities (token theft, open redirect, PKCE bypass)
- Unauthorized access to another user's MCP tools or data

## Out of Scope

The following are **not** considered in-scope:

- Denial-of-service attacks against self-hosted instances (you control your own infrastructure)
- Social engineering attacks targeting users or maintainers
- Vulnerabilities in third-party dependencies — please report those to the respective upstream projects
- Issues that require physical access to the host machine
- Rate limiting on self-hosted deployments (configurable by operators)
- Theoretical attacks with no practical exploit path

## Disclosure Policy

We follow a **coordinated disclosure** model:

1. You report the vulnerability to us privately.
2. We investigate, confirm, and develop a fix.
3. We release the fix and publish a security advisory.
4. You may publicly disclose after **90 days** from the initial report date, or after the fix is released (whichever comes first).

We will credit you in the security advisory unless you prefer to remain anonymous.

## Security Best Practices

When self-hosting MyMCP, follow these guidelines:

### Token Management

- **Admin token** (`ADMIN_TOKEN`): keep this secret and separate from user-facing tokens. Never expose it in client-side code or logs.
- **User tokens**: rotate regularly, especially if you suspect exposure. Use the admin API to revoke compromised tokens.
- Store all secrets in environment variables — never hard-code them in source files.

### Environment Variable Hygiene

- Use `.env.local` for local development. This file is in `.gitignore` and must never be committed.
- On Vercel or other platforms, use the platform's secret management UI to set environment variables.
- Audit your deployment environment variables periodically to remove stale credentials.

### Admin Token Separation

- Use a strong, randomly generated admin token (e.g., `openssl rand -hex 32`).
- Do not reuse your admin token as a user token.
- Restrict admin endpoints (`/api/admin/*`) at the network level if possible (e.g., Vercel's IP allowlist).

### OAuth Credentials

- Register your OAuth app with the minimal required scopes.
- Keep `CLIENT_SECRET` values server-side only — they must never appear in client bundles.
- Review OAuth app permissions periodically and revoke unused grants.
