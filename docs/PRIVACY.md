# Privacy and data handling

Ezra Mail is self-hosted software, not a hosted mailbox service. The installation
you control stores and processes copies of connected mail, calendar records,
attachments and account credentials. That installation may be on a server separate
from your browser. Protect its filesystem, backups, configuration and network.

Connected email/calendar providers receive API requests under their own policies.
Local AI uses your configured Ollama endpoint; if you choose a hosted model,
relevant content is sent to that provider. Loading remote images can contact the
sender's image host; Ezra provides controls for this in the reader.

Optional Web Push uses a browser-controlled relay with encrypted payloads.
Optional Telegram delivery sends notification content through Telegram and is not
end-to-end encrypted. Generic copy is the default; sender/subject disclosure needs
a separate choice. Browser/OS services and Telegram have their own policies.

The source repository includes no configured user accounts or installation data.
GitHub issues, pull requests and downloads are subject to GitHub's policies. Do not
post private mail, screenshots, credentials or diagnostic dumps in public issues.
Use the [security reporting route](../SECURITY.md) for vulnerabilities.

You are responsible for permission to process connected data, retention, access
and backups. Workplace use requires your organization's approval. Any future Ezra
Cloud offering would need its own separate privacy policy.
