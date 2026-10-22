# Security Policy

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting: open this repository's **Security** tab,
choose **Report a vulnerability**, and describe the issue with steps to reproduce. Please do not open a
public issue or pull request for a vulnerability.

## Scope

In scope:

- The cloud app (`apps/cloud`): authentication, API-key handling, `/api/*` routes including `/api/import`
  and `/api/mcp`, data isolation between users.
- The CLI (`packages/cli`): credential storage, hook and plugin installation, what it uploads.
- The Chrome extension (`packages/extension`): permissions, the data it reads from chat pages and sends on.

Out of scope: findings that need a compromised machine or account, denial of service by volume alone,
and third-party services (Supabase, Vercel, model providers) themselves.

## What to expect

This is a small project with one maintainer. Expect an acknowledgement within 7 days and a status update
within 30 days. Please allow time for a fix before disclosing publicly; credit is given if you want it.
