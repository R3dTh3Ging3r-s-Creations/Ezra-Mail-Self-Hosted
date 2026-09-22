# Contributing to Ezra Mail

Thank you for taking an interest in Ezra Mail. The project is a self-hosted
application under active development.

## Before opening a change

- Use an issue to describe a bug or focused improvement before beginning a
  substantial change.
- Do not submit live mailbox content, account identifiers, private hostnames,
  tokens, environment files, databases, or production logs.
- Use synthetic messages and accounts in tests, documentation, and images.
- Keep provider behavior behind Ezra's exact-review and capability boundaries.
- Do not add a provider integration or broaden mailbox permissions without an
  approved design and provider-specific safety tests.
- External code contributions require acceptance of the
  [Individual Contributor License Agreement](CLA.md). The CLA automation must
  be green before a contribution can merge.
- Documentation-only typo reports may be handled as issues without a CLA. Do
  not submit a documentation change until the maintainers confirm whether the
  change requires a CLA.

## Development gate

Ezra Mail requires Node.js 22. Run the same gate used by the project before
opening a pull request:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run test
npm.cmd run build
npm.cmd run test:e2e
npm.cmd audit --audit-level=high
```

Pull requests should explain the user problem, the design boundary, the tests
run, and any deployment or rollback impact. Small, reviewable changes are
preferred.

## Contribution agreement

External code contributions are accepted only after the contributor has
accepted [CLA.md](CLA.md) and the CLA automation is green. The agreement keeps
contributor ownership while granting Ezra Mail the rights needed to distribute
the contribution under open-source or commercial terms. Documentation-only
typo reports may be opened as issues without a CLA; maintainers will request a
CLA if a proposed documentation change includes substantive original content.
