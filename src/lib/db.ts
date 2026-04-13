"use client";

import Dexie, { type Table } from "dexie";
import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";

export type CardMeta = {
  confirmed: boolean;
  reportSource?: string;
  insuranceType?: InsuranceType;
  overviewFields?: Record<string, string>;
  monthlyPremiums?: Array<{ yearMonth: string; totalPremium: string }>;
};

export type CaseStatus = "pending" | "proposed" | "closed" | "rejected";

export type PersonaAgeRange = "0~18" | "19~30" | "25~35" | "31~50" | "50以上";
export type PersonaMaritalStatus = "已婚" | "未婚";
export type PersonaChildrenStatus = "有孩" | "无孩";
export type PersonaIncomeRange = "10万以下" | "10~20万" | "20~50万" | "50~100万" | "100万以上";

export type InsuranceType =
  | "医疗险"
  | "意外险"
  | "重疾险"
  | "定期寿险"
  | "终身寿险"
  | "特定医疗险"
  | "失能护理险";

export type InsuranceAccount = "健康账户" | "生命账户" | "财富账户";

export type ProtectionRatingLabel = "完美配置" | "优质配置" | "合格配置" | "保障薄弱";

export type ReportStrategy = "professional_premium" | "needs_resonance" | "solution_test";

export type ReportDraft = {
  strategy: ReportStrategy;
  clientDataJson: unknown;
  markdown: string;
  generatedAt: number;
  job?: {
    conversationId: string;
    chatId: string;
    startedAt: number;
  } | null;
};

export type CustomerClassificationId = "minor" | "senior" | "pillar" | "couple" | "single";

export type CustomerClassification = {
  id: CustomerClassificationId;
  label: string;
};

export type CustomerClassificationBasis = {
  ageRange: PersonaAgeRange;
  maritalStatus: PersonaMaritalStatus;
  childrenStatus: PersonaChildrenStatus;
  personalIncome: PersonaIncomeRange;
};

export type CustomerPersona = {
  schemaVersion: 1;
  customerName: string;
  ageRange: PersonaAgeRange | null;
  maritalStatus: PersonaMaritalStatus | null;
  childrenStatus: PersonaChildrenStatus | null;
  personalIncome: PersonaIncomeRange | null;
  otherInfo: string;
  classification: CustomerClassification | null;
  classificationBasis: CustomerClassificationBasis | null;
};

export type CasePolicyData = {
  parsed: ParsedMarkdownTables | null;
  cardMeta: Record<string, CardMeta>;
};

export type CaseRecord = {
  id?: number;
  customerName: string;
  status: CaseStatus;
  gapScore: number;
  ratingLabel?: ProtectionRatingLabel | null;
  reportDraft?: ReportDraft | null;
  policyCount: number;
  totalPremium: string;
  rawMarkdown: string;
  policyData: CasePolicyData | null;
  persona?: CustomerPersona | null;
  summaryData: unknown | null;
  updatedAt: number;
};

export type CaseSummary = Pick<
  CaseRecord,
  "id" | "customerName" | "status" | "gapScore" | "ratingLabel" | "policyCount" | "totalPremium" | "updatedAt"
>;

export type CaseSummaryWithClassification = CaseSummary & {
  classification: CustomerClassification | null;
};

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
