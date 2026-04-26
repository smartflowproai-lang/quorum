// VERIFIER agent — shared types + zod schemas
// Validates Judge verdicts against on-chain reality + issues ERC-8004-shaped attestations.

import { z } from 'zod';

export type VerdictLabel = 'BUY' | 'WATCH' | 'AVOID';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

// Hard size caps to bound DoS surface from peer-supplied payloads.
export const MAX_REASONING_BYTES = 2_000;
export const MAX_PAYLOAD_BYTES = 16_000;

export const SUPPORTED_CHAINS = [1, 8453, 84532, 11155111] as const; // mainnet, base, base-sepolia, sepolia

export const JudgeVerdictSchema = z
  .object({
    agent: z.literal('judge'),
    verdict: z.enum(['BUY', 'WATCH', 'AVOID']),
    score: z.number().finite().min(0).max(1),
    reasoning: z
      .string()
      .min(1)
      .max(MAX_REASONING_BYTES, `reasoning exceeds ${MAX_REASONING_BYTES} bytes`),
    tokenAddress: z.string().regex(ADDRESS_RE, 'bad token address'),
    chainId: z
      .number()
      .int()
      .refine((c) => (SUPPORTED_CHAINS as readonly number[]).includes(c), {
        message: 'unsupported chainId',
      }),
    txHash: z.string().regex(TX_HASH_RE, 'bad tx hash').optional(),
    blockNumber: z.number().int().nonnegative().optional(),
    emittedAt: z.number().int().positive(),
  })
  .strict();

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface ValidationEvidence {
  blockNumber?: bigint;
  blockHash?: string;
  txExists?: boolean;
  txStatus?: 'success' | 'reverted';
  tokenLogPresent?: boolean;
  observedAt: number;
}

export interface ValidationResult {
  valid: boolean;
  failures: string[];
  evidence: ValidationEvidence;
  validatedAt: number;
}

export interface AttestationPayload {
  verifier: string;
  verdict: JudgeVerdict;
  validation: ValidationResult;
  attestationId: string;
  signature?: string;
  emittedAt: number;
}

export const VerifierIncomingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verdict_request'), verdict: JudgeVerdictSchema }).strict(),
  z
    .object({
      kind: z.literal('reprobe_request'),
      verdict: JudgeVerdictSchema,
      reason: z.string().max(500).optional(),
    })
    .strict(),
]);

export type VerifierIncoming = z.infer<typeof VerifierIncomingSchema>;

export type VerifierOutgoing =
  | { kind: 'attestation'; attestation: AttestationPayload }
  | { kind: 'reprobe_request'; verdict: JudgeVerdict; failures: string[] }
  | { kind: 'reprobe_response'; verdict: JudgeVerdict; validation: ValidationResult };
