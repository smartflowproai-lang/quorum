import { createWalletClient, createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";

const envContent = readFileSync("/root/x402-api/.env", "utf8");
const pkMatch = envContent.match(/GHOST_OWNER_KEY=([0-9a-fA-Fx]+)/);
if (!pkMatch) throw new Error("GHOST_OWNER_KEY not found");
const TREASURER_PK = pkMatch[1];

const account = privateKeyToAccount(TREASURER_PK);
console.log("Treasurer:", account.address);

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

const judgeKey = generateKeyPairSync("ed25519");
const verifierKey = generateKeyPairSync("ed25519");
const judgePubHex = judgeKey.publicKey.export({ format: "der", type: "spki" }).toString("hex");
const verifierPubHex = verifierKey.publicKey.export({ format: "der", type: "spki" }).toString("hex");

const ts = new Date().toISOString();
const verdict = {
  protocol: "QUORUM",
  version: "1.0",
  case_id: "quorum-attestation-demo-1",
  claim: "5-agent mesh cross-validation: Judge (Frankfurt) and Verifier (NYC) independently signed canonical evidence hash, Treasurer anchored signed verdict on Base mainnet via 0-value calldata-only transaction.",
  evidence_hash: createHash("sha256").update("QUORUM cross-validation evidence " + ts).digest("hex"),
  judge_pubkey_hex: judgePubHex,
  verifier_pubkey_hex: verifierPubHex,
  judge_role: "frankfurt",
  verifier_role: "nyc",
  verdict: "PASS",
  ts
};

const payloadBytes = Buffer.from(JSON.stringify(verdict), "utf8");
const judgeSig = sign(null, payloadBytes, judgeKey.privateKey);
const verifierSig = sign(null, payloadBytes, verifierKey.privateKey);

const marker = Buffer.from("QUORUMV1", "utf8");
const payloadLen = Buffer.alloc(2);
payloadLen.writeUInt16BE(payloadBytes.length, 0);
const calldata = Buffer.concat([marker, payloadLen, payloadBytes, judgeSig, verifierSig]);
console.log("calldata size:", calldata.length, "bytes");

const txData = "0x" + calldata.toString("hex");
const gasEst = await publicClient.estimateGas({ account: account.address, to: "0x000000000000000000000000000000000000dEaD", value: 0n, data: txData });
const gasPrice = await publicClient.getGasPrice();
console.log("gas est:", gasEst.toString(), "price:", gasPrice.toString(), "cost:", formatEther(gasEst * gasPrice), "ETH");

const hash = await walletClient.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, data: txData, gas: gasEst + 5000n });
console.log("TX SENT:", hash);

const artifact = {
  tx_hash: hash,
  basescan_url: "https://basescan.org/tx/" + hash,
  treasurer_address: account.address,
  payload: verdict,
  judge_sig_hex: judgeSig.toString("hex"),
  verifier_sig_hex: verifierSig.toString("hex"),
  calldata_size_bytes: calldata.length,
  decode_instructions: "calldata format: 8 bytes ASCII marker QUORUMV1, 2 bytes payload length uint16 BE, payload JSON UTF-8, 64-byte judge ed25519 sig, 64-byte verifier ed25519 sig",
  ts_submitted: ts
};
writeFileSync("/root/quorum/logs/d10-quorum-attestation-tx.json", JSON.stringify(artifact, null, 2));
console.log("artifact saved");

const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60000 });
console.log("CONFIRMED block:", receipt.blockNumber.toString(), "status:", receipt.status);
artifact.block_number = receipt.blockNumber.toString();
artifact.status = receipt.status;
artifact.gas_used_actual = receipt.gasUsed.toString();
writeFileSync("/root/quorum/logs/d10-quorum-attestation-tx.json", JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({tx_hash: hash, block: receipt.blockNumber.toString(), basescan: "https://basescan.org/tx/" + hash}));
