// shared/host-keys.ts — long-lived per-host ed25519 key loader
// SPDX-License-Identifier: MIT
//
// QUORUM runs Judge on Frankfurt and Verifier on NYC. Each role-host pair owns
// a long-lived ed25519 keypair stored on the host filesystem:
//
//   agents/judge/keys/host-frankfurt.{pub,sec}
//   agents/verifier/keys/host-nyc.{pub,sec}
//
// .pub is SPKI PEM (committable — pubkeys are public by definition).
// .sec is PKCS8 PEM (gitignored, chmod 600, never leaves the host).
//
// Why long-lived: the on-chain attestation TX 0x19bb1d0e… embedded ed25519
// pubkeys that the demo script generated fresh per call. That worked for
// the hackathon shape demo but means an external observer can't pin a
// Judge/Verifier identity across attestations. Per-host long-lived keys
// fix that — every attestation from Frankfurt Judge resolves to the same
// pubkey, anchored on-chain and verifiable via decode-attestation-tx.mjs.

import { promises as fs, constants as fsConstants } from 'node:fs';
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import path from 'node:path';

export interface HostKeyPair {
  /** Role label, e.g. "judge" or "verifier" — informational only. */
  role: string;
  /** Host label, e.g. "frankfurt" or "nyc" — informational only. */
  host: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** SPKI DER hex — the format embedded in attestation calldata. */
  publicKeyDerHex: string;
  /** Filesystem paths the keypair was loaded from. */
  pubPath: string;
  secPath: string;
}

export interface LoadHostKeyPairOptions {
  /** Directory containing the .pub and .sec files. */
  keysDir: string;
  /** Base filename (without extension), e.g. "host-frankfurt". */
  baseName: string;
  /** Optional metadata — informational. */
  role?: string;
  host?: string;
}

/**
 * Load a long-lived host keypair from disk. Refuses to follow symlinks on the
 * secret file (same defense as attestation.ts log-write path — multi-tenant
 * boxes can have hostile symlinks redirect reads).
 */
export async function loadHostKeyPair(opts: LoadHostKeyPairOptions): Promise<HostKeyPair> {
  const pubPath = path.join(opts.keysDir, `${opts.baseName}.pub`);
  const secPath = path.join(opts.keysDir, `${opts.baseName}.sec`);

  // Refuse to follow symlinks on the secret file. .pub can be a symlink (it's
  // public information) but .sec must be a real file.
  const secStat = await fs.lstat(secPath);
  if (secStat.isSymbolicLink()) {
    throw new Error(`secret key ${secPath} is a symlink — refusing to follow`);
  }
  // Best-effort permission check: warn (not throw) if .sec is world-readable.
  // Throwing would brick deployments where umask/CI sets odd modes; warning
  // surfaces the issue without blocking ops.
  if ((secStat.mode & 0o077) !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[host-keys] WARNING: ${secPath} mode ${(secStat.mode & 0o777).toString(8)} is group/other-readable; chmod 600 expected`
    );
  }

  const pubPem = await fs.readFile(pubPath, 'utf8');
  const secPem = await fs.readFile(secPath, 'utf8');

  const publicKey = createPublicKey({ key: pubPem, format: 'pem', type: 'spki' });
  const privateKey = createPrivateKey({ key: secPem, format: 'pem', type: 'pkcs8' });

  if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`key at ${opts.keysDir}/${opts.baseName} is not ed25519`);
  }

  // Verify keypair consistency — sign a probe message with sec, verify with pub.
  // Catches mismatched .pub/.sec files at load time rather than at first attest.
  const probe = Buffer.from('quorum-host-keypair-self-check');
  const probeSig = sign(null, probe, privateKey);
  if (!verify(null, probe, publicKey, probeSig)) {
    throw new Error(
      `keypair self-check failed for ${opts.baseName} — .pub and .sec do not match`
    );
  }

  const publicKeyDerHex = publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('hex');

  return {
    role: opts.role ?? '',
    host: opts.host ?? '',
    publicKey,
    privateKey,
    publicKeyDerHex,
    pubPath,
    secPath,
  };
}

/**
 * Sign canonical bytes with the host private key. Thin wrapper around
 * node:crypto so call sites read at the protocol level (sign with Frankfurt
 * Judge key, sign with NYC Verifier key) rather than crypto-primitive level.
 */
export function signWithHostKey(keypair: HostKeyPair, payload: Uint8Array): Buffer {
  return sign(null, Buffer.from(payload), keypair.privateKey);
}

/**
 * Verify a signature against a host public key. Returns true/false rather than
 * throwing — caller decides how to handle invalid signatures.
 */
export function verifyWithHostKey(
  keypair: HostKeyPair | { publicKey: KeyObject },
  payload: Uint8Array,
  signature: Uint8Array
): boolean {
  return verify(null, Buffer.from(payload), keypair.publicKey, Buffer.from(signature));
}

/**
 * Default key locations for the two production roles. Used by attestation
 * scripts + deploy-vps.sh; tests pass their own fixture paths.
 */
export const DEFAULT_KEY_PATHS = {
  judgeFrankfurt: {
    keysDir: 'agents/judge/keys',
    baseName: 'host-frankfurt',
    role: 'judge',
    host: 'frankfurt',
  },
  verifierNyc: {
    keysDir: 'agents/verifier/keys',
    baseName: 'host-nyc',
    role: 'verifier',
    host: 'nyc',
  },
} as const;
