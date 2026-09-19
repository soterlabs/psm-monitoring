import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import type { Config } from "./config.js";
import type { BalanceReading } from "./types.js";

const psmAbi = [
  {
    type: "function",
    name: "pocket",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "gem",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export async function readUsdcAtBlock(
  client: PublicClient,
  config: Config,
  pocket: Address,
  blockNumber: bigint,
): Promise<bigint> {
  const pocketBalance = await client.readContract({
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [pocket],
    blockNumber,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const psmBalance = await client.readContract({
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [config.psmAddress],
    blockNumber,
  });
  return pocketBalance + psmBalance;
}

export async function findBlockNearTimestamp(
  client: PublicClient,
  targetTimestamp: bigint,
  latest: { number: bigint; timestamp: bigint },
): Promise<{ number: bigint; timestamp: bigint }> {
  if (targetTimestamp >= latest.timestamp) return latest;
  let guess = latest.number - (latest.timestamp - targetTimestamp) / 12n;
  if (guess < 1n) guess = 1n;
  let block = await client.getBlock({ blockNumber: guess });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const difference = targetTimestamp - block.timestamp;
    const absoluteDifference = difference < 0n ? -difference : difference;
    if (absoluteDifference <= 24n) break;
    const adjustment = difference / 12n;
    if (adjustment === 0n) break;
    guess += adjustment;
    if (guess < 1n) guess = 1n;
    if (guess > latest.number) guess = latest.number;
    block = await client.getBlock({ blockNumber: guess });
  }

  return { number: block.number, timestamp: block.timestamp };
}

export function makeClient(config: Config): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
}

export async function readBalance(client: PublicClient, config: Config): Promise<BalanceReading> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const [chainId, pocket, gem] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: config.psmAddress, abi: psmAbi, functionName: "pocket", blockNumber }),
    client.readContract({ address: config.psmAddress, abi: psmAbi, functionName: "gem", blockNumber }),
  ]);

  if (chainId !== 1) throw new Error(`ETH_RPC returned chain ID ${chainId}; expected Ethereum mainnet (1)`);
  if (getAddress(gem) !== config.usdcAddress) {
    throw new Error(`PSM gem is ${gem}; expected configured USDC ${config.usdcAddress}`);
  }

  const [pocketBalanceRaw, psmBalanceRaw] = await Promise.all([
    client.readContract({ address: config.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [pocket as Address], blockNumber }),
    client.readContract({ address: config.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [config.psmAddress], blockNumber }),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    blockNumber: blockNumber.toString(),
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
    chainId,
    psmAddress: config.psmAddress,
    pocketAddress: pocket,
    tokenAddress: gem,
    pocketBalanceRaw,
    psmBalanceRaw,
    totalBalanceRaw: pocketBalanceRaw + psmBalanceRaw,
  };
}
