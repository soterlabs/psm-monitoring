export const levels = ["ok", "warning", "critical", "exceeded"] as const;
export type Level = (typeof levels)[number];

export interface BalanceReading {
  checkedAt: string;
  blockNumber: string;
  blockTimestamp: string;
  chainId: number;
  psmAddress: string;
  pocketAddress: string;
  tokenAddress: string;
  pocketBalanceRaw: bigint;
  psmBalanceRaw: bigint;
  totalBalanceRaw: bigint;
}

export interface StatusSnapshot {
  status: Level;
  checkedAt: string;
  blockNumber: string;
  blockTimestamp: string;
  chainId: number;
  psmAddress: string;
  pocketAddress: string;
  tokenAddress: string;
  pocketBalanceUsdc: string;
  psmBalanceUsdc: string;
  totalBalanceUsdc: string;
  limitUsdc: string;
  remainingUsdc: string;
  utilizationPercent: number;
  warningPercent: number;
  criticalPercent: number;
}
