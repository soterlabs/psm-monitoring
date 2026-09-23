import { createPublicClient, formatUnits, http } from "viem";
import { safeErrorMessage } from "./errors.js";

const REFRESH_MS = 5 * 60 * 1_000;

const erc20Abi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }],
}] as const;

const psm3Abi = [
  { type: "function", name: "shares", stateMutability: "view", inputs: [{ name: "holder", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalShares", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const chains = [
  { name: "Base", id: 8453, rpcEnv: "BASE_RPC", psm: "0x1601843c5e9bc251a3272907010afa41fa18347e", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", alm: "0x2917956eff0b5eaf030abdb4ef4296df775009ca" },
  { name: "Arbitrum", id: 42161, rpcEnv: "ARBITRUM_RPC", psm: "0x2b05f8e1cacc6974fd79a673a341fe1f58d27266", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", alm: "0x92afd6f2385a90e44da3a8b60fe36f6cbe1d8709" },
  { name: "Optimism", id: 10, rpcEnv: "OPTIMISM_RPC", psm: "0xe0f9978b907853f354d79188a3defbd41978af62", usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", alm: "0x876664f0c9ff24d1aa355ce9f1680ae1a5bf36fb" },
  { name: "Unichain", id: 130, rpcEnv: "UNICHAIN_RPC", psm: "0x7b42ed932f26509465f7ce3faf76ffce1275312f", usdc: "0x078d782b760474a361dda0af3839290b0ef57ad6", alm: "0x345e368fccd62266b3f5f37c9a131fd1c39f5869" },
] as const;

export interface Psm3ChainBalance {
  chain: string;
  chainId: number;
  blockNumber: string;
  psmAddress: string;
  reserveUsdc: number;
  sparkClaimUsdc: number;
  sparkOwnershipPercent: number;
}

export interface Psm3Snapshot {
  checkedAt: string;
  totalReserveUsdc: number;
  totalSparkClaimUsdc: number;
  chains: Psm3ChainBalance[];
}

export function summarizePsm3(chains: Psm3ChainBalance[]): Pick<Psm3Snapshot, "totalReserveUsdc" | "totalSparkClaimUsdc"> {
  return {
    totalReserveUsdc: chains.reduce((sum, chain) => sum + chain.reserveUsdc, 0),
    totalSparkClaimUsdc: chains.reduce((sum, chain) => sum + chain.sparkClaimUsdc, 0),
  };
}

async function readChain(config: (typeof chains)[number]): Promise<Psm3ChainBalance> {
  const rpcUrl = process.env[config.rpcEnv];
  if (!rpcUrl) throw new Error(`${config.rpcEnv} is not configured`);
  const chain = {
    id: config.id,
    name: config.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const blockNumber = await client.getBlockNumber();
  const [reserveRaw, sparkShares, totalShares] = await Promise.all([
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [config.psm], blockNumber }),
    client.readContract({ address: config.psm, abi: psm3Abi, functionName: "shares", args: [config.alm], blockNumber }),
    client.readContract({ address: config.psm, abi: psm3Abi, functionName: "totalShares", blockNumber }),
  ]);
  const reserveUsdc = Number(formatUnits(reserveRaw, 6));
  const ownershipBillionths = totalShares === 0n ? 0n : sparkShares * 1_000_000_000n / totalShares;
  const sparkClaimUsdc = reserveUsdc * Number(ownershipBillionths) / 1_000_000_000;
  return {
    chain: config.name,
    chainId: config.id,
    blockNumber: blockNumber.toString(),
    psmAddress: config.psm,
    reserveUsdc,
    sparkClaimUsdc,
    sparkOwnershipPercent: totalShares === 0n ? 0 : Number(sparkShares * 1_000_000n / totalShares) / 10_000,
  };
}

export class Psm3Monitor {
  snapshot?: Psm3Snapshot;
  loading = false;
  lastError?: { message: string; at: string };
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  async poll(retry = true): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const readings = await Promise.all(chains.map(readChain));
      this.snapshot = { checkedAt: new Date().toISOString(), ...summarizePsm3(readings), chains: readings };
      delete this.lastError;
      console.log(JSON.stringify({ event: "psm3_checked", totalReserveUsdc: this.snapshot.totalReserveUsdc }));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.lastError = { message, at: new Date().toISOString() };
      console.error(JSON.stringify({ event: "psm3_failed", message, at: this.lastError.at }));
      if (retry) {
        this.retryTimer = setTimeout(() => void this.poll(), 30_000);
        this.retryTimer.unref();
      }
    } finally {
      this.loading = false;
    }
  }
}
