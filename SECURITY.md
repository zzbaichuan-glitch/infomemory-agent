# Security Policy

## Supported versions

The project is under active pre-1.0 development. Security fixes are applied to the current `main` branch. Older commits and experimental branches are not supported.

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, private document, personal data, or tenant identifier. Use GitHub's private vulnerability reporting feature for this repository. If private reporting is unavailable, open a minimal public issue asking the maintainer for a private contact channel without including sensitive details.

Include the affected commit, attack preconditions, impact, a minimal reproduction with synthetic data, and a suggested remediation if known. Never test against a tenant, user, Feishu installation, or service you do not own or have explicit permission to assess.

## Current deployment boundary

InfoMemory Agent is pre-release software. SQLite and the in-process reminder worker are intended for a single-instance pilot. Do not expose the development `trusted_headers` authentication mode to a network. Production mode must use verified Bearer authentication, HTTPS at the ingress, rotated secrets, least-privilege Feishu permissions, encrypted storage/backup controls, rate limiting, monitoring, and a documented incident process.

The project intentionally redacts detected secrets before ordinary persistence, but pattern detection is not a vault. Do not submit real passwords, access tokens, private keys, or database credentials. Store secrets in a dedicated enterprise secret manager and save only a safe reference in InfoMemory.
