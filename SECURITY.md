# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: **Security → Report a vulnerability** on this repository. Include:
- what you found;
- how to reproduce it;
- what an attacker could do with it.

You will get an answer as soon as possible. The fix is released before the problem is made public.

## Supported versions

Only the latest release receives security fixes. The app checks for updates at startup.

## Scope

Gian Claudio runs the official Claude Code CLI and stores its own data in `%APPDATA%\GianClaudio`. API keys are kept in Windows Credential Manager, never in plain files. Issues in Claude Code itself should be reported to Anthropic.
