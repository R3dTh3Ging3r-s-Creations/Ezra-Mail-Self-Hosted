# Ezra Mail Brand Guide

## Brand idea

Ezra Mail should feel calm, private, and deliberate. It is not an engagement
product and should never look like another noisy inbox.

- Product name: **Ezra Mail**
- Primary tagline: **Your mail, considered.**
- Descriptive line: **Private mail intelligence**
- Voice: concise, assured, transparent, and never alarmist

## Primary mark

D4 is the canonical Ezra Mail mark. Its `EM` monogram, enclosing circle, and
envelope point must stay together. Do not redraw, stretch, rotate, recolor
individual pieces, or place live mailbox content inside the mark.

Tracked assets:

- `ezra-mail-logo-d4-master.png` - preserved source master
- `ezra-mail-logo-d4-app-512.png` - application/App Store style icon
- `ezra-mail-logo-d4-google-120.png` - Google OAuth consent-screen asset
- `ezra-mail-github-social.png` - 1280 x 640 GitHub social preview
- `ezra-mail-today-demo.png` - synthetic-data product screenshot

Runtime copies live under `public/branding/` for app-shell and tab icons.

## Color system

| Role | Hex | Use |
| --- | --- | --- |
| Deep navy | `#0A2735` | navigation, dark backgrounds, primary ink |
| Ezra teal | `#168E92` | active states, identity, calm status |
| Pale teal | `#BFECEA` | supporting text and gentle highlights |
| Warm cream | `#F8F1E7` | logo linework and warm light contrast |
| Paper | `#F4F6F7` | application background |
| White | `#FFFFFF` | cards and readable negative space |

Use red only for destructive actions or genuine failures. Avoid using urgent
colors merely to create visual excitement.

## Image safety

- Public or repository screenshots must use synthetic accounts, senders,
  subjects, and message content.
- Never publish screenshots from the live Gmail or Hotmail workspaces.
- Do not include Tailscale hostnames, private IP addresses, provider tokens,
  account identifiers, or Activity details from production.
- Prefer the Today view for product imagery because it communicates Ezra's calm
  hierarchy without resembling a conventional inbox dump.

## Regeneration

After a production build, regenerate the GitHub social card and synthetic
product screenshot with:

```powershell
npm.cmd run branding:generate
```

Visually inspect both PNG files before committing them. Regeneration is manual
so normal test runs never modify tracked branding assets.
