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

function findBestPolicyTable(parsed: ParsedMarkdownTables): PolicyTableRef | null {
  let bestRef: PolicyTableRef | null = null;
  let bestScore = -1;

  parsed.sections.forEach((section, sectionIndex) => {
    section.tables.forEach((table, tableIndex) => {
      const headers = table.headers ?? [];
      const hasKey = (k: string) => headers.includes(k);
      const looksLikePolicyTable =
        hasKey("保险条款名称") && hasKey("生效日期") && headers.length >= 3;
      if (!looksLikePolicyTable) return;

      const score = scorePolicyTable(section.heading, headers);
      const ref: PolicyTableRef = {
        sectionIndex,
        sectionHeading: section.heading,
        tableIndex,
        headers,
        rows: table.rows ?? [],
      };
      if (score > bestScore) {
        bestScore = score;
        bestRef = ref;
      }
    });
  });

  return bestRef;
}

export function getConfirmedPolicyRows(parsed: ParsedMarkdownTables | null, meta: Record<string, CardMeta>) {
  if (!parsed) return [];
  const table = findBestPolicyTable(parsed);
  if (!table) return [];

  const customerName = parsed.meta?.customerName;
  const reportId = parsed.meta?.reportId;

  return table.rows
    .map((row, rowIndex) => {
      const id = makePolicyRowId(table.sectionIndex, table.tableIndex, rowIndex);
      let nextRow = row;

      if (customerName) {
        (["被保人", "被保险人", "被保人姓名"] as const).forEach((k) => {
          const v = nextRow[k];
          if (typeof v === "string" && v.trim() === "本人") {
            nextRow = { ...nextRow, [k]: customerName };
          }
        });
      }

      const reportSource = meta[id]?.reportSource ?? reportId;
      if (reportSource) {
        nextRow = { ...nextRow, 报告来源: reportSource };
      }

      return { id, rowIndex, row: nextRow } satisfies ConfirmedPolicyRow;
    })
    .filter((item) => Boolean(meta[item.id]?.confirmed));
}
