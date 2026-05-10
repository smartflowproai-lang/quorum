# Contributing to QUORUM

Thanks for considering contributing.

This is an honest open-source release of a hackathon project. The codebase is
a working reference for wiring multi-agent x402 systems — it's not a polished
product, but the bits that work are reusable.

## What I'm interested in

- **Bug reports** for the verifier component (ed25519 + ERC-8004 + replay rejection)
- **Test coverage** improvements — current state 78 tests across 4 agents
- **Reusable patterns** documentation — if you've cleaned up a similar pattern
  in your own work, happy to compare notes
- **Honest critique** — what's confusing, what's misleading, what would
  you have done differently

## What I'm not actively maintaining

- Treasurer x402 high-volume client (1 supervised swap demonstration only)
- KeeperHub MCP integration (spec evolving rapidly post-hackathon)
- Cross-host AXL mesh production hardening (Frankfurt + NYC works, but
  zero-ops monitoring is deferred)

## How to contribute

1. Open an issue first if changing >50 lines or touching agent boundaries
2. PRs welcome — include `npm test --if-present` results in description
3. Sign-off commits (`git commit -s`) — Developer Certificate of Origin

## License

MIT — see LICENSE.

## Contact

- GitHub issues for code discussion
- DMs welcome — `@TomSmart_ai` on X for non-public threads
