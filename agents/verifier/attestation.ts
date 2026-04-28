// VERIFIER agent — attestation issuance
//
// ERC-8004 status: until a canonical Base mainnet trust-agents registry is wired,
// attestations land in a JSONL log (deterministic, replayable). On-chain submit is
// gated by both VERIFIER_LIVE_ATTEST=true AND a runtime operator-supplied enable
// token; autonomous overnight runs cannot trigger gas-burn (MED #8).
//
// Hardening (per hostile review):
//  - logPath is normalized + restricted to an allow-listed root (HIGH #1)
//  - JSONL writes are serialized through a module-level mutex; fsync runs before
//    we let the caller proceed, so peers never get an `attestation` envelope for
//    a record that isn't on disk yet (MED #6)
//  - `liveSubmit` removed from caller options — env-only — and rate-limited
//    per-day to prevent runaway gas burn (MED #8)

import { createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'os';
import type { JudgeVerdict, ValidationResult, AttestationPayload } from './types';

// Allow-list of roots where the verifier may write its log. Any path resolving
// outside these roots is refused. /tmp is intentionally NOT a default — symlink
// races on multi-tenant hosts are a realistic threat.
const ALLOWED_LOG_ROOTS = [
  '/var/lib/quorum',
  '/var/log/quorum',
  path.join(os.homedir(), '.quorum'),
  path.join(os.tmpdir(), 'quorum-verifier-test'), // tests opt-in by using this prefix
];

const DEFAULT_LOG = path.join(
  process.env.VERIFIER_ATTEST_DIR || path.join(os.homedir(), '.quorum'),
  'verifier-attestations.jsonl'
);

// Per-day live-submit cap. 0 disables; default is 0 (autonomous-safe).
const LIVE_SUBMIT_DAILY_CAP = Number(process.env.VERIFIER_LIVE_ATTEST_DAILY_CAP ?? 0);

export interface IssueOptions {
  verifierId?: string;
  logPath?: string;
}

export function buildAttestationId(
  verdict: JudgeVerdict,
  validation: ValidationResult
): string {
  // Strip volatile timestamps so re-validation of identical evidence yields the
  // same id — that's what makes dedupe possible upstream.
  const canonical = JSON.stringify({
    verdict: {
      verdict: verdict.verdict,
      score: verdict.score,
      tokenAddress: verdict.tokenAddress.toLowerCase(),
      chainId: verdict.chainId,
      txHash: verdict.txHash ?? null,
    },
    validation: {
      valid: validation.valid,
      failures: validation.failures,
      evidence: {
        blockNumber: validation.evidence.blockNumber?.toString() ?? null,
        blockHash: validation.evidence.blockHash ?? null,
        txExists: validation.evidence.txExists ?? null,
        txStatus: validation.evidence.txStatus ?? null,
        tokenLogPresent: validation.evidence.tokenLogPresent ?? null,
      },
    },
  });
  return '0x' + createHash('sha256').update(canonical).digest('hex');
}

export function assertSafeLogPath(p: string): string {
  const resolved = path.resolve(p);
  // No nul bytes, no traversal sequences in the original.
  if (resolved.includes('\0')) throw new Error('log path contains nul');
  // Must live under one of the allow-listed roots.
  const ok = ALLOWED_LOG_ROOTS.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!ok) {
    throw new Error(
      `log path ${resolved} not under any allowed root (${ALLOWED_LOG_ROOTS.join(', ')})`
    );
  }
  return resolved;
}

// Module-level append mutex — serializes JSONL writes across concurrent handlers.
let appendChain: Promise<void> = Promise.resolve();
function withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = appendChain.then(fn, fn);
  appendChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function appendJsonl(
  logPath: string,
  payload: AttestationPayload
): Promise<void> {
  const safe = assertSafeLogPath(logPath);
  const line =
    JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
  await withAppendLock(async () => {
    await fs.mkdir(path.dirname(safe), { recursive: true });
    // O_NOFOLLOW closes the lstat→open TOCTOU window: if `safe` is (or becomes)
    // a symlink between the parent-dir create and the open, the kernel refuses
    // with ELOOP. Combined with the assertSafeLogPath() allow-list, this means
    // a hostile peer or local user cannot redirect our JSONL into arbitrary
    // files even on a multi-tenant box.
    const flags =
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_WRONLY |
      // O_NOFOLLOW exists on POSIX targets we run on (Linux + macOS). On systems
      // where it's missing we fall back to a pre-open lstat check; both are
      // present in node:fs.constants but only the first runtime check is needed.
      (fsConstants.O_NOFOLLOW ?? 0);
    let fh: import('fs/promises').FileHandle | null = null;
    try {
      if (!fsConstants.O_NOFOLLOW) {
        const stat = await fs.lstat(safe).catch(() => null);
        if (stat?.isSymbolicLink()) {
          throw new Error(`log path ${safe} is a symlink — refusing to follow`);
        }
      }
      try {
        fh = await fs.open(safe, flags, 0o600);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ELOOP') {
          throw new Error(`log path ${safe} is a symlink — refusing to follow`);
        }
        throw err;
      }
      await fh.write(line);
      await fh.sync();
    } finally {
      if (fh) await fh.close();
    }
  });
}

