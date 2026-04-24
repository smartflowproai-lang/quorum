# QUORUM — Audit Schedule (Day 1 → Day 10)

**Hackathon**: ETHGlobal OpenAgents · 24 Apr → 03 May 2026
**Submission deadline**: 03.05.2026 sobota

## Daily self-audit (end of each day)

Po każdym commit EOD — 5-min scan:
- [ ] Diff dnia review (git log + git diff main~N..HEAD per day)
- [ ] Żadnych secretów w kodzie (grep `private_key|SECRET|TOKEN=` poza .env)
- [ ] Commit messages opisowe (nie "wip", "fix", "asdf")
- [ ] Każda nowa komponenta ma minimum jeden test lub stub test
- [ ] README aktualizowany jeśli behavior się zmienił

Log: `logs/daily-dN.md` z notatką co działa / co znaleziono / co odłożone

## Heavy audit triggers

### Day 7 (30.04 środa) — `/ultrareview #1 (MVP)`

**Gdy**: po implementacji core features (scout + judge + executor basic loop działa end-to-end)

**Command**: `/ultrareview` w Claude Code session w repo root

**Output**: zapisać full review do `logs/ultrareview-01-mvp.md`, tag commit `d7-audit:ultrareview1`

**Follow-up**: wszystkie HIGH-severity findings → fix + commit `d7-fix:...` przed Day 8

### Day 9 (02.05 piątek) — `/ultrareview #2 (post-fix)`

**Gdy**: po zaaplikowaniu wszystkich Day 7 fix'ów + Day 8 feature work

**Output**: `logs/ultrareview-02-postfix.md`, verify żadnego HIGH-severity nie zostało

**Follow-up**: tylko LOW i MEDIUM OK do ship; HIGH → blok submission

### Day 10 (03.05 sobota, submission day) — `/ultrareview #3 (pre-submit)`

**Gdy**: rano przed submission, po wszystkich final fix

**Output**: `logs/ultrareview-03-presubmit.md`

**Must pass**: zero HIGH severity. Jeśli HIGH znaleziony po 3rd run → wstrzymanie submission do fix.

## 3-stage pipeline (copy deliverables — NIE kod)

Użyć dla:
- Demo video voice script (Day 9)
- Submission write-up (Day 10, README + submission form text)
- Judge-facing materials (architecture diagram description, data-coverage statement)

Pipeline location: `~/Documents/Obsidian Vault/.claude/templates/3stage/`

Procedura: executor → adversarial reviewer → curator (fresh context each). ~12-15 min total per deliverable. Output: `logs/3stage-{deliverable}-final.md`.

## Winning moves (from memory `project_hackathon_winning_moves_8tactics_apr_22.md`)

Beyond basic build — tactics most teams won't do, +20-30% EV:

1. **Live detection log** (Day 4+) — publiczny feed na X pokazujący rug detections w realnym czasie
2. **Hosted demo** (Day 8+) — live URL z działającym QUORUM, nie tylko YouTube video
3. **Judge persona routing** (Day 10) — submission text różny per track (Gensyn vs KH vs Uniswap judges)
4. **Upstream contribution** (Day 3-5) — PR / issue do `gensyn-ai/axl` albo KeeperHub MCP pokazujący że rozumiemy ich tech głęboko
5. **AsterPay KYA cross-sponsor depth** — zintegrować naszą live partnership w demo (Petteri /v1/quality jako 8th KYA component)
6. **Daily sponsor tweets** (Day 1-10) — 1 tweet/day tagujący sponsorów z konkretnym progresem
7. **Early submission** (Day 9 wieczór) — nie w ostatnich 6h przed deadline, wolniej ryzyko błędu
8. **2-min video** — nie 5-min, krótszy + gęściejszy, judges lubią

Checklist w `logs/winning-moves.md` — checkbox per tactic, data wdrożenia.

## OPSEC reminders

- **Start Fresh rule**: repo stworzony 2026-04-24 18:00+ CEST, żaden commit przed
- **AI voiceover ZAKAZANY** dla ETHGlobal demo (natural voice only, ElevenLabs OK dla Colosseum ale NIE dla tej submission)
- **KYC/face-cam/live-call** automatyczny skip (grants filter rule) — async-only judging path CONFIRMED dla partner tracks
- **No Tom Smart real-name leakage** — pseudonym only w README, commits, video
- **PQS stealth** — zero public mention of Protocol Quality Standard w QUORUM context

## Pre-commit sanity (every commit, automatic)

Pre-commit hook w `.githooks/pre-commit` sprawdza:
- Zero secretów (private keys, API tokens) w diffie
- Commit message length > 15 chars (nie "wip" / "fix")
- Brak `console.log("DEBUG_` w production code (warning only)

Activate: `./setup-hooks.sh` po `cp -R` scaffoldu.
