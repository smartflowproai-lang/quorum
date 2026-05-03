#!/usr/bin/env node
/**
 * QUORUM verdict attestation TX decoder + verifier
 *
 * Decodes calldata of the attestation TX (default: 0x19bb1d0e...e1763f22) and
 * cryptographically verifies the embedded ed25519 signatures against the
 * pubkeys carried in the payload. Anyone can run this — no QUORUM-side state
 * required, only a Base mainnet RPC.
 *
 * Usage:
 *   node decode-attestation-tx.mjs                          # decode default TX
 *   node decode-attestation-tx.mjs <tx_hash>                # decode another QUORUM attestation TX
 *
 * Calldata format (per QUORUMV1 marker):
 *   bytes 0-7    ASCII "QUORUMV1"
 *   bytes 8-9    payload length (uint16 BE)
 *   bytes 10..   JSON payload UTF-8
 *   next 64      Frankfurt Judge ed25519 signature
 *   next 64      NYC Verifier ed25519 signature
 *
 * Payload JSON contains:
 *   judge_pubkey_hex      — DER SPKI Frankfurt Judge pubkey
 *   verifier_pubkey_hex   — DER SPKI NYC Verifier pubkey
 *   evidence_hash         — sha256 of canonical evidence
 *   verdict, ts, etc.
 */

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createPublicKey, verify as verifySig } from "node:crypto";

const DEFAULT_TX = "0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22";
const txHash = process.argv[2] || DEFAULT_TX;

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

console.log("QUORUM attestation TX decoder + verifier");
console.log("=" .repeat(60));
console.log("TX hash:", txHash);

const tx = await publicClient.getTransaction({ hash: txHash });
console.log("Block:", tx.blockNumber.toString());
console.log("From:", tx.from);
console.log("To:", tx.to);
console.log("Value:", tx.value.toString(), "wei");
console.log();

const calldata = Buffer.from(tx.input.replace(/^0x/, ""), "hex");
console.log("Calldata size:", calldata.length, "bytes");

// Verify marker
const marker = calldata.slice(0, 8).toString("utf8");
if (marker !== "QUORUMV1") {
  console.error(`ERROR: marker mismatch (expected QUORUMV1, got ${marker})`);
  process.exit(1);
}
console.log("Marker:", marker, "OK");

// Read payload length
const payloadLen = calldata.readUInt16BE(8);
console.log("Payload length:", payloadLen, "bytes");

// Extract payload
const payloadBytes = calldata.slice(10, 10 + payloadLen);
const judgeSig = calldata.slice(10 + payloadLen, 10 + payloadLen + 64);
const verifierSig = calldata.slice(10 + payloadLen + 64, 10 + payloadLen + 128);

// Parse payload
const verdict = JSON.parse(payloadBytes.toString("utf8"));
console.log();
console.log("Verdict payload:");
console.log("  protocol:", verdict.protocol, verdict.version);
console.log("  case_id:", verdict.case_id);
console.log("  evidence_hash:", verdict.evidence_hash);
console.log("  judge_role:", verdict.judge_role);
console.log("  verifier_role:", verdict.verifier_role);
console.log("  verdict:", verdict.verdict);
console.log("  ts:", verdict.ts);
console.log();

// Verify Frankfurt Judge ed25519 signature
const judgePubKey = createPublicKey({
  key: Buffer.from(verdict.judge_pubkey_hex, "hex"),
  format: "der",
  type: "spki"
});
const judgeOk = verifySig(null, payloadBytes, judgePubKey, judgeSig);
console.log("Frankfurt Judge ed25519 sig:", judgeOk ? "VALID ✓" : "INVALID ✗");

// Verify NYC Verifier ed25519 signature
const verifierPubKey = createPublicKey({
  key: Buffer.from(verdict.verifier_pubkey_hex, "hex"),
  format: "der",
  type: "spki"
});
const verifierOk = verifySig(null, payloadBytes, verifierPubKey, verifierSig);
console.log("NYC Verifier ed25519 sig:", verifierOk ? "VALID ✓" : "INVALID ✗");

console.log();
console.log("=" .repeat(60));
if (judgeOk && verifierOk) {
  console.log("ATTESTATION VALID — both signatures verify against embedded pubkeys.");
  console.log("Both Frankfurt Judge + NYC Verifier independently signed the canonical");
  console.log("evidence hash:", verdict.evidence_hash);
  console.log("Anchored on Base mainnet block:", tx.blockNumber.toString());
} else {
  console.log("ATTESTATION INVALID — signature verification failed.");
  process.exit(2);
}