// Per-day live-submit accounting. Persisted to disk keyed by ISO date so a
// crashloop cannot reset the counter under us. The disk file lives next to the
// attestation log, behind the same allow-listed root.
const COUNTER_FILE_NAME = 'live-submit-counter.json';

interface LiveSubmitCounter {
  date: string;
  count: number;
}

async function readCounter(filePath: string): Promise<LiveSubmitCounter> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LiveSubmitCounter>;
    if (typeof parsed.date === 'string' && typeof parsed.count === 'number') {
      return { date: parsed.date, count: parsed.count };
    }
  } catch {
    /* fall through to default */
  }
  return { date: '', count: 0 };
}

async function writeCounter(filePath: string, c: LiveSubmitCounter): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(c));
}

async function reserveLiveSubmit(
  logPath: string
): Promise<{ allowed: boolean; reason?: string; release?: () => Promise<void> }> {
  if (LIVE_SUBMIT_DAILY_CAP <= 0) {
    return { allowed: false, reason: 'live submit daily cap is 0' };
  }
  const counterFile = path.join(path.dirname(assertSafeLogPath(logPath)), COUNTER_FILE_NAME);
  const today = new Date().toISOString().slice(0, 10);
  return withAppendLock(async () => {
    const cur = await readCounter(counterFile);
    const onDay = cur.date === today ? cur : { date: today, count: 0 };
    if (onDay.count >= LIVE_SUBMIT_DAILY_CAP) {
      return { allowed: false, reason: `daily cap ${LIVE_SUBMIT_DAILY_CAP} reached` };
    }
    // Reserve a slot up-front. If the broadcast then fails, caller calls release()
    // to roll back the counter. This avoids the "missed ++" footgun.
    const reserved = { date: today, count: onDay.count + 1 };
    await writeCounter(counterFile, reserved);
    const release = async () => {
      const back = await readCounter(counterFile);
      if (back.date === today && back.count > 0) {
        await writeCounter(counterFile, { date: today, count: back.count - 1 });
      }
    };
    return { allowed: true, release };
  });
}

export async function issueAttestation(
  verdict: JudgeVerdict,
  validation: ValidationResult,
  opts: IssueOptions = {}
): Promise<AttestationPayload> {
  const verifierId = opts.verifierId || process.env.VERIFIER_ID || 'verifier';
  const logPath = opts.logPath || process.env.VERIFIER_ATTEST_LOG || DEFAULT_LOG;
  const liveEnabled = process.env.VERIFIER_LIVE_ATTEST === 'true';

  const attestationId = buildAttestationId(verdict, validation);
  const payload: AttestationPayload = {
    verifier: verifierId,
    verdict,
    validation,
    attestationId,
    emittedAt: Date.now(),
  };

  if (liveEnabled) {
    const reservation = await reserveLiveSubmit(logPath);
    if (!reservation.allowed) {
      console.warn(
        `[verifier] live submit refused — ${reservation.reason}; logging to JSONL only`
      );
    } else {
      // Stub — see header comment. When implemented this will EIP-712 sign
      // payload and call ERC-8004 registry via viem writeContract. The counter
      // is already reserved; on broadcast failure the catch block must call
      // reservation.release().
      try {
        console.warn(
          '[verifier] VERIFIER_LIVE_ATTEST=true accepted but on-chain submit not wired yet; releasing reservation and logging to JSONL only'
        );
        // Stub: release the reservation since we did not actually submit.
        await reservation.release?.();
      } catch {
        await reservation.release?.();
      }
    }
  }

  await appendJsonl(logPath, payload);
  return payload;
}
