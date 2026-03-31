import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";

export type PolicyRow = Record<string, string>;

export type MemberRole = "self" | "family";
export type MemberStatus = "active" | "pending";

export type PolicyRef = {
  policyName: string;
  category: string;
  insuredName: string;
  reportSource?: string;
  amount?: number;
  paidPremium?: number;
  isLinked?: boolean;
  linkReason?: string;
  raw: PolicyRow;
};

export type LevelKV = {
  name: string;
  amount: number;
};

export type HealthCriticalAccount = {
  mainAmount: number;
  middleAmount: number;
  lightAmount: number;
  level2Details: LevelKV[];
  policies: PolicyRef[];
};

export type HealthMedicalAccount = {
  annualLimit: number;
  level2Details: LevelKV[];
  policies: PolicyRef[];
};

export type LifeDeathAccount = {
  amount: number;
  level2Details: LevelKV[];
  policies: PolicyRef[];
  level3Details: LevelKV[];
};

export type WealthAccount = {
  paidPremium: number;
  policies: PolicyRef[];
};

export type AssetSummary = {
  cashValueTotal: number;
  accountValueTotal: number;
};

export type HouseholdMemberModel = {
  insuredName: string;
  role: MemberRole;
  status: MemberStatus;
  policyCount: number;
  accounts: {
    healthCritical: HealthCriticalAccount;
    healthMedical: HealthMedicalAccount;
    lifeDeath: LifeDeathAccount;
    wealth: WealthAccount;
  };
};

export type HouseholdModel = {
  customerName?: string;
  reportId?: string;
  generatedAt?: string;
  assets: AssetSummary;
  members: HouseholdMemberModel[];
};

