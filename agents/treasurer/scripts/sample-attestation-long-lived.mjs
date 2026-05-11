#!/usr/bin/env node
/**
 * Sample QUORUM attestation using long-lived per-host ed25519 keys.
 *
 * Dry-run companion to attestation-tx.mjs: builds the exact QUORUMV1 calldata
 * that would land on Base mainnet, but does NOT submit a transaction (so it
 * costs no gas and is safe to run from CI / hooks / local audits).
 *
 * Verifies the result inline by re-parsing the calldata and checking both
 * ed25519 signatures with the same logic that decode-attestation-tx.mjs runs
 * against on-chain calldata. If this script exits 0, an on-chain TX built
 * with the same payload will also decode-and-verify cleanly.
 *
 * Usage:
 *   node sample-attestation-long-lived.mjs
 *   QUORUM_REPO_DIR=/path/to/quorum node sample-attestation-long-lived.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
} from "node:crypto";

const REPO_DIR = process.env.QUORUM_REPO_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function loadKeyPair(keysDir, baseName) {
  const pubPem = readFileSync(path.join(REPO_DIR, keysDir, `${baseName}.pub`), "utf8");
  const secPem = readFileSync(path.join(REPO_DIR, keysDir, `${baseName}.sec`), "utf8");
  const publicKey = createPublicKey({ key: pubPem, format: "pem", type: "spki" });
  const privateKey = createPrivateKey({ key: secPem, format: "pem", type: "pkcs8" });
  const pubDerHex = publicKey.export({ format: "der", type: "spki" }).toString("hex");
  return { publicKey, privateKey, pubDerHex };
}

console.log("QUORUM long-lived-key attestation sample (dry-run)");
console.log("=".repeat(60));

const judge = loadKeyPair("agents/judge/keys", "host-frankfurt");
const verifier = loadKeyPair("agents/verifier/keys", "host-nyc");

console.log("Frankfurt Judge pubkey DER hex: ", judge.pubDerHex);
console.log("NYC Verifier  pubkey DER hex:   ", verifier.pubDerHex);

const ts = new Date().toISOString();
const verdict = {
  protocol: "QUORUM",
  version: "1.0",
  case_id: "quorum-attestation-sample-long-lived",
  claim:
    "5-agent mesh cross-validation with long-lived per-host signing keys: Judge (Frankfurt) and Verifier (NYC) independently signed canonical evidence hash. Pubkeys are stable across attestations.",
  evidence_hash: createHash("sha256").update("QUORUM long-lived sample " + ts).digest("hex"),
  judge_pubkey_hex: judge.pubDerHex,
  verifier_pubkey_hex: verifier.pubDerHex,
  judge_role: "frankfurt",
  verifier_role: "nyc",
  verdict: "PASS",
  ts,
};

const payloadBytes = Buffer.from(JSON.stringify(verdict), "utf8");
const judgeSig = sign(null, payloadBytes, judge.privateKey);
const verifierSig = sign(null, payloadBytes, verifier.privateKey);

const marker = Buffer.from("QUORUMV1", "utf8");
const payloadLen = Buffer.alloc(2);
payloadLen.writeUInt16BE(payloadBytes.length, 0);
const calldata = Buffer.concat([marker, payloadLen, payloadBytes, judgeSig, verifierSig]);

console.log("Calldata size:", calldata.length, "bytes");
console.log("Marker:", calldata.slice(0, 8).toString("utf8"));
console.log();

// Re-parse and verify — mirrors decode-attestation-tx.mjs exactly.
const reMarker = calldata.slice(0, 8).toString("utf8");
if (reMarker !== "QUORUMV1") {
  console.error("ERROR: marker mismatch");
  process.exit(1);
}
const reLen = calldata.readUInt16BE(8);
const rePayload = calldata.slice(10, 10 + reLen);
const reJudgeSig = calldata.slice(10 + reLen, 10 + reLen + 64);
const reVerifierSig = calldata.slice(10 + reLen + 64, 10 + reLen + 128);
const reVerdict = JSON.parse(rePayload.toString("utf8"));

const reJudgePub = createPublicKey({ key: Buffer.from(reVerdict.judge_pubkey_hex, "hex"), format: "der", type: "spki" });
const reVerifierPub = createPublicKey({ key: Buffer.from(reVerdict.verifier_pubkey_hex, "hex"), format: "der", type: "spki" });

const judgeOk = verify(null, rePayload, reJudgePub, reJudgeSig);
const verifierOk = verify(null, rePayload, reVerifierPub, reVerifierSig);

console.log("Frankfurt Judge ed25519 sig:", judgeOk ? "VALID ✓" : "INVALID ✗");
console.log("NYC Verifier  ed25519 sig:", verifierOk ? "VALID ✓" : "INVALID ✗");
console.log();

if (!judgeOk || !verifierOk) {
  console.error("SAMPLE INVALID — would not decode cleanly on-chain. Aborting.");
  process.exit(2);
}

console.log("=".repeat(60));
console.log("Sample attestation built + verified locally.");
console.log("Calldata is decode-attestation-tx.mjs compatible — if posted to Base,");
console.log("both signatures will resolve VALID against the same pubkeys.");
