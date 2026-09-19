export const levels = ["healthy", "warning", "critical", "low"] as const;
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
  yellowPercent: number;
  orangePercent: number;
}

export type HistoryRange = "90d" | "monthly";

export interface HistoryPoint {
  timestamp: string;
  blockNumber: string;
  balanceUsdc: string;
  utilizationPercent: number;
}

export interface HistorySeries {
  range: HistoryRange;
  interval: "daily" | "monthly";
  generatedAt: string;
  limitUsdc: string;
  points: HistoryPoint[];
}
