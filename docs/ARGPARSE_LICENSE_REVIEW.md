# Reviewed argparse replacement

Eric approved the Mammoth-only argparse 2.0.1 replacement and license review on October 6, 2026. This is a bounded dependency repair to remove GHSA-hp3w-g68c-fv3c / CVE-2026-97058 from the installed graph, not an audit waiver.

## Dependency decision

The installed path was mammoth 1.12.0 -> argparse 1.0.10 -> sprintf-js 1.0.3. No patched sprintf-js release exists; Mammoth 1.13.0 still declares argparse ~1.0.3. The scoped override uses argparse 2.0.1 while retaining Mammoth 1.12.0 and its DOCX library API. Argparse 2.0.1 has no runtime dependencies and uses its own limited string substitution implementation, without the vulnerable precision conversions. It retains the deprecated version-1 argument API used by Mammoth's CLI. Version 3 removes that compatibility API and is outside this repair.

This override crosses Mammoth's declared range. Installed dependency removal, real DOCX extraction, invalid document rejection, CLI help, output files, style maps and conflicting destinations are regression-tested. CLI compatibility calls may emit upstream deprecation warnings; the application imports Mammoth's library and does not invoke that CLI. Revisit the override when Mammoth adopts a safe dependency. Do not silently float it to argparse 3 or replace the document reader.

## License evidence and obligations

The argparse 2.0.1 package declares Python-2.0. Its complete upstream LICENSE includes the PSF version-2 terms and retained BeOpen, CNRI and CWI historical notices. Preserve the complete file and copyright notices with distribution; do not relabel the package MIT or strip historical sections. The upstream source is unmodified; the only Ezra change is dependency selection. The source's copyright notices credit the Python Software Foundation (2010-2020) and argparse.js authors (2020).

- Source: https://github.com/nodeca/argparse/tree/2.0.1
- Exact published tarball: https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz
- Complete retained license: [argparse-2.0.1.txt](licenses/argparse-2.0.1.txt)
- License SHA256: de4d1f2d2ad5ad0cfd1657a106476b31cb5db5ef9d1ff842b237c0c81f0c8a23
- Installed evidence: node_modules/argparse/LICENSE; declared version 2.0.1

The existing license checker verifies the exact installed package/version, evidence path, hash and required license sections before emitting the reviewed inventory row. Python-2.0 is not approved globally: only this evidenced package/version/path is accepted. Missing or changed license evidence and other packages/versions remain rejected. NOTICE and the public export retain attribution and the complete license. No npm audit exception, threshold reduction or dependency identity disguise is used.

## Acceptance boundary

Production remains on the previously deployed revision until the replacement candidate passes focused checks, independent review and exact-head Thing2 security/release qualification, and its exact deployment approval is settled. Personal-account activation, owner passkey/key entry, provider acceptance and fresh reminder duplicate checks remain separate. No provider permission or work-account change is part of this dependency repair.