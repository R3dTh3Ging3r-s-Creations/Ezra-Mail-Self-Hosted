# Security Policy

Ezra Mail processes private communications and treats security and privacy
reports as confidential by default.

The sanitized public source repository is named `Ezra-Mail-Self-Hosted`. This policy is its
public-facing vulnerability-reporting guidance; the private operational source
is not published.

## Supported version

Security fixes target the latest documented pre-release. Older
revisions may be useful rollback points, but they do not receive separate
security maintenance.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include mailbox
content, credentials, private addresses, or exploit details in public text.

Use GitHub's **Report a vulnerability** / private security-advisory flow for
this repository. Include:

- the affected revision or release;
- the deployment surface involved;
- the minimum sanitized reproduction;
- the likely privacy or safety impact; and
- whether provider credentials or mailbox state may have been exposed.

If private reporting is unavailable in your copy of the repository,
contact the repository owner through the GitHub profile associated with the
project and request a private channel before sharing details.

## Security boundaries

Production credentials, environment files, SQLite data, attachments, private
hostnames, and recovery material never belong in Git. Incoming mail is
untrusted input and cannot authorize tools or approve provider actions. Sending
continues to require exact review of the final account, recipients, body,
attachments, version, and content hash.
