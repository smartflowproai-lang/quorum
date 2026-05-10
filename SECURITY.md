# Security policy

## Supported versions

This is a hackathon-era reference codebase, not actively versioned.
Master branch reflects current state — no LTS, no patches backported.

## Reporting vulnerabilities

If you discover a security issue:

- **Cryptographic / signing flaws** (verifier ed25519, attestation chain):
  DM `@TomSmart_ai` on X. I'll respond within 5 business days.
- **Dependency vulnerabilities**: open a public GitHub issue —
  these are safe to discuss openly.
- **Operational concerns** (key handling, .env exposure):
  DM `@TomSmart_ai` on X — same private channel.

## Out of scope

- Treasurer x402 client high-volume safety (acknowledged scaffold-with-tests state)
- Cross-host mesh DDoS resistance (Frankfurt + NYC are demonstration setup)
- KeeperHub MCP authentication patterns (spec evolving — track upstream)

## Acknowledgments

If your report leads to a fix, you'll be credited in the relevant commit
message — unless you prefer otherwise.
