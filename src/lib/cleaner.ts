type JsonRecord = Record<string, unknown>;

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sanitizeMarkdownText(input: string) {
  const text = input.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text;
}

function unescapeCapturedText(input: string) {
  let out = input;
  for (let i = 0; i < 6; i += 1) {
    const next = out
      .replace(/\\\\r\\\\n/g, "\n")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
    if (next === out) break;
    out = next;
  }
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(
      /\\u([0-9a-fA-F]{4})/g,
      (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)),
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

function normalizeForMatch(input: string) {
  return input
    .replace(/：/g, ":")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .trim();
}

function normalizeSectionHeading(rawHeading: string) {
  const heading = normalizeForMatch(rawHeading.replace(/^#+\s*/, ""));
  if (/保单概览/.test(heading)) return "## 保单概览统计信息";
  if (/被保人视图/.test(heading)) return "## 被保人视图保单清单";
  if (/投保人视图/.test(heading)) return "## 投保人视图保单清单";
  if (/保障责任/.test(heading) && /精读|三级/.test(heading)) return "## 保障责任精读汇总";
  if (/保障责任/.test(heading) && /汇总/.test(heading) && !/精读/.test(heading)) return "## 保障责任汇总";
  if (/月度.*交费|交费.*月度/.test(heading)) return "## 月度交费备忘录";
  return null;
}

function trimJsonDebris(text: string) {
  const lines = text.replace(/\u0000/g, "").split("\n");
  const cleaned = lines.map((raw) => {
    let line = raw;
    const idxBrace = line.search(/\|\s*"\}/);
    if (idxBrace >= 0) line = `${line.slice(0, idxBrace + 1).trimEnd()}`;
    const idxBracket = line.search(/\|\s*"\]/);
    if (idxBracket >= 0) line = `${line.slice(0, idxBracket + 1).trimEnd()}`;
    return line;
  });
  return cleaned.join("\n").replace(/[\s\r\n]*["\}\],]+[\s\r\n]*$/g, "").trim();
}

function pickFromMessageList(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as JsonRecord;
  const rootData = rec["messagesData"] && typeof rec["messagesData"] === "object" ? (rec["messagesData"] as JsonRecord) : rec;
  const list = rootData["data"];
  if (!Array.isArray(list)) return null;
  const rows = list.filter((x) => x && typeof x === "object") as JsonRecord[];
  const pick = (targetType: string) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const type = typeof row["type"] === "string" ? row["type"] : "";
      const content = typeof row["content"] === "string" ? row["content"].trim() : "";
      if (type === targetType && content.length > 0) return content;
    }
    return null;
  };
  return pick("answer") ?? pick("tool_response") ?? pick("verbose");
}

function gatherStringCandidates(input: unknown) {
  const found = new Set<string>();
  const visited = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (node == null) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (!text) return;
      const unescaped = sanitizeMarkdownText(unescapeCapturedText(text));
      found.add(unescaped);
      if (depth < 8 && (text.startsWith("{") || text.startsWith("["))) {
        const parsed = safeJsonParse(text);
        if (parsed != null) visit(parsed, depth + 1);
      }
      if (depth < 8 && (unescaped.startsWith("{") || unescaped.startsWith("["))) {
        const parsed = safeJsonParse(unescaped);
        if (parsed != null) visit(parsed, depth + 1);
      }
      return;
    }
    if (typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    Object.values(node as JsonRecord).forEach((value) => visit(value, depth + 1));
  };
  visit(input, 0);
  return Array.from(found);
}

function extractTopFields(text: string) {
  const normalized = normalizeForMatch(text);
  const reportNo = normalized.match(/报告编号[:：]\s*(.+)/)?.[0]?.trim() ?? "";
  const generatedAt = normalized.match(/生成日期[:：]\s*(.+)/)?.[0]?.trim() ?? "";
  const customerName = normalized.match(/客户姓名[:：]\s*(.+)/)?.[0]?.trim() ?? "";
  return [reportNo, generatedAt, customerName].filter(Boolean);
}

type SectionBlock = { heading: string; lines: string[] };

function scanSections(text: string) {
  const source = text.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const blocks = new Map<string, SectionBlock>();
  const orderedHeadings: string[] = [];
  const cleanTableLine = (raw: string) => {
    let row = raw.trim();
    if (!row) return null;
    if (!row.startsWith("|")) return null;
    const idxBrace = row.search(/\|\s*"\}/);
    if (idxBrace >= 0) row = row.slice(0, idxBrace + 1).trimEnd();
    const idxBracket = row.search(/\|\s*"\]/);
    if (idxBracket >= 0) row = row.slice(0, idxBracket + 1).trimEnd();
    if (!row.endsWith("|")) return null;
    if (/[}\]"]\s*\|\s*$/.test(row)) return null;
    return row;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!/^#+\s*/.test(line)) {
      i += 1;
      continue;
    }
    const normalizedHeading = normalizeSectionHeading(line);
    const start = i;
    i += 1;
    while (i < lines.length) {
      if (/^#+\s*/.test(lines[i] ?? "")) break;
      i += 1;
    }
    if (!normalizedHeading) continue;
    const blockLines = lines.slice(start, i);
    const tableLines = blockLines
      .map((row) => cleanTableLine(row))
      .filter((row): row is string => typeof row === "string");
    if (!tableLines.length) continue;
    const existing = blocks.get(normalizedHeading);
    if (!existing || tableLines.join("\n").length > existing.lines.join("\n").length) {
      blocks.set(normalizedHeading, { heading: normalizedHeading, lines: tableLines });
    }
    if (!orderedHeadings.includes(normalizedHeading)) {
      orderedHeadings.push(normalizedHeading);
    }
  }

  const ordered = orderedHeadings
    .map((heading) => blocks.get(heading))
    .filter((x): x is SectionBlock => Boolean(x));
  return ordered;
}

export type CleanInsuranceResult = {
  markdown: string;
  matchedSections: string[];
  hasPolicyTable: boolean;
};

export function cleanInsuranceData(input: unknown): CleanInsuranceResult | null {
  const resolvedInput = (() => {
    if (input && typeof input === "object") return input;
    if (typeof input === "string") {
      const parsed = safeJsonParse(input);
      return parsed ?? input;
    }
    return input;
  })();

  const preferredDirect =
    resolvedInput && typeof resolvedInput === "object" && typeof (resolvedInput as JsonRecord)["preferred_content"] === "string"
      ? String((resolvedInput as JsonRecord)["preferred_content"])
      : null;
  const preferredFromMessages = pickFromMessageList(resolvedInput);
  const candidates = [preferredDirect, preferredFromMessages, ...gatherStringCandidates(resolvedInput)].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );

  let bestMarkdown = "";
  let bestSections: string[] = [];
  let bestHasPolicyTable = false;

  for (const candidate of candidates) {
    const text = trimJsonDebris(sanitizeMarkdownText(unescapeCapturedText(candidate))).replace(/\r\n?/g, "\n");
    const top = extractTopFields(text);
    const sections = scanSections(text);
    const sectionNames = sections.map((s) => s.heading.replace(/^##\s*/, ""));
    const hasPolicyTable = sections.some(
      (s) => s.heading.includes("被保人视图保单清单") || s.heading.includes("投保人视图保单清单"),
    );
    const markdown = [...top, ...sections.map((s) => [s.heading, ...s.lines].join("\n"))].join("\n\n").trim();
    const score = markdown.length + sections.length * 1000 + (hasPolicyTable ? 2000 : 0);
    const bestScore = bestMarkdown.length + bestSections.length * 1000 + (bestHasPolicyTable ? 2000 : 0);
    if (score > bestScore) {
      bestMarkdown = markdown;
      bestSections = sectionNames;
      bestHasPolicyTable = hasPolicyTable;
    }
  }

  if (!bestMarkdown) return null;
  if (bestSections.length > 0) {
    console.log(`[Cleaner] 成功提取章节：${bestSections.join("、")}`);
  }
  return {
    markdown: bestMarkdown,
    matchedSections: bestSections,
    hasPolicyTable: bestHasPolicyTable,
  };
}
