// VERIFIER agent — verdict validator
// Layered checks:
//   1. Schema parse via zod (caller does this at boundary; we re-assert here as a guard).
//   2. On-chain consistency: chainId match, tx existence, tx success, token log presence.
// All probe error messages are mapped to generic strings so RPC URLs / API keys never
// leak across trust boundaries (see hostile review HIGH/MED #2, #7).

import {
  JudgeVerdictSchema,
  type JudgeVerdict,
  type ValidationEvidence,
  type ValidationResult,
} from './types';

export interface ProbeReceipt {
  blockNumber: bigint;
  blockHash: string;
  status: 'success' | 'reverted';
  // Logs touched by this tx — used to confirm tokenAddress is actually involved.
  // Empty array means "no logs"; undefined means "probe did not return logs".
  logs?: Array<{ address: string }>;
}

// Probe is bound to a specific chainId — validator refuses to use a probe whose
// chainId mismatches the verdict.chainId (HIGH #2).
export interface OnChainProbe {
  readonly chainId: number;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<ProbeReceipt | null>;
}

export interface ValidatorOptions {
  probe?: OnChainProbe;
  // When true, txHash MUST be present and probe MUST validate it (HIGH #5).
  requireOnChain?: boolean;
}

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function validateVerdict(
  verdict: JudgeVerdict,
  opts: ValidatorOptions = {}
): Promise<ValidationResult> {
  const failures: string[] = [];
  const evidence: ValidationEvidence = { observedAt: Date.now() };

  // Re-assert schema as a defense-in-depth (callers should already have parsed,
  // but this catches direct test/internal calls with bad shapes).
  const parsed = JudgeVerdictSchema.safeParse(verdict);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      failures.push(`${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    return { valid: false, failures, evidence, validatedAt: Date.now() };
  }

  // requireOnChain enforcement BEFORE the txHash branch — closes HIGH #5 bypass.
  if (opts.requireOnChain) {
    if (!verdict.txHash) {
      failures.push('on-chain probe required but verdict has no txHash');
    } else if (!opts.probe) {
      failures.push('on-chain probe required but no probe configured');
    }
  }

  // chainId binding — refuse to use a probe pointed at a different chain (HIGH #2).
  if (opts.probe && opts.probe.chainId !== verdict.chainId) {
    failures.push(
      `probe chainId ${opts.probe.chainId} does not match verdict chainId ${verdict.chainId}`
    );
  }

  if (verdict.txHash && opts.probe && opts.probe.chainId === verdict.chainId) {
    try {
      const receipt = await opts.probe.getTransactionReceipt({
        hash: verdict.txHash as `0x${string}`,
      });
      if (!receipt) {
        failures.push(`tx not found: ${verdict.txHash.slice(0, 10)}…`);
        evidence.txExists = false;
      } else {
        evidence.txExists = true;
        evidence.blockNumber = receipt.blockNumber;
        evidence.blockHash = receipt.blockHash;
        evidence.txStatus = receipt.status;
        if (receipt.status !== 'success') {
          failures.push('tx reverted');
        }
        // Token-log linkage — closes HIGH #2: a successful unrelated tx no longer
        // satisfies the verifier. If logs were not returned by the probe we record
        // tokenLogPresent=undefined (caller decides if that's acceptable; default
        // policy below treats missing logs as a soft-warn, not a hard fail).
        if (Array.isArray(receipt.logs)) {
          const present = receipt.logs.some((l) => eqAddr(l.address, verdict.tokenAddress));
          evidence.tokenLogPresent = present;
          if (!present) {
            failures.push('tx does not touch the verdict tokenAddress');
          }
        }
      }
    } catch {
      // NEVER propagate raw err.message — it can carry RPC URL with API key (MED #7).
      failures.push('probe error: rpc call failed');
    }
  }

  return {
    valid: failures.length === 0,
    failures,
    evidence,
    validatedAt: Date.now(),
  };
}
