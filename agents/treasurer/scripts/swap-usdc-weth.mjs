// swap-usdc-weth.mjs — programmatic treasurer USDC→WETH swap (1 USDC) via
// Uniswap Trading API (Universal Router + Permit2). Runs unattended from
// cron (Mon 09:00 UTC). Single-shot per invocation.
//
// Modes:
//   --dry-run   live balance + RPC gas estimate + Uniswap /quote (optional,
//               only if UNISWAP_API_KEY is set). NO permit signing, NO swap
//               broadcast. Writes log JSON.
//   (default)   full flow: getQuote → signPermit2 → /v1/swap → sendTransaction
//               → waitForTransactionReceipt → write log JSON.
//
// Required env:
//   TREASURER_PRIVATE_KEY (or TREASURER_ENV_FILE pointing to .env with it)
//   UNISWAP_API_KEY (required for live mode; optional for --dry-run)
// Optional env:
//   BASE_RPC_URL (default https://mainnet.base.org)
//   SWAP_AMOUNT_USDC (default 1.0)
//   SWAP_LOG_PATH (default /root/quorum/logs/d12-programmatic-swap-weekN.json
//                  where N = swap_index inferred from existing log files)
//   SWAP_WEEK_INDEX (override autodetected week index; useful for tests)

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const UNISWAP_API_BASE = "https://trade-api.gateway.uniswap.org/v1";
const BASE_CHAIN_ID = 8453;
const LOG_DIR = "/root/quorum/logs";

const DRY_RUN = process.argv.includes("--dry-run");
const AMOUNT_USDC = process.env.SWAP_AMOUNT_USDC
  ? Number(process.env.SWAP_AMOUNT_USDC)
  : 1.0;
const AMOUNT_ATOMIC = BigInt(Math.round(AMOUNT_USDC * 1e6)); // USDC 6 decimals
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

// ---------------------------------------------------------------------------
// Key loader (matches kh-spec-settle.mjs / attestation-tx.mjs pattern)
// ---------------------------------------------------------------------------

function loadTreasurerKey() {
  if (process.env.TREASURER_PRIVATE_KEY) return process.env.TREASURER_PRIVATE_KEY;
  const envFile = process.env.TREASURER_ENV_FILE;
  if (envFile && existsSync(envFile)) {
    const content = readFileSync(envFile, "utf8");
    const m = content.match(/^TREASURER_PRIVATE_KEY=(0x[0-9a-fA-F]+)\s*$/m);
    if (m) return m[1];
  }
  // Dry-run is still useful without the key (gas estimate + budget snapshot),
  // but we need the treasurer ADDRESS. Caller can pass via TREASURER_ADDRESS.
  if (DRY_RUN && process.env.TREASURER_ADDRESS) return null;
  throw new Error(
    "TREASURER_PRIVATE_KEY not set (env or TREASURER_ENV_FILE). For dry-run without key, set TREASURER_ADDRESS."
  );
}

