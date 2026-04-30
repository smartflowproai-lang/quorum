# Chaos Test — AXL Mesh Partition + Recovery

I run QUORUM on a two-VPS AXL mesh: Frankfurt (`143.244.204.114`, scout + judge) and NYC (`159.65.172.200`, executor + treasurer + verifier). Multi-continent verification is the Gensyn differentiator I'm leaning on. A claim like that is only as good as the partition test I'm willing to run on it, so I ran one.

This document captures what I broke, how the mesh reacted, and how long it took to come back. Raw log: `/tmp/axl-chaos.log` on Frankfurt VPS-A.

## Setup

- Frankfurt AXL node under PM2 (`axl-frankfurt`, id 41), Yggdrasil TLS listener on `:9001`, HTTP send endpoint on `127.0.0.1:9002`.
- NYC peer dialing in: pubkey `201:a3c8:3a3b:a533:bcb8:1e08:43f9:b687`, source `159.65.172.200`.
- Pre-test baseline: Frankfurt online 7d, 84K+ messages exchanged historically, ESTAB connection from NYC continuously held.
- Frankfurt public key (stable across restart): `68d7077e6de7ac306b0af0fa1c10545c19e338b0cc43b522b56a9b5c1e8d586e`.

I drove the test from Frankfurt only. NYC SSH is not reachable under my current keys, so the "kill NYC verifier" case is simulated with iptables — from Frankfurt's point of view, packet drop to `159.65.172.200` is indistinguishable from NYC dying. The reverse direction (kill Frankfurt) is the real thing: `pm2 stop axl-frankfurt`.

## Test A — Process kill on Frankfurt (`pm2 stop` / `pm2 start`)

Worst case for the mesh: the local AXL process exits, every TCP socket is torn down by the kernel, ports get released. NYC sees its peer disappear immediately.

| Marker | Time (UTC) | Δ |
|---|---|---|
| `pm2 stop axl-frankfurt` | 2026-04-30T18:12:25Z | T0 |
| Listener gone, ESTAB to NYC torn down | T0 + 2s | confirmed via `ss -tlnp` and `ss -tn` |
| `pm2 start axl-frankfurt` | 2026-04-30T18:12:52Z | downtime = **27s** (held intentionally) |
| NYC re-dialed and ESTAB restored | 2026-04-30T18:12:56Z | **4s** after start |

Log evidence after restart (from `pm2 logs axl-frankfurt`):

```
[node] TLS listener started on [::]:9001
[node] Our Public Key: 68d7077e6de7ac306b0af0fa1c10545c19e338b0cc43b522b56a9b5c1e8d586e
Listening on 127.0.0.1:9002
[node] Connected inbound: 201:a3c8:3a3b:a533:bcb8:1e08:43f9:b687@159.65.172.200:41648, source 10.19.0.5:9001
```

The new ESTAB landed on a fresh ephemeral port (`41648` vs the pre-kill `47438`), which is how I know NYC actually re-dialed instead of the kernel handing me back a stale socket. Same Frankfurt pubkey survives the restart, so the verifier identity stays stable for downstream agents.

## Test B — Short network partition (76s, kernel-side)

I dropped all packets between Frankfurt and `159.65.172.200` for 76 seconds with iptables, then healed.

```
iptables -I INPUT  1 -s 159.65.172.200 -j DROP
iptables -I OUTPUT 1 -d 159.65.172.200 -j DROP
```

| Marker | Time (UTC) | Notes |
|---|---|---|
| Partition start | 2026-04-30T18:10:46Z | T0 |
| ESTAB still present at T+60s | — | TCP retransmit not yet exceeded |
| `axl-frankfurt` status during partition | online, restarts=700 (no flap) | `/send` endpoint kept returning HTTP 400 (expected — empty body) |
| Partition heal | 2026-04-30T18:12:02Z | duration **76s** |
| ESTAB still ESTAB after heal | — | recovery = **0s**, app-level renegotiation not needed |

A 76s partition sits below the kernel's TCP retransmit budget under default `tcp_retries2`, so the socket survives kernel-side. From the application's view the blip is invisible — packets queue, drain on heal, no reconnect required. This is actually the case I want to see for transient WAN hiccups: short outages auto-heal without restart cost.

## Test C — Long partition (243s, app-level pressure)

Same iptables setup, held for ~4 minutes to push past short-RTO behaviour.

| Marker | Time (UTC) | Notes |
|---|---|---|
| Partition start | 2026-04-30T18:13:23Z | T0 |
| ESTAB persisted entire 240s | — | kernel still retrying — Linux default `tcp_retries2=15` is ~924s budget |
| `axl-frankfurt` status during partition | online, no restart | process did not crash or self-reset |
| Partition heal | 2026-04-30T18:17:26Z | duration **243s** |
| Old socket transitioned through FIN-WAIT-1 | — | NYC peer had given up and re-dialed during partition |
| New ESTAB to NYC on port `58252` | by 2026-04-30T18:19:12Z | recovery within ~100s of heal — peer-side reconnect |

Across the partition, three distinct ephemeral ports show up on the connection (`47438` → `41648` → `58252`), which is the trail of three real reconnect handshakes (initial baseline → post-Test-A → post-Test-C). That's the evidence I trust: the mesh is not just keeping a stale socket alive, it's renegotiating end-to-end when something actually breaks.

## Partition tolerance window

Synthesizing the three cases:

- **Process death (Test A)**: 4-second app-level reconnect once the process is back. Bottleneck is `pm2 start` time + first NYC retry tick. Any downtime envelope dominated by how long I leave the process stopped.
- **Short partition < ~120s (Test B)**: invisible to the app. Kernel TCP holds the socket, packets drain on heal, recovery cost = 0.
- **Long partition > ~3min (Test C)**: NYC peer eventually gives up and re-dials when the network heals. Frankfurt-side process never crashes. End-to-end recovery within ~100s of heal under default kernel TCP timing.
- **Identity stable**: Frankfurt's public key survives every restart. Downstream agents (scout/judge) can treat the mesh address as durable.

What I'm explicitly not claiming: that I've measured the NYC-process-death case — that needs SSH I don't have today. Closest proxy is Test C (long partition), which the data covers.

## Recovery verification (post all tests)

`/tmp/axl-chaos.log` end-of-run snapshot at 2026-04-30T18:19:12Z:

```
iptables INPUT/OUTPUT to 159.65.172.200: clean
axl-frankfurt: online, pid 710093
Listeners: 127.0.0.1:9002 (HTTP), [::]:9001 (TLS)
ESTAB to NYC: 159.65.172.200:58252 (active)
/send endpoint: HTTP 400 (reachable)
```

Mesh fully recovered before exit.

## Reproducing

Run `/tmp/axl-chaos.log` again with the same iptables / `pm2 stop|start` sequence on Frankfurt VPS-A. Total wall-clock ≈ 9 minutes including the long partition. Watch:

- `ss -tnp | grep 159.65.172.200` for TCP state.
- `pm2 logs axl-frankfurt --lines 100` for handshake log lines.
- `curl -X POST http://127.0.0.1:9002/send -d '{}'` for app-level liveness (HTTP 400 = listener up, body invalid as expected).

---

Built by Tom Smart for ETHGlobal OpenAgents 2026. Frankfurt VPS-A `143.244.204.114`, NYC VPS-B `159.65.172.200`.
