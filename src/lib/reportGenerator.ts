import type { CustomerPersona, ProtectionRatingLabel, ReportStrategy } from "@/lib/db";

export type ReportSnapshot = {
  schemaVersion: 1;
  generatedAt: number;
  customer: {
    name: string;
    persona: CustomerPersona;
  };
  scoring: {
    totalScore: number;
    ratingLabel: ProtectionRatingLabel | null;
    accounts: Array<{
      account: "健康账户" | "生命账户" | "财富账户";
      score: number;
      maxScore: number;
      missingScore: number;
      gaps: string[];
    }>;
    items: Array<{
      item: string;
      account: "健康账户" | "生命账户" | "财富账户";
      score: number;
      maxScore: number;
      detail: string;
    }>;
  };
  policies: Array<{
    id: string;
    insured: string;
    policyName: string;
    mainOrRider: string;
    effectiveDate: string;
    expiryDate: string;
    insuranceType: string;
    amount: number;
    paidPremium: number;
    reportSource: string;
  }>;
};

function toText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseAmountLoose(value: string) {
  const v = String(value ?? "").trim();
  if (!v || v === "-") return 0;
  const normalized = v.replace(/,/g, "");
  const match = /(-?\d+(\.\d+)?)/.exec(normalized);
  if (!match) return 0;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return 0;
  if (/万/.test(normalized)) return num * 10000;
  return num;
}

export function buildClientDataJson(params: {
  strategy: ReportStrategy;
  snapshot: ReportSnapshot;
}) {
  return {
    schema_version: 1,
    strategy: params.strategy,
    snapshot: params.snapshot,
  };
}

export function buildReportSnapshot(params: {
  persona: CustomerPersona;
  ratingLabel: ProtectionRatingLabel | null;
  totalScore: number;
  scoringAccounts: ReportSnapshot["scoring"]["accounts"];
  scoringItems: ReportSnapshot["scoring"]["items"];
  confirmedPolicyRows: Array<{ id: string; row: Record<string, string> }>;
}) {
  const now = Date.now();
  const policies = params.confirmedPolicyRows.map((p) => {
    const row = p.row;
    return {
      id: p.id,
      insured: toText(row["被保人"] || row["被保险人"] || row["客户姓名"]),
      policyName: toText(row["保险条款名称"] || row["产品名称"] || row["保险产品名称"] || row["保单名称"]),
      mainOrRider: toText(row["主附险"] || row["主/附险"] || row["主险附加险"]),
      effectiveDate: toText(row["生效日期"] || row["起保日期"] || row["保障起期"]),
      expiryDate: toText(row["满期日期"] || row["终止日期"] || row["保障止期"]),
      insuranceType: toText(row["险种标签"] || row["险种类型"] || row["险种映射"]),
      amount: parseAmountLoose(toText(row["保额"] || row["保险金额"] || row["保障金额"] || row["保障金额-二级"] || row["保障金额-三级"])),
      paidPremium: parseAmountLoose(toText(row["累计交费"] || row["累计已交保费"] || row["已交保费"])),
      reportSource: toText(row["报告来源"] || row["报告编号"]),
    };
  });

  const snapshot: ReportSnapshot = {
    schemaVersion: 1,
    generatedAt: now,
    customer: {
      name: params.persona.customerName,
      persona: params.persona,
    },
    scoring: {
      totalScore: params.totalScore,
      ratingLabel: params.ratingLabel,
      accounts: params.scoringAccounts,
      items: params.scoringItems,
    },
    policies,
  };

  return snapshot;
}

