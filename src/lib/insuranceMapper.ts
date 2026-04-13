import type { InsuranceAccount, InsuranceType } from "@/lib/db";

export type InsuranceMatch = {
  type: InsuranceType;
  account: InsuranceAccount;
  keyword: string;
};

type MappingItem = {
  type: InsuranceType;
  account: InsuranceAccount;
  keywords: string[];
};

const mapping: MappingItem[] = [
  {
    type: "特定医疗险",
    account: "健康账户",
    keywords: [
      "慢病",
      "女性",
      "生育",
      "孕期",
      "孕妇",
      "男性",
      "特种",
      "特病",
      "结节",
      "乳腺",
      "防癌",
      "恶性肿瘤",
      "白血病",
      "少儿",
      "长期",
      "20年",
      "保证续保",
    ],
  },
  { type: "重疾险", account: "健康账户", keywords: ["重大疾病", "重病", "重疾"] },
  { type: "医疗险", account: "健康账户", keywords: ["医疗", "住院", "中端", "高端", "门诊住院"] },
  { type: "意外险", account: "生命账户", keywords: ["意外", "意外伤害", "旅行", "伤残", "骨折", "猝死", "学平", "驾乘", "交通", "驾驶"] },
  { type: "定期寿险", account: "生命账户", keywords: ["定期寿险", "责任险", "身故", "定寿"] },
  {
    type: "终身寿险",
    account: "财富账户",
    keywords: ["终生", "终身", "财富", "分红", "万能", "两全", "年金"],
  },
  { type: "失能护理险", account: "生命账户", keywords: ["护理", "10种特定"] },
];

export const insuranceTypeOptions: InsuranceType[] = [
  "医疗险",
  "意外险",
  "重疾险",
  "定期寿险",
  "终身寿险",
  "特定医疗险",
  "失能护理险",
];

function normalizeText(input: string) {
  return String(input ?? "")
    .replace(/※/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function inferInsuranceType(policyName: string): InsuranceMatch | null {
  const text = normalizeText(policyName);
  if (!text) return null;

  for (const item of mapping) {
    for (const keyword of item.keywords) {
      if (!keyword) continue;
      if (text.includes(keyword)) {
        return { type: item.type, account: item.account, keyword };
      }
    }
  }
  return null;
}