function getCell(row: PolicyRow, candidates: string[]) {
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function parseAmount(value: string) {
  const v = value.trim();
  if (!v || v === "-") return 0;

  const normalized = v.replace(/,/g, "");
  const match = /(-?\d+(\.\d+)?)/.exec(normalized);
  if (!match) return 0;

  const num = Number(match[1]);
  if (!Number.isFinite(num)) return 0;

  if (/万/.test(normalized)) return num * 10000;
  return num;
}

function getInsuredName(row: PolicyRow) {
  return getCell(row, ["被保人", "被保险人", "被保人姓名", "被保人名称"]);
}

function getPolicyName(row: PolicyRow) {
  return getCell(row, ["保险条款名称", "产品名称", "保险产品名称", "保单名称"]);
}

function getCategory(row: PolicyRow) {
  return getCell(row, ["险种类别", "险种分类", "险种", "险别"]);
}

function getPaidPremium(row: PolicyRow) {
  return parseAmount(
    getCell(row, [
      "累计交费",
      "累计交费(元)",
      "累计已交保费",
      "累计已交保费(元)",
      "已交保费",
      "已交保费(元)",
    ]),
  );
}

function getCoverageAmount(row: PolicyRow) {
  return parseAmount(
    getCell(row, [
      "保额",
      "基本保额",
      "保险金额",
      "保障金额",
      "保额(元)",
      "保险金额(元)",
      "保障金额(元)",
      "保障金额-二级",
      "保障金额-三级",
    ]),
  );
}

function getReportSource(row: PolicyRow) {
  return getCell(row, ["报告来源", "报告编号"]);
}

function isWealthPolicy(category: string) {
  return (
    category.includes("年金") ||
    category.includes("两全") ||
    category.includes("终身寿")
  );
}

function isCriticalIllnessPolicy(category: string) {
  return category.includes("健康-疾病") || category.includes("疾病保险");
}

function isMedicalPolicy(category: string) {
  return category.includes("健康-医疗") || category.includes("医疗保险");
}

function isLifeDeathPolicy(category: string) {
  return category.includes("人寿") || category.includes("意外");
}

function findTable(
  parsed: ParsedMarkdownTables,
  headingIncludes: string,
  requiredHeaders: string[],
) {
  for (const section of parsed.sections) {
    if (!section.heading.includes(headingIncludes)) continue;
    for (const table of section.tables) {
      if (requiredHeaders.every((h) => table.headers.includes(h))) return table;
    }
  }
  return null;
}

function tableToKeyValueMap(
  table: { rows: Record<string, string>[] },
  keyHeader: string,
  valueHeader: string,
) {
  const map = new Map<string, string>();
  table.rows.forEach((row) => {
    const k = (row[keyHeader] ?? "").trim();
    const v = (row[valueHeader] ?? "").trim();
    if (k) map.set(k, v);
  });
  return map;
}

function getCoverage2(parsed: ParsedMarkdownTables) {
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

function getCoverage3(parsed: ParsedMarkdownTables) {
  const table = findTable(parsed, "保障责任精读", [
    "保障责任-三级",
    "保障金额-三级",
  ]);
  if (!table) return new Map<string, number>();
  const kv = tableToKeyValueMap(table, "保障责任-三级", "保障金额-三级");
  const out = new Map<string, number>();
  kv.forEach((v, k) => out.set(k, parseAmount(v)));
  return out;
}

function getOverviewAssets(parsed: ParsedMarkdownTables) {
  const table = findTable(parsed, "保单概览", ["统计项", "统计值"]);
  if (!table) return { cashValueTotal: 0, accountValueTotal: 0 };
  const kv = tableToKeyValueMap(table, "统计项", "统计值");
  const cashValueTotal = parseAmount(kv.get("现金价值") ?? "0");
  const accountValueTotal = parseAmount(kv.get("账户价值") ?? "0");
  return { cashValueTotal, accountValueTotal };
}

function ensureMember(
  map: Map<string, HouseholdMemberModel>,
  insuredName: string,
  customerName?: string,
) {
  const existing = map.get(insuredName);
  if (existing) return existing;

  const role: MemberRole =
    customerName && insuredName === customerName ? "self" : "family";
  const status: MemberStatus = role === "self" ? "active" : "pending";

  const member: HouseholdMemberModel = {
    insuredName,
    role,
    status,
    policyCount: 0,
    accounts: {
      healthCritical: {
        mainAmount: 0,
        middleAmount: 0,
        lightAmount: 0,
        level2Details: [],
        policies: [],
      },
      healthMedical: { annualLimit: 0, level2Details: [], policies: [] },
      lifeDeath: { amount: 0, level2Details: [], policies: [], level3Details: [] },
      wealth: { paidPremium: 0, policies: [] },
    },
  };
  map.set(insuredName, member);
  return member;
}

function buildLevel2Details(
  coverage2: Map<string, number>,
  account: "healthCritical" | "healthMedical" | "lifeDeath",
) {
  const entries = Array.from(coverage2.entries()).filter(([, v]) => v > 0);

  if (account === "healthCritical") {
    return entries
      .filter(([k]) => {
        if (k.includes("医疗")) return false;
        if (k.startsWith("身故-")) return false;
        if (k.startsWith("全残") || k.startsWith("伤残")) return false;
        return k.includes("疾病") || k.includes("重疾") || k.includes("轻症") || k.includes("中症");
      })
      .map(([name, amount]) => ({ name, amount }));
  }

  if (account === "healthMedical") {
    return entries
      .filter(([k]) => {
        return (
          k === "医疗责任" ||
          k.includes("医疗") ||
          k.startsWith("一般医疗") ||
          k.startsWith("意外医疗") ||
          k.startsWith("恶性肿瘤医疗") ||
          k.includes("住院") ||
          k.includes("门诊")
        );
      })
      .map(([name, amount]) => ({ name, amount }));
  }

  return entries
    .filter(([k]) => {
      return (
        k === "身故保障" ||
        k.startsWith("身故-") ||
        k.startsWith("全残") ||
        k.startsWith("伤残")
      );
    })
    .map(([name, amount]) => ({ name, amount }));
}

function linkDedupe(member: HouseholdMemberModel) {
  const byName = new Map<string, { critical?: PolicyRef; death?: PolicyRef }>();

  member.accounts.healthCritical.policies.forEach((p) => {
    if (!p.policyName) return;
    const item = byName.get(p.policyName) ?? {};
    item.critical = p;
    byName.set(p.policyName, item);
  });

  member.accounts.lifeDeath.policies.forEach((p) => {
    if (!p.policyName) return;
    const item = byName.get(p.policyName) ?? {};
    item.death = p;
    byName.set(p.policyName, item);
  });

  byName.forEach((pair) => {
    const a = pair.critical;
    const b = pair.death;
    if (!a || !b) return;
    if (!a.amount || !b.amount) return;
    if (a.amount !== b.amount) return;

    a.isLinked = true;
    b.isLinked = true;
    a.linkReason = "主险与附加险共享保额";
    b.linkReason = "主险与附加险共享保额";
  });
}

export function aggregateHouseholdModel(
  confirmedPolicies: PolicyRow[],
  parsed: ParsedMarkdownTables | null,
): HouseholdModel {
  const customerName = parsed?.meta?.customerName;
  const reportId = parsed?.meta?.reportId;
  const generatedAt = parsed?.meta?.generatedAt;

  const membersMap = new Map<string, HouseholdMemberModel>();

  if (customerName) {
    ensureMember(membersMap, customerName, customerName);
  }

  confirmedPolicies.forEach((row) => {
    const insuredName = getInsuredName(row);
    if (!insuredName) return;

    const member = ensureMember(membersMap, insuredName, customerName);
    member.policyCount += 1;

    const policyName = getPolicyName(row) || "未命名保单";
    const category = getCategory(row);
    const reportSource = getReportSource(row) || reportId;

    const ref: PolicyRef = {
      policyName,
      category,
      insuredName,
      reportSource: reportSource || undefined,
      raw: row,
    };

    if (isWealthPolicy(category)) {
      const paidPremium = getPaidPremium(row);
      ref.paidPremium = paidPremium;
      member.accounts.wealth.paidPremium += paidPremium;
      member.accounts.wealth.policies.push(ref);
      return;
    }

    if (isCriticalIllnessPolicy(category)) {
      const amount = getCoverageAmount(row);
      if (amount > 0) ref.amount = amount;
      member.accounts.healthCritical.policies.push(ref);
      return;
    }

    if (isMedicalPolicy(category)) {
      const amount = getCoverageAmount(row);
      if (amount > 0) ref.amount = amount;
      member.accounts.healthMedical.policies.push(ref);
      return;
    }

    if (isLifeDeathPolicy(category)) {
      const amount = getCoverageAmount(row);
      if (amount > 0) ref.amount = amount;
      member.accounts.lifeDeath.policies.push(ref);
      return;
    }
  });

  membersMap.forEach((m) => linkDedupe(m));

  const assets = parsed ? getOverviewAssets(parsed) : { cashValueTotal: 0, accountValueTotal: 0 };
  if (customerName) {
    const self = membersMap.get(customerName);
    if (self && parsed) {
      const coverage2 = getCoverage2(parsed);
      const coverage3 = getCoverage3(parsed);

      self.accounts.healthCritical.mainAmount = coverage2.get("重大疾病") ?? 0;
      self.accounts.healthCritical.middleAmount = coverage2.get("中症疾病") ?? 0;
      self.accounts.healthCritical.lightAmount = coverage2.get("轻症疾病") ?? 0;
      self.accounts.healthCritical.level2Details = buildLevel2Details(
        coverage2,
        "healthCritical",
      );

      self.accounts.healthMedical.annualLimit =
        coverage2.get("医疗责任") ??
        coverage2.get("住院医疗") ??
        coverage2.get("一般医疗-费用补偿") ??
        0;
      self.accounts.healthMedical.level2Details = buildLevel2Details(
        coverage2,
        "healthMedical",
      );

      self.accounts.lifeDeath.amount =
        coverage2.get("身故保障") ?? coverage2.get("身故-疾病/非意外") ?? 0;
      self.accounts.lifeDeath.level2Details = buildLevel2Details(coverage2, "lifeDeath");

      self.accounts.lifeDeath.level3Details = Array.from(coverage3.entries())
        .filter(([k]) => k.startsWith("身故-"))
        .map(([k, v]) => ({ name: k, amount: v }));
    }
  }

  const members = Array.from(membersMap.values()).sort((a, b) =>
    a.insuredName.localeCompare(b.insuredName, "zh-CN"),
  );

  return {
    customerName,
    reportId,
    generatedAt,
    assets,
    members,
  };
}