function weekIndex() {
  if (process.env.SWAP_WEEK_INDEX) return Number(process.env.SWAP_WEEK_INDEX);
  if (!existsSync(LOG_DIR)) return 1;
  const matches = readdirSync(LOG_DIR).filter((f) =>
    /^d12-programmatic-swap-week\d+\.json$/.test(f)
  );
  return matches.length + 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tsStart = new Date().toISOString();
  const week = weekIndex();
  const logPath =
    process.env.SWAP_LOG_PATH ??
    `${LOG_DIR}/d12-programmatic-swap-week${week}.json`;
  mkdirSync(dirname(logPath), { recursive: true });

  const privateKey = loadTreasurerKey();
  const account = privateKey
    ? privateKeyToAccount(privateKey)
    : { address: process.env.TREASURER_ADDRESS };
  const swapper = account.address;

  console.log(`[swap-usdc-weth] mode=${DRY_RUN ? "dry-run" : "live"} week=${week} swapper=${swapper}`);

  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

  // Pre-flight balances
  const [ethBal, usdcBal, wethBal] = await Promise.all([
    publicClient.getBalance({ address: swapper }),
    publicClient.readContract({
      address: USDC_BASE,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [swapper],
    }),
    publicClient.readContract({
      address: WETH_BASE,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [swapper],
    }),
  ]);

  console.log(
    `[swap-usdc-weth] balances ETH=${formatEther(ethBal)} USDC=${formatUnits(usdcBal, 6)} WETH=${formatUnits(wethBal, 18)}`
  );

  if (usdcBal < AMOUNT_ATOMIC) {
    const err = {
      status: "aborted_budget",
      reason: `insufficient USDC: have ${formatUnits(usdcBal, 6)}, need ${AMOUNT_USDC}`,
      ts: new Date().toISOString(),
      week_index: week,
      swapper,
      eth_balance: formatEther(ethBal),
      usdc_balance: formatUnits(usdcBal, 6),
      weth_balance: formatUnits(wethBal, 18),
    };
    writeFileSync(logPath, JSON.stringify(err, null, 2));
    console.error(JSON.stringify(err));
    process.exit(2);
  }

  if (ethBal < 100000000000000n) {
    // 0.0001 ETH floor for gas
    const err = {
      status: "aborted_budget",
      reason: `insufficient ETH for gas: have ${formatEther(ethBal)}, need >= 0.0001`,
      ts: new Date().toISOString(),
      week_index: week,
      swapper,
      eth_balance: formatEther(ethBal),
      usdc_balance: formatUnits(usdcBal, 6),
      weth_balance: formatUnits(wethBal, 18),
    };
    writeFileSync(logPath, JSON.stringify(err, null, 2));
    console.error(JSON.stringify(err));
    process.exit(2);
  }

  // ----- DRY-RUN path -----
  if (DRY_RUN) {
    const result = {
      status: "dry_run_ok",
      mode: "dry-run",
      ts_start: tsStart,
      ts_end: new Date().toISOString(),
      week_index: week,
      swapper,
      eth_balance: formatEther(ethBal),
      usdc_balance: formatUnits(usdcBal, 6),
      weth_balance: formatUnits(wethBal, 18),
      target: { tokenIn: USDC_BASE, tokenOut: WETH_BASE, amount_in_usdc: AMOUNT_USDC, amount_atomic: AMOUNT_ATOMIC.toString() },
      chain: { id: BASE_CHAIN_ID, name: "base", rpc: BASE_RPC },
      uniswap_quote: null,
      gas_estimate: null,
      notes: [],
    };

    // Gas estimate (rough, ERC20 approve-equivalent — Universal Router via Permit2
    // is a single tx, gas typically 150-250k. We probe with a representative shape.)
    try {
      const probeData = "0x" + "00".repeat(400); // ~Universal Router calldata size order
      const probeGas = await publicClient.estimateGas({
        account: swapper,
        to: "0x000000000000000000000000000000000000dEaD",
        data: probeData,
      });
      const gasPrice = await publicClient.getGasPrice();
      const costEth = Number(probeGas * gasPrice) / 1e18;
      result.gas_estimate = {
        gas_units_probe: probeGas.toString(),
        gas_price_gwei: (Number(gasPrice) / 1e9).toFixed(6),
        cost_eth_probe: costEth.toFixed(10),
        cost_eth_4_swaps: (costEth * 4).toFixed(10),
        note: "Probe gas — Universal Router + Permit2 actual swap costs ~150-250k gas; multiply probe by ~3-5x for upper bound.",
      };
    } catch (e) {
      result.notes.push(`gas_estimate_failed: ${e.message}`);
    }

    // Optional Uniswap /quote (no signing, no broadcast) — gives a real
    // expected WETH out so the dry-run output is informative.
    if (process.env.UNISWAP_API_KEY) {
      try {
        const quoteBody = {
          type: "EXACT_INPUT",
          amount: AMOUNT_ATOMIC.toString(),
          tokenInChainId: BASE_CHAIN_ID,
          tokenOutChainId: BASE_CHAIN_ID,
          tokenIn: USDC_BASE,
          tokenOut: WETH_BASE,
          swapper,
          slippageTolerance: 0.5,
          routingPreference: "BEST_PRICE",
          protocols: ["V3", "V4"],
        };
        const controller = new AbortController();
        const tQuote = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${UNISWAP_API_BASE}/quote`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.UNISWAP_API_KEY,
          },
          body: JSON.stringify(quoteBody),
          signal: controller.signal,
        });
        clearTimeout(tQuote);
        if (res.ok) {
          const j = await res.json();
          result.uniswap_quote = {
            amount_in_usdc_atomic: j.quote?.amountIn,
            amount_out_weth_atomic: j.quote?.amountOut,
            amount_out_weth_human: j.quote?.amountOut
              ? formatUnits(BigInt(j.quote.amountOut), 18)
              : null,
            routing: j.routing,
            permit_data_present: Boolean(j.permitData),
            request_id: j.requestId,
          };
        } else {
          const txt = await res.text().catch(() => "");
          result.notes.push(`uniswap_quote_http_${res.status}: ${txt.slice(0, 200)}`);
        }
      } catch (e) {
        result.notes.push(`uniswap_quote_failed: ${e.message}`);
      }
    } else {
      result.notes.push(
        "UNISWAP_API_KEY not set — skipping /quote probe. Live mode will fail until key is provisioned in TREASURER_ENV_FILE."
      );
    }

    writeFileSync(logPath, JSON.stringify(result, null, 2));
    console.log(`[swap-usdc-weth] dry-run wrote ${logPath}`);
    console.log(JSON.stringify({ status: "dry_run_ok", week, log: logPath }));
    return;
  }

  // ----- LIVE path -----
  if (!process.env.UNISWAP_API_KEY) {
    const err = {
      status: "aborted_config",
      reason: "UNISWAP_API_KEY env var required for live swap",
      ts: new Date().toISOString(),
      week_index: week,
      swapper,
    };
    writeFileSync(logPath, JSON.stringify(err, null, 2));
    console.error(JSON.stringify(err));
    process.exit(3);
  }

  // 1) Quote
  const quoteBody = {
    type: "EXACT_INPUT",
    amount: AMOUNT_ATOMIC.toString(),
    tokenInChainId: BASE_CHAIN_ID,
    tokenOutChainId: BASE_CHAIN_ID,
    tokenIn: USDC_BASE,
    tokenOut: WETH_BASE,
    swapper,
    slippageTolerance: 0.5,
    routingPreference: "BEST_PRICE",
    protocols: ["V3", "V4"],
  };
  const quoteRes = await fetch(`${UNISWAP_API_BASE}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.UNISWAP_API_KEY },
    body: JSON.stringify(quoteBody),
  });
  if (!quoteRes.ok) {
    const txt = await quoteRes.text().catch(() => "");
    throw new Error(`Uniswap /quote ${quoteRes.status}: ${txt.slice(0, 400)}`);
  }
  const quote = await quoteRes.json();
  if (!quote.permitData) throw new Error("/quote response missing permitData");

  // 2) Permit2 sign (auto-detect primaryType)
  const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
  const typeKeys = Object.keys(quote.permitData.types);
  const candidates = ["PermitSingle", "PermitTransferFrom", "PermitBatchTransferFrom", "PermitBatch"];
  const primaryType = candidates.find((c) => typeKeys.includes(c));
  if (!primaryType) throw new Error(`signPermit2: no primaryType in types: ${typeKeys.join(",")}`);
  const permitSignature = await walletClient.signTypedData({
    domain: quote.permitData.domain,
    types: quote.permitData.types,
    primaryType,
    message: quote.permitData.values,
  });

  // 3) Swap calldata
  const swapRes = await fetch(`${UNISWAP_API_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.UNISWAP_API_KEY },
    body: JSON.stringify({ quote: quote.quote, permitSignature }),
  });
  if (!swapRes.ok) {
    const txt = await swapRes.text().catch(() => "");
    throw new Error(`Uniswap /swap ${swapRes.status}: ${txt.slice(0, 400)}`);
  }
  const swapData = await swapRes.json();
  if (!swapData.swap?.to || !swapData.swap?.data) throw new Error("/swap missing to/data");

  // 4) Broadcast
  const txHash = await walletClient.sendTransaction({
    to: swapData.swap.to,
    data: swapData.swap.data,
    value: BigInt(swapData.swap.value ?? "0"),
  });
  console.log(`[swap-usdc-weth] TX SENT: ${txHash}`);

  // 5) Wait
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });

  // 6) Post-swap balances
  const [ethAfter, usdcAfter, wethAfter] = await Promise.all([
    publicClient.getBalance({ address: swapper }),
    publicClient.readContract({
      address: USDC_BASE, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf", args: [swapper],
    }),
    publicClient.readContract({
      address: WETH_BASE, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf", args: [swapper],
    }),
  ]);

  const result = {
    status: receipt.status === "success" ? "ok" : "reverted",
    mode: "live",
    ts_start: tsStart,
    ts_end: new Date().toISOString(),
    week_index: week,
    swapper,
    chain: { id: BASE_CHAIN_ID, name: "base" },
    tx_hash: txHash,
    block_number: receipt.blockNumber.toString(),
    gas_used: receipt.gasUsed.toString(),
    basescan_url: `https://basescan.org/tx/${txHash}`,
    quote: {
      amount_in_usdc_atomic: quote.quote.amountIn,
      amount_out_weth_atomic: quote.quote.amountOut,
      amount_out_weth_human: formatUnits(BigInt(quote.quote.amountOut), 18),
      routing: quote.routing,
      request_id: quote.requestId,
    },
    pre: {
      eth: formatEther(ethBal),
      usdc: formatUnits(usdcBal, 6),
      weth: formatUnits(wethBal, 18),
    },
    post: {
      eth: formatEther(ethAfter),
      usdc: formatUnits(usdcAfter, 6),
      weth: formatUnits(wethAfter, 18),
    },
  };
  writeFileSync(logPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, week, tx: txHash, log: logPath }));
}

main().catch((e) => {
  console.error(`[swap-usdc-weth] FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
