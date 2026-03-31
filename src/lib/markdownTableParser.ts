export type ParsedTable = {
  headers: string[];
  rows: Record<string, string>[];
};

export type ParsedMarkdownMeta = {
  reportId?: string;
  generatedAt?: string;
  customerName?: string;
};

export type ParsedSection = {
  heading: string;
  level: number;
  tables: ParsedTable[];
};

export type ParsedMarkdownTables = {
  meta: ParsedMarkdownMeta;
  sections: ParsedSection[];
};

function isHeadingLine(line: string) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, heading: match[2] };
}

function parseMetaLine(
  line: string,
): { key: keyof ParsedMarkdownMeta; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = /^([^：:]+)[：:]\s*(.+?)\s*$/.exec(trimmed);
  if (!match) return null;

  const rawKey = match[1].trim();
  const value = match[2].trim();
  if (!value) return null;

  if (rawKey === "报告编号") return { key: "reportId", value };
  if (rawKey === "生成日期") return { key: "generatedAt", value };
  if (rawKey === "客户姓名") return { key: "customerName", value };
  return null;
}

function splitRowCells(line: string) {
  const trimmed = line.trim();
  const noLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const noTrailing = noLeading.endsWith("|")
    ? noLeading.slice(0, -1)
    : noLeading;
  return noTrailing.split("|").map((cell) => cell.trim());
}

function isSeparatorLine(line: string) {
  const cells = splitRowCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRowLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitRowCells(trimmed);
  return cells.length >= 2 && cells.some((c) => c.length > 0);
}

function parseTable(lines: string[], startIndex: number) {
  const headerLine = lines[startIndex] ?? "";
  const separatorLine = lines[startIndex + 1] ?? "";

  if (!isTableRowLine(headerLine) || !isSeparatorLine(separatorLine)) {
    return null;
  }

  const headers = splitRowCells(headerLine).filter((h) => h.length > 0);
  const rows: Record<string, string>[] = [];

  let i = startIndex + 2;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!isTableRowLine(line)) break;

    const rawCells = splitRowCells(line);
    const cells = rawCells.slice(0, headers.length);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? "").trim();
    });
    rows.push(row);
    i += 1;
  }

  return {
    table: { headers, rows } satisfies ParsedTable,
    nextIndex: i,
  };
}

export function parseMarkdownTables(markdown: string): ParsedMarkdownTables {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const meta: ParsedMarkdownMeta = {};
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trimEnd();

    const heading = isHeadingLine(line);
    if (heading) {
      currentSection = {
        heading: heading.heading,
        level: heading.level,
        tables: [],
      };
      sections.push(currentSection);
      i += 1;
      continue;
    }

    if (!currentSection) {
      const metaItem = parseMetaLine(line);
      if (metaItem) {
        meta[metaItem.key] = metaItem.value;
        i += 1;
        continue;
      }
    }

    const parsed = parseTable(lines, i);
    if (parsed) {
      if (!currentSection) {
        currentSection = { heading: "未命名", level: 0, tables: [] };
        sections.push(currentSection);
      }
      currentSection.tables.push(parsed.table);
      i = parsed.nextIndex;
      continue;
    }

    i += 1;
  }

  return { meta, sections };
}

