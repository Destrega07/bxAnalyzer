"use client";

import Dexie, { type Table } from "dexie";
import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";

export type CardMeta = {
  confirmed: boolean;
  reportSource?: string;
  overviewFields?: Record<string, string>;
  monthlyPremiums?: Array<{ yearMonth: string; totalPremium: string }>;
};

export type CaseStatus = "pending" | "proposed" | "closed" | "rejected";

export type CasePolicyData = {
  parsed: ParsedMarkdownTables | null;
  cardMeta: Record<string, CardMeta>;
};

export type CaseRecord = {
  id?: number;
  customerName: string;
  status: CaseStatus;
  gapScore: number;
  policyCount: number;
  totalPremium: string;
  rawMarkdown: string;
  policyData: CasePolicyData | null;
  summaryData: unknown | null;
  updatedAt: number;
};

export type CaseSummary = Pick<
  CaseRecord,
  "id" | "customerName" | "status" | "gapScore" | "policyCount" | "totalPremium" | "updatedAt"
>;

class IpisDB extends Dexie {
  cases!: Table<CaseRecord, number>;

  constructor() {
    super("ipis_db");
    this.version(1).stores({
      cases: "++id, customerName, status, updatedAt",
    });
  }
}

export const db = new IpisDB();
