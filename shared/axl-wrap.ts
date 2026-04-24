// PRE-KICKOFF DRAFT — generated 2026-04-24 by background runner, pending Tom review before copy to live repo
// AXL mesh wrapper — Frankfurt (VPS-A) ↔ NYC (VPS-B) signed message exchange
// Day-1 target: single signed message roundtrip confirmed
// See ref-architecture-deep.md §AXL integration for binary location + peer ID management

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';

const execFileP = promisify(execFile);

const AXL_BIN = process.env.AXL_BIN || '/usr/local/bin/axl';
const AXL_SOCKET = process.env.AXL_SOCKET || '/var/run/axl/axl.sock';

export interface AxlMessage {
  from: string;
  to: string;
  payload: unknown;
  signature?: string;
  ts: number;
}

export async function axlSend(peer: string, payload: unknown): Promise<void> {
  // TODO Day-1: replace with actual axl CLI call — this is a stub for compose wiring
  const msg: AxlMessage = { from: process.env.AGENT_ID || 'unknown', to: peer, payload, ts: Date.now() };
  const { stdout } = await execFileP(AXL_BIN, ['send', '--socket', AXL_SOCKET, '--to', peer, '--payload', JSON.stringify(msg)]).catch(() => ({ stdout: '' }));
  if (stdout) console.log('[axl] sent:', stdout.trim());
}

export async function axlReceive(agentId: string, timeoutMs = 5000): Promise<AxlMessage | null> {
  // TODO Day-1: replace with actual axl CLI read loop — stub returns null after timeout
  try {
    const { stdout } = await Promise.race([
      execFileP(AXL_BIN, ['receive', '--socket', AXL_SOCKET, '--as', agentId]),
      new Promise<{ stdout: string }>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return JSON.parse(stdout) as AxlMessage;
  } catch {
    return null;
  }
}

export async function axlVerify(msg: AxlMessage): Promise<boolean> {
  // TODO Day-1: ed25519 signature verify via axl binary
  return Boolean(msg.signature);
}
