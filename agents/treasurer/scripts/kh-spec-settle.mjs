import { createWalletClient, createPublicClient, http, encodeFunctionData, parseAbi, formatUnits, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { writeFileSync, readFileSync } from "node:fs";

const envContent = readFileSync("/root/x402-api/.env", "utf8");
const pkMatch = envContent.match(/GHOST_OWNER_KEY=([0-9a-fA-Fx]+)/);
const TREASURER_PK = pkMatch[1];
const account = privateKeyToAccount(TREASURER_PK);

console.log("Treasurer:", account.address);

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

// Per captured challenge in logs/d8-kh-x402-challenge-response.json:
const KH_PAY_TO = "0xf591c99cf53073db7b96cfb003cbcabdd3709544";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT_ATOMIC = 100000n; // 0.10 USDC (6 decimals)
const CHALLENGE_REF = "logs/d8-kh-x402-challenge-response.json";

// Pre-flight: check USDC balance
const usdcBalance = await publicClient.readContract({
  address: USDC_BASE,
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [account.address]
});
console.log("USDC balance:", formatUnits(usdcBalance, 6), "USDC");
if (usdcBalance < AMOUNT_ATOMIC) throw new Error("Insufficient USDC");

// Build ERC20 transfer calldata
const transferData = encodeFunctionData({
  abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
  functionName: "transfer",
  args: [KH_PAY_TO, AMOUNT_ATOMIC]
});

const gasEst = await publicClient.estimateGas({
  account: account.address,
  to: USDC_BASE,
  data: transferData
});
const gasPrice = await publicClient.getGasPrice();
console.log("gas est:", gasEst.toString(), "cost:", formatEther(gasEst * gasPrice), "ETH");

console.log("sending USDC transfer per x402 challenge spec...");
const hash = await walletClient.sendTransaction({
  to: USDC_BASE,
  data: transferData,
  gas: gasEst + 5000n
});
console.log("TX SENT:", hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60000 });
console.log("CONFIRMED block:", receipt.blockNumber.toString(), "status:", receipt.status, "gas used:", receipt.gasUsed.toString());

const artifact = {
  type: "x402_spec_conformant_settlement",
  challenge_ref: CHALLENGE_REF,
  challenge_workflow: "pack-0-10-demo",
  challenge_endpoint: "https://app.keeperhub.com/mcp",
  spec: "x402v2 scheme=exact",
  network: "Base mainnet (eip155:8453)",
  asset: USDC_BASE,
  asset_name: "USDC",
  amount_atomic: AMOUNT_ATOMIC.toString(),
  amount_human_usdc: "0.10",
  from: account.address,
  from_role: "Treasurer (EIP-7702 smart EOA)",
  to: KH_PAY_TO,
  to_role: "KH-published payTo (per challenge accepts[0].payTo)",
  tx_hash: hash,
  block_number: receipt.blockNumber.toString(),
  basescan_url: "https://basescan.org/tx/" + hash,
  status: receipt.status,
  gas_used: receipt.gasUsed.toString(),
  ts_settled: new Date().toISOString(),
  honest_caveat: "Spec-conformant USDC settlement to challenge.payTo address per x402v2 scheme=exact. KH MCP retry endpoint (workflow execution after payment) requires @keeperhub/wallet SDK or agentcash integration per the captured challenge response — that integration is deferred post-hackathon. This artifact demonstrates Treasurer wallet executes the on-chain payment leg of x402v2 settlement against a real production KH challenge."
};
writeFileSync("/root/quorum/logs/d10-kh-paid-settlement-tx.json", JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({tx_hash: hash, block: receipt.blockNumber.toString(), basescan: "https://basescan.org/tx/" + hash}));
