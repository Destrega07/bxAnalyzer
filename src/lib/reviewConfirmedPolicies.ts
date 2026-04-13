import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";
import type { CardMeta } from "@/lib/db";
import { makePolicyRowId } from "@/lib/reviewIds";

export type ConfirmedPolicyRow = {
  id: string;
  rowIndex: number;
  row: Record<string, string>;
};

type PolicyTableRef = {
  sectionIndex: number;
  sectionHeading: string;
  tableIndex: number;
  headers: string[];
  rows: Record<string, string>[];
};

export type ReviewPolicyCard = {
  id: string;
  rowIndex: number;
  row: Record<string, string>;
  headers: string[];
  sectionHeading: string;
  sourceRefs: Array<{
    sectionIndex: number;
    tableIndex: number;
    rowIndex: number;
    headers: string[];
  }>;
};

function getCell(row: Record<string, string>, candidates: string[]) {
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function normalizeSelf(value: string, customerName: string | undefined) {
  if (value.trim() === "本人" && customerName) return customerName;
  return value.trim();
}

function inferInsuredName(
  row: Record<string, string>,
  sectionHeading: string,
  customerName: string | undefined,
) {
  const direct = getCell(row, ["被保人", "被保险人", "被保人姓名", "被保人名称"]);
  if (direct) return normalizeSelf(direct, customerName);
  if (sectionHeading.includes("被保人视图")) return customerName?.trim() ?? "";
  return "";
}

function mergeRows(base: Record<string, string>, incoming: Record<string, string>) {
  const merged = { ...base };
  Object.entries(incoming).forEach(([key, value]) => {
    const nextValue = typeof value === "string" ? value : String(value ?? "");
    const prevValue = merged[key];
    if (typeof prevValue !== "string" || prevValue.trim().length === 0) {
      merged[key] = nextValue;
      return;
    }
    if (prevValue.trim() === "本人" && nextValue.trim().length > 0 && nextValue.trim() !== "本人") {
      merged[key] = nextValue;
    }
  });
  return merged;
}

function normalizePolicyRow(
  row: Record<string, string>,
  sectionHeading: string,
  customerName: string | undefined,
) {
  let nextRow = { ...row };

  (["被保人", "被保险人", "被保人姓名", "被保人名称", "投保人"] as const).forEach((key) => {
    const current = nextRow[key];
    if (typeof current === "string" && current.trim() === "本人" && customerName) {
      nextRow[key] = customerName;
    }
  });

  if (
    sectionHeading.includes("被保人视图") &&
    !getCell(nextRow, ["被保人", "被保险人", "被保人姓名", "被保人名称"]) &&
    customerName
  ) {
    nextRow = { ...nextRow, 被保人: customerName };
  }

  return nextRow;
}

function buildPolicyKey(
  row: Record<string, string>,
  sectionHeading: string,
  customerName: string | undefined,
) {
  const productName = getCell(row, ["保险条款名称", "产品名称", "保险产品名称", "保单名称"])
    .replace(/※/g, "")
    .replace(/\s+/g, "")
    .trim();
  const insuredName = inferInsuredName(row, sectionHeading, customerName)
    .replace(/\s+/g, "")
    .trim();
  const effectiveDate = getCell(row, ["生效日期", "生效日"]).trim();
  const expiryDate = getCell(row, ["满期日期", "终止日期"]).trim();
  const mainType = getCell(row, ["主附险"]).trim();
  const category = getCell(row, ["险种类别", "险种分类", "险种"]).trim();
  return [productName, insuredName, effectiveDate, expiryDate, mainType, category].join("|");
}

function scorePolicyTable(sectionHeading: string, headers: string[]) {
  const headingScore = (() => {
    if (sectionHeading.includes("投保人视图")) return 50;
    if (sectionHeading.includes("被保人视图")) return 40;
    if (sectionHeading.includes("保单信息")) return 10;
    return 0;
  })();

  const headerScore = (() => {
    const has = (name: string) => headers.includes(name);
    return (
      (has("保险条款名称") ? 20 : 0) +
      (has("生效日期") ? 20 : 0) +
      (has("被保人") || has("被保险人") ? 10 : 0) +
      (has("满期日期") ? 5 : 0) +
      (has("主附险") ? 5 : 0)
    );
  })();

  return headingScore + headerScore;
}

function findAllPolicyTables(parsed: ParsedMarkdownTables) {
  const refs: PolicyTableRef[] = [];
  parsed.sections.forEach((section, sectionIndex) => {
    section.tables.forEach((table, tableIndex) => {
      const headers = table.headers ?? [];
      const hasKey = (k: string) => headers.includes(k);
      const looksLikePolicyTable =
        hasKey("保险条款名称") && hasKey("生效日期") && headers.length >= 3;
      if (!looksLikePolicyTable) return;

      refs.push({
        sectionIndex,
        sectionHeading: section.heading,
        tableIndex,
        headers,
        rows: table.rows ?? [],
      });
    });
  });

  return refs.sort((a, b) => {
    const scoreDiff = scorePolicyTable(b.sectionHeading, b.headers) - scorePolicyTable(a.sectionHeading, a.headers);
    if (scoreDiff !== 0) return scoreDiff;
    if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
    return a.tableIndex - b.tableIndex;
  });
}

export function getReviewPolicyCards(parsed: ParsedMarkdownTables | null): ReviewPolicyCard[] {
  if (!parsed) return [];

  const customerName = parsed.meta?.customerName;
  const refs = findAllPolicyTables(parsed);
  const merged = new Map<
    string,
    {
      card: ReviewPolicyCard;
      headerSet: Set<string>;
    }
  >();

  refs.forEach((ref) => {
    ref.rows.forEach((row, rowIndex) => {
      const normalizedRow = normalizePolicyRow(row, ref.sectionHeading, customerName);
      const key = buildPolicyKey(normalizedRow, ref.sectionHeading, customerName);
      const id = makePolicyRowId(ref.sectionIndex, ref.tableIndex, rowIndex);
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          card: {
            id,
            rowIndex,
            row: normalizedRow,
            headers: ref.headers.slice(),
            sectionHeading: ref.sectionHeading,
            sourceRefs: [
              {
                sectionIndex: ref.sectionIndex,
                tableIndex: ref.tableIndex,
                rowIndex,
                headers: ref.headers.slice(),
              },
            ],
          },
          headerSet: new Set(ref.headers),
        });
        return;
      }

      existing.card.row = mergeRows(existing.card.row, normalizedRow);
      ref.headers.forEach((header) => {
        if (!existing.headerSet.has(header)) {
          existing.headerSet.add(header);
          existing.card.headers.push(header);
        }
      });
      existing.card.sourceRefs.push({
        sectionIndex: ref.sectionIndex,
        tableIndex: ref.tableIndex,
        rowIndex,
        headers: ref.headers.slice(),
      });
    });
  });

  return Array.from(merged.values()).map((item) => item.card);
}

export function getConfirmedPolicyRows(parsed: ParsedMarkdownTables | null, meta: Record<string, CardMeta>) {
  if (!parsed) return [];
  const reportId = parsed.meta?.reportId;

  return getReviewPolicyCards(parsed)
    .map((card) => {
      let nextRow = card.row;
      const reportSource = meta[card.id]?.reportSource ?? reportId;
      if (reportSource) {
        nextRow = { ...nextRow, 报告来源: reportSource };
      }
      const insuranceType = meta[card.id]?.insuranceType;
      if (insuranceType) {
        nextRow = { ...nextRow, 险种标签: insuranceType };
      }

      return { id: card.id, rowIndex: card.rowIndex, row: nextRow } satisfies ConfirmedPolicyRow;
    })
    .filter((item) => Boolean(meta[item.id]?.confirmed));
}
