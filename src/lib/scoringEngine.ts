import type { CustomerClassificationId, CustomerPersona, InsuranceType, ProtectionRatingLabel } from "@/lib/db";
import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";
import { inferInsuranceType } from "@/lib/insuranceMapper";

export type ScoreResult = {
  score: number;
  ratingLabel: ProtectionRatingLabel;
};

export type ScoreItemDetail = {
  item: string;
  account: "健康账户" | "生命账户" | "财富账户";
  score: number;
  maxScore: number;
  detail: string;
};

export type ScoreAccountDetail = {
  account: "健康账户" | "生命账户" | "财富账户";
  score: number;
  maxScore: number;
  missingScore: number;
  gaps: string[];
};

export type ScoreDetails = ScoreResult & {
  accounts: ScoreAccountDetail[];
  items: ScoreItemDetail[];
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseAmount(value: string) {
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

function getCell(row: Record<string, string>, candidates: string[]) {
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function normalizePolicyName(name: string) {
  return String(name ?? "")
    .replace(/※/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeInsuranceType(value: string): InsuranceType | null {
  if (
    value === "医疗险" ||
    value === "意外险" ||
    value === "重疾险" ||
    value === "定期寿险" ||
    value === "终身寿险" ||
    value === "特定医疗险" ||
    value === "失能护理险"
  ) {
    return value;
  }
  return null;
}

function getInsuranceTypeFromRow(row: Record<string, string>): InsuranceType | null {
  const override = normalizeInsuranceType(getCell(row, ["险种标签", "险种类型", "险种映射"]));
  if (override) return override;
  const policyName = getCell(row, ["保险条款名称", "产品名称", "保险产品名称", "保单名称"]);
  const inferred = inferInsuranceType(policyName);
  return inferred?.type ?? null;
}

function getCoverageAmountFromRow(row: Record<string, string>) {
  const raw = getCell(row, [
    "保额",
    "基本保额",
    "保险金额",
    "保障金额",
    "保额(元)",
    "保险金额(元)",
    "保障金额(元)",
    "保障金额-二级",
    "保障金额-三级",
  ]);
  return parseAmount(raw);
}

function findTable(parsed: ParsedMarkdownTables, headingIncludes: string, requiredHeaders: string[]) {
  for (const section of parsed.sections) {
    if (!section.heading.includes(headingIncludes)) continue;
    for (const table of section.tables) {
      if (requiredHeaders.every((h) => table.headers.includes(h))) return table;
    }
  }
  return null;
}

function tableToKeyValueMap(table: { headers: string[]; rows: Record<string, string>[] }, keyField: string, valueField: string) {
  const out = new Map<string, string>();
  table.rows.forEach((row) => {
    const k = String(row[keyField] ?? "").trim();
    const v = String(row[valueField] ?? "").trim();
    if (!k) return;
    if (!v) return;
    if (!out.has(k)) out.set(k, v);
  });
  return out;
}

function getCoverage2(parsed: ParsedMarkdownTables | null) {
  if (!parsed) return new Map<string, number>();
  const headingCandidates = ["保障责任信息", "保障责任汇总", "保障责任"];
  let table: { headers: string[]; rows: Record<string, string>[] } | null = null;
  for (const heading of headingCandidates) {
    table = findTable(parsed, heading, ["保障责任-二级", "保障金额-二级"]);
    if (table) break;
  }
  if (!table) return new Map<string, number>();
  const kv = tableToKeyValueMap(table, "保障责任-二级", "保障金额-二级");
  const out = new Map<string, number>();
  kv.forEach((v, k) => out.set(k, parseAmount(v)));
  return out;
}

function pickAccidentAmount(coverage2: Map<string, number>) {
  const direct = coverage2.get("身故-意外");
  if (typeof direct === "number" && direct > 0) return direct;
  let best = 0;
  coverage2.forEach((v, k) => {
    if (!k.includes("意外")) return;
    if (!(k.startsWith("身故-") || k.includes("身故"))) return;
    if (v > best) best = v;
  });
  return best;
}

function pickNonAccidentDeathAmount(coverage2: Map<string, number>) {
  const direct = coverage2.get("身故保障") ?? coverage2.get("身故-疾病/非意外") ?? 0;
  if (typeof direct === "number" && direct > 0) return direct;
  let best = 0;
  coverage2.forEach((v, k) => {
    if (!(k.startsWith("身故-") || k.includes("身故"))) return;
    if (k.includes("意外")) return;
    if (v > best) best = v;
  });
  return best;
}

function incomeThresholdForPillar(income: CustomerPersona["personalIncome"]) {
  if (income === "10万以下") return 500_000;
  if (income === "10~20万") return 1_000_000;
  if (income === "20~50万") return 2_000_000;
  if (income === "50~100万") return 5_000_000;
  if (income === "100万以上") return 10_000_000;
  return 0;
}

function ratingLabelForScore(score: number): ProtectionRatingLabel {
  if (score >= 90) return "完美配置";
  if (score >= 75) return "优质配置";
  if (score >= 60) return "合格配置";
  return "保障薄弱";
}

function normalizeClassificationId(persona: CustomerPersona): CustomerClassificationId | null {
  const id = persona.classification?.id;
  if (id === "minor" || id === "senior" || id === "pillar" || id === "couple" || id === "single") return id;
  return null;
}

function sumAccount(items: ScoreItemDetail[], account: ScoreItemDetail["account"]) {
  const rows = items.filter((i) => i.account === account);
  const score = rows.reduce((acc, r) => acc + r.score, 0);
  const maxScore = rows.reduce((acc, r) => acc + r.maxScore, 0);
  const gaps = rows
    .filter((r) => r.score < r.maxScore && r.detail.trim().length > 0)
    .map((r) => `${r.item}：${r.detail}`);
  return { score, maxScore, missingScore: Math.max(0, maxScore - score), gaps };
}

export function computeProtectionScoreDetails(params: {
  persona: CustomerPersona;
  parsed: ParsedMarkdownTables | null;
  confirmedPolicies: Array<Record<string, string>>;
}): ScoreDetails | null {
  const classificationId = normalizeClassificationId(params.persona);
  if (!classificationId) return null;

  const coverage2 = getCoverage2(params.parsed);

  const hasType = new Set<InsuranceType>();
  const amountByType = new Map<InsuranceType, number>();
  const productsByType = new Map<InsuranceType, Set<string>>();

  params.confirmedPolicies.forEach((row) => {
    const type = getInsuranceTypeFromRow(row);
    if (!type) return;
    hasType.add(type);
    const amount = getCoverageAmountFromRow(row);
    if (amount > 0) amountByType.set(type, (amountByType.get(type) ?? 0) + amount);
    const policyName = normalizePolicyName(getCell(row, ["保险条款名称", "产品名称", "保险产品名称", "保单名称"]));
    if (policyName) {
      const set = productsByType.get(type) ?? new Set<string>();
      set.add(policyName);
      productsByType.set(type, set);
    }
  });

  const medicalFromCoverage2 = Math.max(
    0,
    coverage2.get("医疗责任") ?? 0,
    coverage2.get("住院医疗") ?? 0,
    coverage2.get("一般医疗-费用补偿") ?? 0,
    coverage2.get("一般医疗-定额给付") ?? 0,
    coverage2.get("重大疾病医疗-费用补偿") ?? 0,
    coverage2.get("重大疾病医疗-定额给付") ?? 0,
    coverage2.get("恶性肿瘤医疗-费用补偿") ?? 0,
    coverage2.get("恶性肿瘤医疗-定额给付") ?? 0,
  );
  const medicalPresent = hasType.has("医疗险") || medicalFromCoverage2 > 0;
  const accidentAmount = (amountByType.get("意外险") ?? 0) || pickAccidentAmount(coverage2);
  const criticalAmount = (amountByType.get("重疾险") ?? 0) || (coverage2.get("重大疾病") ?? 0);
  const termLifeAmount = (amountByType.get("定期寿险") ?? 0) || pickNonAccidentDeathAmount(coverage2);
  const wholeLifeCount = productsByType.get("终身寿险")?.size ?? 0;
  const specialMedicalPresent = hasType.has("特定医疗险");
  const carePresent = hasType.has("失能护理险");

  const items: ScoreItemDetail[] = [];

  if (classificationId === "single") {
    items.push({
      item: "医疗险",
      account: "健康账户",
      score: medicalPresent ? 35 : 0,
      maxScore: 35,
      detail: medicalPresent ? "已配置" : "缺失（健康兜底底线）",
    });
    items.push({
      item: "意外险",
      account: "生命账户",
      score: accidentAmount > 0 ? (accidentAmount >= 300_000 ? 25 : 12) : 0,
      maxScore: 25,
      detail:
        accidentAmount <= 0
          ? "缺失"
          : accidentAmount >= 300_000
            ? `保额≥30万（${accidentAmount.toLocaleString()}）`
            : `保额<30万（${accidentAmount.toLocaleString()}）`,
    });
    items.push({
      item: "重疾险",
      account: "健康账户",
      score: criticalAmount > 0 ? (criticalAmount >= 300_000 ? 20 : 10) : 0,
      maxScore: 20,
      detail:
        criticalAmount <= 0
          ? "缺失"
          : criticalAmount >= 300_000
            ? `保额≥30万（${criticalAmount.toLocaleString()}）`
            : `保额<30万（${criticalAmount.toLocaleString()}）`,
    });
    items.push({
      item: "定期寿险",
      account: "生命账户",
      score: hasType.has("定期寿险") ? 10 : 0,
      maxScore: 10,
      detail: hasType.has("定期寿险") ? "已配置" : "缺失（按需配置）",
    });
    items.push({
      item: "终身寿险",
      account: "财富账户",
      score: wholeLifeCount > 0 ? 10 : 0,
      maxScore: 10,
      detail: wholeLifeCount > 0 ? `已配置（${wholeLifeCount}件）` : "缺失（预算充足再考虑）",
    });
  } else if (classificationId === "couple") {
    items.push({
      item: "医疗险",
      account: "健康账户",
      score: medicalPresent ? 30 : 0,
      maxScore: 30,
      detail: medicalPresent ? "已配置" : "缺失（健康兜底）",
    });
    items.push({
      item: "重疾险",
      account: "健康账户",
      score: criticalAmount > 0 ? (criticalAmount >= 300_000 ? 25 : 12) : 0,
      maxScore: 25,
      detail:
        criticalAmount <= 0
          ? "缺失"
          : criticalAmount >= 300_000
            ? `保额≥30万（${criticalAmount.toLocaleString()}）`
            : `保额<30万（${criticalAmount.toLocaleString()}）`,
    });
    items.push({
      item: "意外险",
      account: "生命账户",
      score: accidentAmount > 0 ? (accidentAmount >= 300_000 ? 20 : 10) : 0,
      maxScore: 20,
      detail:
        accidentAmount <= 0
          ? "缺失"
          : accidentAmount >= 300_000
            ? `保额≥30万（${accidentAmount.toLocaleString()}）`
            : `保额<30万（${accidentAmount.toLocaleString()}）`,
    });
    items.push({
      item: "定期寿险",
      account: "生命账户",
      score: hasType.has("定期寿险") ? 15 : 0,
      maxScore: 15,
      detail: hasType.has("定期寿险") ? "已配置" : "缺失（覆盖家庭负债）",
    });
    items.push({
      item: "终身寿险",
      account: "财富账户",
      score: wholeLifeCount > 0 ? 10 : 0,
      maxScore: 10,
      detail: wholeLifeCount > 0 ? `已配置（${wholeLifeCount}件）` : "缺失（提前布局教育/养老）",
    });
  } else if (classificationId === "pillar") {
    const threshold = incomeThresholdForPillar(params.persona.personalIncome);
    items.push({
      item: "医疗险",
      account: "健康账户",
      score: medicalPresent ? 25 : 0,
      maxScore: 25,
      detail: medicalPresent ? "已配置" : "缺失（基础医疗兜底）",
    });
    items.push({
      item: "重疾险",
      account: "健康账户",
      score: criticalAmount > 0 ? (criticalAmount >= 500_000 ? 25 : 12) : 0,
      maxScore: 25,
      detail:
        criticalAmount <= 0
          ? "缺失"
          : criticalAmount >= 500_000
            ? `保额≥50万（${criticalAmount.toLocaleString()}）`
            : `保额<50万（${criticalAmount.toLocaleString()}）`,
    });
    items.push({
      item: "意外险",
      account: "生命账户",
      score: accidentAmount > 0 ? (accidentAmount >= 500_000 ? 20 : 10) : 0,
      maxScore: 20,
      detail:
        accidentAmount <= 0
          ? "缺失"
          : accidentAmount >= 500_000
            ? `保额≥50万（${accidentAmount.toLocaleString()}）`
            : `保额<50万（${accidentAmount.toLocaleString()}）`,
    });
    items.push({
      item: "定期寿险",
      account: "生命账户",
      score:
        termLifeAmount > 0 ? (threshold > 0 && termLifeAmount >= threshold ? 20 : 10) : 0,
      maxScore: 20,
      detail:
        termLifeAmount <= 0
          ? "缺失"
          : threshold > 0 && termLifeAmount >= threshold
            ? `保额≥10倍收入阈值（${termLifeAmount.toLocaleString()} / ${threshold.toLocaleString()}）`
            : threshold > 0
              ? `保额<10倍收入阈值（${termLifeAmount.toLocaleString()} / ${threshold.toLocaleString()}）`
              : `已配置（${termLifeAmount.toLocaleString()}）`,
    });
    items.push({
      item: "终身寿险",
      account: "财富账户",
      score: wholeLifeCount >= 2 ? 10 : wholeLifeCount === 1 ? 5 : 0,
      maxScore: 10,
      detail: wholeLifeCount >= 2 ? "配置2类及以上" : wholeLifeCount === 1 ? "配置1类" : "缺失",
    });
  } else if (classificationId === "minor") {
    items.push({
      item: "医疗险",
      account: "健康账户",
      score: medicalPresent ? 30 : 0,
      maxScore: 30,
      detail: medicalPresent ? "已配置" : "缺失（住院医疗兜底）",
    });
    items.push({
      item: "重疾险",
      account: "健康账户",
      score: hasType.has("重疾险") || criticalAmount > 0 ? 25 : 0,
      maxScore: 25,
      detail: hasType.has("重疾险") || criticalAmount > 0 ? "已配置" : "缺失",
    });
    items.push({
      item: "意外险",
      account: "生命账户",
      score: accidentAmount > 0 || hasType.has("意外险") ? 15 : 0,
      maxScore: 30,
      detail: accidentAmount > 0 || hasType.has("意外险") ? "已配置" : "缺失",
    });
    items.push({
      item: "特定医疗险",
      account: "健康账户",
      score: specialMedicalPresent ? 15 : 0,
      maxScore: 15,
      detail: specialMedicalPresent ? "已配置" : "缺失",
    });
  } else {
    items.push({
      item: "医疗险",
      account: "健康账户",
      score: medicalPresent ? 35 : 0,
      maxScore: 35,
      detail: medicalPresent ? "已配置" : "缺失（普通医疗难买时的替代）",
    });
    items.push({
      item: "意外险",
      account: "生命账户",
      score: accidentAmount > 0 || hasType.has("意外险") ? 30 : 0,
      maxScore: 30,
      detail: accidentAmount > 0 || hasType.has("意外险") ? "已配置" : "缺失",
    });
    items.push({
      item: "重疾险",
      account: "健康账户",
      score: hasType.has("重疾险") || criticalAmount > 0 ? 20 : 0,
      maxScore: 20,
      detail: hasType.has("重疾险") || criticalAmount > 0 ? "已配置" : "缺失（按需配置）",
    });
    items.push({
      item: "失能护理险",
      account: "生命账户",
      score: carePresent ? 15 : 0,
      maxScore: 15,
      detail: carePresent ? "已配置" : "缺失",
    });
  }

  const health = sumAccount(items, "健康账户");
  const life = sumAccount(items, "生命账户");
  const wealth = sumAccount(items, "财富账户");
  const total = items.reduce((acc, r) => acc + r.score, 0);
  const clamped = clamp(Math.round(total), 0, 100);
  const label = ratingLabelForScore(clamped);

  return {
    score: clamped,
    ratingLabel: label,
    accounts: [
      { account: "健康账户", ...health },
      { account: "生命账户", ...life },
      { account: "财富账户", ...wealth },
    ],
    items,
  };
}

export function computeProtectionScore(params: {
  persona: CustomerPersona;
  parsed: ParsedMarkdownTables | null;
  confirmedPolicies: Array<Record<string, string>>;
}): ScoreResult | null {
  const details = computeProtectionScoreDetails(params);
  if (!details) return null;
  return { score: details.score, ratingLabel: details.ratingLabel };
}

export function getRatingPillClasses(label: ProtectionRatingLabel) {
  const base = "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium";
  if (label === "完美配置") return `${base} border-amber-200 bg-amber-100 text-amber-900`;
  if (label === "优质配置") return `${base} border-emerald-200 bg-emerald-100 text-emerald-800`;
  if (label === "合格配置") return `${base} border-sky-200 bg-sky-100 text-sky-800`;
  return `${base} border-rose-200 bg-rose-100 text-rose-800`;
}
