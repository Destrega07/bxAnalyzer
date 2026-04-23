"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCaseContext } from "@/context/CaseContext";
import type { ReportStrategy } from "@/lib/db";

function renderInlineBold(text: string) {
  const parts: Array<{ type: "text" | "strong"; value: string }> = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf("**");
    if (start < 0) {
      parts.push({ type: "text", value: rest });
      break;
    }
    const end = rest.indexOf("**", start + 2);
    if (end < 0) {
      parts.push({ type: "text", value: rest });
      break;
    }
    const before = rest.slice(0, start);
    const bold = rest.slice(start + 2, end);
    if (before) parts.push({ type: "text", value: before });
    if (bold) parts.push({ type: "strong", value: bold });
    rest = rest.slice(end + 2);
  }
  return parts;
}

type ScoreAccountBar = {
  account: "健康账户" | "生命账户" | "财富账户";
  score: number;
  maxScore: number;
};

function parseScoreAccountBars(clientDataJson: unknown): ScoreAccountBar[] {
  const snapshot =
    typeof clientDataJson === "object" && clientDataJson !== null
      ? (clientDataJson as { snapshot?: unknown }).snapshot
      : null;
  const scoring =
    typeof snapshot === "object" && snapshot !== null
      ? (snapshot as { scoring?: unknown }).scoring
      : null;
  const accounts =
    typeof scoring === "object" && scoring !== null
      ? (scoring as { accounts?: unknown }).accounts
      : null;
  if (!Array.isArray(accounts)) return [];
  const labels = new Set(["健康账户", "生命账户", "财富账户"]);
  return accounts
    .map((row) => {
      const account = typeof row === "object" && row !== null ? (row as { account?: unknown }).account : "";
      const score = typeof row === "object" && row !== null ? (row as { score?: unknown }).score : 0;
      const maxScore = typeof row === "object" && row !== null ? (row as { maxScore?: unknown }).maxScore : 0;
      return {
        account: typeof account === "string" && labels.has(account) ? (account as ScoreAccountBar["account"]) : null,
        score: Number(score),
        maxScore: Number(maxScore),
      };
    })
    .filter((row): row is ScoreAccountBar => row.account !== null)
    .map((row) => ({
      account: row.account,
      score: Number.isFinite(row.score) ? row.score : 0,
      maxScore: Number.isFinite(row.maxScore) ? row.maxScore : 0,
    }));
}

function renderInlineParts(parts: Array<{ type: "text" | "strong"; value: string }>) {
  return parts.map((p, i) =>
    p.type === "strong" ? (
      <strong key={i} className="font-semibold text-[#D31145]">
        {p.value}
      </strong>
    ) : (
      <span key={i}>{p.value}</span>
    ),
  );
}

function stripListPrefix(line: string) {
  return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "");
}

function normalizeTablePipes(line: string) {
  return line.replace(/｜/g, "|");
}

function splitPipeRow(line: string) {
  let text = normalizeTablePipes(stripListPrefix(line)).trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((c) => c.trim());
}

function isTableSeparatorLine(line: string) {
  const normalized = normalizeTablePipes(stripListPrefix(line)).trim();
  if (!normalized) return false;
  if (!normalized.includes("|")) return /^:?\s*-+\s*:?$/.test(normalized);
  const cells = splitPipeRow(normalized);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?\s*-+\s*:?$/.test(c));
}

function shouldInsertAccountChart(line: string) {
  const normalized = stripListPrefix(line)
    .replace(/\*/g, "")
    .replace(/\s+/g, "");
  return /03[｜|]三大账户总览/.test(normalized);
}

function isAccountOverviewSubheading(line: string) {
  const normalized = stripListPrefix(line)
    .replace(/\*/g, "")
    .trim();
  return (
    /^A[｜|]健康账户（医疗与重疾）$/.test(normalized) ||
    /^B[｜|]生命账户（意外与寿险）$/.test(normalized) ||
    /^C[｜|]财富账户（长期储蓄与传承）$/.test(normalized)
  );
}

function getTodayDateLabel() {
  const text = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  const nums = text.match(/\d+/g) ?? [];
  const y = nums[0] ?? String(new Date().getFullYear());
  const m = nums[1] ?? String(new Date().getMonth() + 1);
  const d = nums[2] ?? String(new Date().getDate());
  return `${Number(y)}年${Number(m)}月${Number(d)}日`;
}

function normalizeReportTitleDate(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const idx = lines.findIndex((line) => line.trim().length > 0);
  if (idx < 0) return markdown;
  const today = getTodayDateLabel();
  const original = lines[idx] ?? "";
  let updated = original.replace(/([—-]\s*)20\d{2}年\d{1,2}月\d{1,2}日/g, `$1${today}`);
  if (updated === original) {
    updated = updated.replace(/20\d{2}年\d{1,2}月\d{1,2}日/g, today);
  }
  lines[idx] = updated;
  return lines.join("\n");
}

function AccountScoreBars({ accounts }: { accounts: ScoreAccountBar[] }) {
  const orderedAccounts: ScoreAccountBar["account"][] = ["健康账户", "生命账户", "财富账户"];
  const rows = orderedAccounts.map((account) => {
    const matched = accounts.find((a) => a.account === account);
    return {
      account,
      score: matched?.score ?? 0,
      maxScore: matched?.maxScore ?? 0,
    };
  });

  return (
    <div className="my-3 rounded-xl border border-zinc-200 bg-white p-3">
      <div className="text-xs font-semibold text-zinc-700">三大账户得分</div>
      <div className="mt-2 space-y-2">
        {rows.map((row) => {
          const percent =
            row.maxScore > 0
              ? Math.max(0, Math.min(100, Math.round((row.score / row.maxScore) * 100)))
              : 0;
          return (
            <div key={row.account}>
              <div className="flex items-center justify-between text-xs text-zinc-700">
                <span>{row.account}</span>
                <span className="tabular-nums">
                  {row.score}/{row.maxScore}
                </span>
              </div>
              <div
                className="mt-1 h-2 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: percent < 100 ? "#F4F4F5" : "transparent" }}
              >
                <div
                  className="h-full rounded-full bg-[#D31145] transition-[width]"
                  style={{ width: `${percent}%`, backgroundColor: "#D31145" }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarkdownView({ markdown, scoreAccounts }: { markdown: string; scoreAccounts: ScoreAccountBar[] }) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const raw = line.trimEnd();
    const key = `${i}:${raw.slice(0, 16)}`;
    const strippedRaw = stripListPrefix(raw);

    if (!raw) {
      nodes.push(<div key={`sp:${key}`} className="h-2" />);
      i += 1;
      continue;
    }
    if (strippedRaw.trim() === "[ACCOUNT_CHART]") {
      nodes.push(<AccountScoreBars key={`chart:${key}`} accounts={scoreAccounts} />);
      i += 1;
      continue;
    }
    const nextStrippedRaw = stripListPrefix(lines[i + 1] ?? "").trim();
    const shouldStartTable =
      /[|｜]/.test(strippedRaw) && i + 1 < lines.length && /[|｜]/.test(nextStrippedRaw);
    if (shouldStartTable) {
      const headers = splitPipeRow(strippedRaw);
      const bodyRows: string[][] = [];
      let j = i + 1;
      if (isTableSeparatorLine(nextStrippedRaw)) {
        j = i + 2;
      }
      while (j < lines.length) {
        const rowText = (lines[j] ?? "").trim();
        const strippedRowText = stripListPrefix(rowText).trim();
        if (!strippedRowText || !/[|｜]/.test(strippedRowText)) break;
        if (isTableSeparatorLine(strippedRowText)) {
          j += 1;
          continue;
        }
        bodyRows.push(splitPipeRow(strippedRowText));
        j += 1;
      }
      nodes.push(
        <div key={`tb:${key}`} className="my-3 w-full overflow-x-auto rounded-xl border border-zinc-200">
          <table className="table-auto w-full min-w-full border-separate border-spacing-0 text-sm text-zinc-800">
            <thead>
              <tr>
                {headers.map((cell, idx) => (
                  <th
                    key={`th:${idx}`}
                    className={[
                      "border-b-2 border-b-[#D31145] border-r border-zinc-200 bg-zinc-50 px-4 py-3 text-left font-semibold text-zinc-900 last:border-r-0",
                        idx === 0 ? "min-w-[140px] max-w-[280px] whitespace-normal break-words" : "",
                    ].join(" ")}
                  >
                    {renderInlineParts(renderInlineBold(cell))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ridx) => (
                <tr key={`tr:${ridx}`}>
                  {headers.map((_, cidx) => (
                    <td
                      key={`td:${ridx}:${cidx}`}
                      className={[
                        "border-t border-r border-zinc-200 px-4 py-3 align-top last:border-r-0",
                        cidx === 0 ? "min-w-[140px] max-w-[280px] whitespace-normal break-words" : "",
                      ].join(" ")}
                    >
                      {renderInlineParts(renderInlineBold(row[cidx] ?? ""))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }
    if (raw.trim() === "---") {
      nodes.push(<div key={`hr:${key}`} className="my-4 border-t border-zinc-200" />);
      i += 1;
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s*(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const title = heading[2] ?? "";
      if (level <= 1) {
        nodes.push(
          <h2 key={`h1:${key}`} className="text-lg font-semibold tracking-tight text-zinc-900">
            {title}
          </h2>,
        );
      } else if (level === 2) {
        nodes.push(
          <h3 key={`h2:${key}`} className="pt-2 text-base font-semibold text-zinc-900">
            {title}
          </h3>,
        );
      } else {
        nodes.push(
          <h4 key={`h3:${key}`} className="pt-2 text-sm font-semibold text-zinc-900">
            {title}
          </h4>,
        );
      }
      const hasNearbyPlaceholder = lines
        .slice(i + 1, i + 4)
        .some((nextLine) => stripListPrefix(nextLine ?? "").trim() === "[ACCOUNT_CHART]");
      if (shouldInsertAccountChart(raw) && !hasNearbyPlaceholder) {
        nodes.push(<AccountScoreBars key={`chart:title:${key}`} accounts={scoreAccounts} />);
      }
      i += 1;
      continue;
    }
    const li = raw.match(/^-+\s+(.*)$/);
    if (li) {
      nodes.push(
        <div key={`li:${key}`} className="flex gap-2 text-sm text-zinc-800">
          <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" />
          <div className="min-w-0">{renderInlineParts(renderInlineBold(li[1]))}</div>
        </div>,
      );
      i += 1;
      continue;
    }
    if (isAccountOverviewSubheading(raw)) {
      nodes.push(
        <p key={`acc-h:${key}`} className="pt-1 text-sm font-semibold text-zinc-900">
          {renderInlineParts(renderInlineBold(stripListPrefix(raw).trim()))}
        </p>,
      );
      i += 1;
      continue;
    }
    nodes.push(
      <p key={`p:${key}`} className="text-sm leading-6 text-zinc-800">
        {renderInlineParts(renderInlineBold(raw))}
      </p>,
    );
    const hasNearbyPlaceholder = lines
      .slice(i + 1, i + 4)
      .some((nextLine) => stripListPrefix(nextLine ?? "").trim() === "[ACCOUNT_CHART]");
    if (shouldInsertAccountChart(raw) && !hasNearbyPlaceholder) {
      nodes.push(<AccountScoreBars key={`chart:line:${key}`} accounts={scoreAccounts} />);
    }
    i += 1;
  }

  return (
    <div className="space-y-2">{nodes}</div>
  );
}

function getStrategyLabel(strategy: ReportStrategy) {
  if (strategy === "professional_premium") return "专业溢价";
  if (strategy === "needs_resonance") return "需求共鸣";
  return "方案测试";
}

function splitAdvisorOnlySection(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.trim() !== "---") continue;
    const candidates: string[] = [];
    for (let j = i + 1; j < lines.length && candidates.length < 2; j += 1) {
      const t = (lines[j] ?? "").trim();
      if (!t) continue;
      candidates.push(t);
    }
    const isAdvisorOnly = candidates.some((t) => t.includes("专家锦囊"));
    if (!isAdvisorOnly) continue;
    const main = lines.slice(0, i).join("\n").trim();
    const priv = lines.slice(i + 1).join("\n").trim();
    return { main, private: priv };
  }
  return { main: markdown.trim(), private: "" };
}

export default function ReportPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">解读报告</h1>
            <p className="text-sm text-zinc-600">正在加载...</p>
          </div>
        </div>
      }
    >
      <ReportPageInner />
    </Suspense>
  );
}

function ReportPageInner() {
  const { activeCase, updateCaseReportDraft } = useCaseContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const loadingParam = searchParams.get("loading") === "true";
  const [strategy, setStrategy] = useState<ReportStrategy>("professional_premium");
  const [editEnabled, setEditEnabled] = useState(false);
  const [editedMarkdown, setEditedMarkdown] = useState("");
  const [plannerName, setPlannerName] = useState("");
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [debugRawExpanded, setDebugRawExpanded] = useState(false);
  const [loadingHintIndex, setLoadingHintIndex] = useState(0);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const loadingStartedAtRef = useRef<number>(0);
  const loadingDoneRef = useRef(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  const draft = activeCase?.reportDraft ?? null;
  const scoreAccounts = useMemo(
    () => parseScoreAccountBars(draft?.clientDataJson),
    [draft?.clientDataJson],
  );

  useEffect(() => {
    const key = `ipis:plannerName:${activeCase?.id ?? "active"}`;
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (stored != null) setPlannerName(stored);
  }, [activeCase?.id]);

  useEffect(() => {
    if (!draft?.markdown) return;
    if (editEnabled) return;
    setEditedMarkdown(draft.markdown);
  }, [draft?.markdown, editEnabled]);

  useEffect(() => {
    if (!loadingParam) return;
    if (!draft) return;
    setLoadingError(null);
    loadingStartedAtRef.current = Date.now();
    loadingDoneRef.current = false;

    const timer = window.setInterval(() => {
      if (loadingDoneRef.current) return;
      const elapsed = Date.now() - loadingStartedAtRef.current;
      let progress = 8;
      let hintIndex = 0;
      if (elapsed < 20_000) {
        progress = 10 + (elapsed / 20_000) * 25;
        hintIndex = 0;
      } else if (elapsed < 70_000) {
        progress = 35 + ((elapsed - 20_000) / 50_000) * 35;
        hintIndex = 1;
      } else if (elapsed < 120_000) {
        progress = 70 + ((elapsed - 70_000) / 50_000) * 20;
        hintIndex = 2;
      } else {
        progress = 90 + Math.min((elapsed - 120_000) / 120_000, 1) * 8;
        hintIndex = 2;
      }

      setLoadingProgress(Math.max(8, Math.min(98, Math.round(progress))));
      setLoadingHintIndex(hintIndex);
    }, 200);

    return () => window.clearInterval(timer);
  }, [draft, loadingParam]);

  useEffect(() => {
    if (!loadingParam) return;
    if (!draft) return;
    if (draft.markdown.trim().length > 0) {
      router.replace("/report");
      return;
    }

    const currentDraft = draft;
    let cancelled = false;

    async function persist(next: typeof currentDraft) {
      await updateCaseReportDraft({
        strategy: next.strategy,
        clientDataJson: next.clientDataJson,
        markdown: next.markdown,
        generatedAt: Date.now(),
        job: next.job ?? null,
      });
    }

    async function startOrResume() {
      try {
        setLoadingError(null);

        let conversationId = currentDraft.job?.conversationId ?? "";
        let chatId = currentDraft.job?.chatId ?? "";

        if (!conversationId || !chatId) {
          const startRes = await fetch("/api/interpret", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ strategy: currentDraft.strategy, client_data_json: currentDraft.clientDataJson }),
          });
          if (!startRes.ok) {
            const raw = await startRes.text();
            throw new Error(raw || `HTTP ${startRes.status}`);
          }
          const started = (await startRes.json()) as { conversationId?: string; chatId?: string };
          conversationId = typeof started.conversationId === "string" ? started.conversationId : "";
          chatId = typeof started.chatId === "string" ? started.chatId : "";
          if (!conversationId || !chatId) {
            throw new Error("解读任务初始化失败：缺少 conversationId/chatId");
          }
          await persist({ ...currentDraft, markdown: "", job: { conversationId, chatId, startedAt: Date.now() } });
        }

        const deadline = Date.now() + 240_000;
        while (!cancelled && Date.now() < deadline) {
          const pollUrl = new URL("/api/interpret", window.location.origin);
          pollUrl.searchParams.set("conversation_id", conversationId);
          pollUrl.searchParams.set("chat_id", chatId);
          const pollRes = await fetch(pollUrl.toString(), { method: "GET" });
          if (pollRes.status === 202) {
            const body = (await pollRes.json()) as { retryAfterMs?: number };
            const ms = typeof body.retryAfterMs === "number" ? body.retryAfterMs : 1500;
            await new Promise((r) => window.setTimeout(r, Math.max(800, Math.min(4000, ms))));
            continue;
          }
          if (!pollRes.ok) {
            const raw = await pollRes.text();
            throw new Error(raw || `HTTP ${pollRes.status}`);
          }
          const data = (await pollRes.json()) as { report_markdown?: string };
          const markdown = typeof data.report_markdown === "string" ? data.report_markdown : "";
          await persist({ ...currentDraft, markdown, job: null });
          setEditedMarkdown(markdown);
          loadingDoneRef.current = true;
          setLoadingProgress(100);
          setLoadingHintIndex(3);
          window.setTimeout(() => router.replace("/report"), 240);
          if (!markdown.trim().length) {
            setLoadingError("专家正在构思中，请尝试重新生成");
          }
          return;
        }
        if (!cancelled) {
          setLoadingError("生成超时，请尝试重新生成");
          router.replace("/report");
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "生成失败";
        setLoadingError(msg || "生成失败");
        router.replace("/report");
      }
    }

    void startOrResume();

    return () => {
      cancelled = true;
    };
  }, [draft, loadingParam, router, updateCaseReportDraft]);

  const rendered = useMemo(() => {
    const base = (editEnabled ? editedMarkdown : draft?.markdown) ?? "";
    if (!base) return { main: "", private: "" };
    const normalizedDateMarkdown = normalizeReportTitleDate(base);
    const withoutStrategy = normalizedDateMarkdown
      .replace(/\*\*话术策略：\*\*.*(?:\n|$)/g, "")
      .replace(/^\s*话术策略：.*(?:\n|$)/gm, "")
      .trim();
    return splitAdvisorOnlySection(withoutStrategy);
  }, [draft?.markdown, editEnabled, editedMarkdown]);

  async function persistEditedMarkdown(nextMarkdown: string) {
    if (!draft) return;
    await updateCaseReportDraft({
      strategy: draft.strategy,
      clientDataJson: draft.clientDataJson,
      markdown: nextMarkdown,
      generatedAt: Date.now(),
      job: draft.job ?? null,
    });
  }

  async function handleExportPng() {
    const el = exportRef.current;
    if (!el) return;
    const { toPng } = await import("html-to-image");
    const tableElements = Array.from(el.querySelectorAll("table"));
    const tableWrappers = Array.from(
      new Set(
        tableElements
          .map((table) => table.closest("div.overflow-x-auto"))
          .filter((node): node is HTMLDivElement => node instanceof HTMLDivElement),
      ),
    );
    const wrapperSnapshots = tableWrappers.map((wrapper) => ({
      wrapper,
      className: wrapper.className,
      overflow: wrapper.style.overflow,
    }));
    const elStyleSnapshot = {
      width: el.style.width,
      minWidth: el.style.minWidth,
      maxWidth: el.style.maxWidth,
    };
    try {
      wrapperSnapshots.forEach(({ wrapper }) => {
        wrapper.classList.remove("overflow-x-auto");
        wrapper.style.overflow = "visible";
      });
      const contentWidth = Math.max(
        el.scrollWidth,
        ...tableElements.map((table) => table.scrollWidth),
      );
      el.style.width = "fit-content";
      el.style.minWidth = `${contentWidth}px`;
      el.style.maxWidth = "none";
      const dataUrl = await toPng(el, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        style: {
          width: `${contentWidth}px`,
          minWidth: `${contentWidth}px`,
          maxWidth: "none",
          backgroundColor: "#ffffff",
        },
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      const name = activeCase?.customerName?.trim() || "客户";
      a.download = `${name}-保障解读.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      wrapperSnapshots.forEach(({ wrapper, className, overflow }) => {
        wrapper.className = className;
        wrapper.style.overflow = overflow;
      });
      el.style.width = elStyleSnapshot.width;
      el.style.minWidth = elStyleSnapshot.minWidth;
      el.style.maxWidth = elStyleSnapshot.maxWidth;
    }
  }

  function downloadTextFile(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleRetry() {
    if (!draft) return;
    await updateCaseReportDraft({
      strategy: draft.strategy,
      clientDataJson: draft.clientDataJson,
      markdown: "",
      generatedAt: Date.now(),
      job: null,
    });
    setEditedMarkdown("");
    setLoadingError(null);
    router.replace("/report?loading=true");
  }

  async function handleChangeStrategy(next: ReportStrategy) {
    if (editEnabled && draft) {
      await persistEditedMarkdown(editedMarkdown);
    }
    setStrategy(next);
  }

  const loadingHints = [
    "客户画像及保单信息已发给 AI...",
    "AI 正深度解读关键信息...",
    "解读报告密锣紧鼓生成中...",
    "解读报告",
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">解读报告</h1>
        <p className="text-sm text-zinc-600">
          清晰标题 + 加粗重点的预览框架已就绪，可在此对接 Coze 的解读结果与渲染模板。
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {(
            [
              ["professional_premium", "专业溢价"],
              ["needs_resonance", "需求共鸣"],
              ["solution_test", "方案测试"],
            ] as const
          ).map(([key, label]) => {
            const active = strategy === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => void handleChangeStrategy(key)}
                className={[
                  "inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors",
                  active
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
                ].join(" ")}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {loadingParam ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="text-sm font-semibold text-zinc-900">正在生成解读报告</div>
          <div className="relative mt-4 h-10 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[#D31145] transition-[width]"
              style={{ width: `${loadingProgress}%` }}
            />
            <div
              className={[
                "absolute inset-0 flex items-center justify-center px-3 text-sm font-medium",
                loadingProgress >= 35 ? "text-white" : "text-zinc-700",
              ].join(" ")}
            >
              {loadingHints[loadingHintIndex] ?? loadingHints[0]}
            </div>
          </div>
          <div className="mt-4 text-xs text-zinc-500">
            若长时间无响应，可稍后点击“重新生成”。
          </div>
        </div>
      ) : loadingError ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
          <div className="text-sm font-semibold text-[#D31145]">生成失败</div>
          <div className="mt-2 text-sm text-rose-900/80">{loadingError}</div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRetry()}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-[#D31145] px-4 text-sm font-semibold text-white hover:bg-[#b50f3a]"
            >
              重新生成
            </button>
          </div>
        </div>
      ) : !draft?.markdown ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6">
          <div className="text-sm text-zinc-600">
            {draft
              ? "专家正在构思中，请尝试重新生成"
              : "暂无报告内容。请先在“家庭保障全景”点击“生成初步报告”。"}
          </div>
          {draft ? (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void handleRetry()}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-[#D31145] px-4 text-sm font-semibold text-white hover:bg-[#b50f3a]"
              >
                重新生成
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium text-zinc-700">报告内容</div>
            <label className="inline-flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={editEnabled}
                onChange={(e) => {
                  const next = e.target.checked;
                  if (!next && editEnabled) {
                    void persistEditedMarkdown(editedMarkdown);
                  }
                  setEditEnabled(next);
                  if (next) setEditedMarkdown(draft.markdown);
                }}
              />
              编辑报告原文
            </label>
          </div>

          {editEnabled ? (
            <textarea
              value={editedMarkdown}
              onChange={(e) => setEditedMarkdown(e.target.value)}
              className="mt-4 h-64 w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
              placeholder="在此编辑报告 Markdown 原文..."
            />
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                const content = editEnabled ? editedMarkdown : draft.markdown;
                await persistEditedMarkdown(content);
                const name = activeCase?.customerName?.trim() || "客户";
                downloadTextFile(`${name}-保障解读.txt`, content);
              }}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-[#D31145] px-4 text-sm font-semibold text-white hover:bg-[#b50f3a]"
            >
              保存并导出 txt 文件
            </button>
            <button
              type="button"
              onClick={async () => {
                const content = editEnabled ? editedMarkdown : draft.markdown;
                await persistEditedMarkdown(content);
                await handleExportPng();
              }}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
            >
              保存并生成 PNG 长图
            </button>
          </div>

          <div className="mt-4 text-sm text-zinc-700">
            <span className="font-semibold text-[#D31145]">话术策略：</span>{" "}
            {getStrategyLabel(strategy)}
          </div>

          <div ref={exportRef} className="mt-6 border-t border-zinc-200 px-[6px] pt-6">
            <MarkdownView markdown={rendered.main} scoreAccounts={scoreAccounts} />
            <div className="mt-6 text-sm text-zinc-800">
              <span className="text-zinc-700">您的专属保障规划师：</span>
              <input
                value={plannerName}
                onChange={(e) => {
                  const next = e.target.value;
                  setPlannerName(next);
                  const key = `ipis:plannerName:${activeCase?.id ?? "active"}`;
                  try {
                    window.localStorage.setItem(key, next);
                  } catch {}
                }}
                placeholder="请填入你的姓名"
                className="ml-1 inline-block w-[min(52vw,260px)] border-b border-zinc-300 bg-transparent px-1 py-0.5 text-lg font-semibold text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-500"
                style={{ fontFamily: "cursive" }}
              />
            </div>
            <div className="mt-4 text-center text-xs text-zinc-500">
              友邦保险 · 健康长久好生活
            </div>
          </div>

          {rendered.private ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="text-sm font-semibold text-[#D31145]">
                  仅顾问可见
                </div>
                <div className="text-xs text-rose-900/70">
                  不会输出到PNG长图中
                </div>
              </div>
              <div className="mt-3">
                <MarkdownView markdown={rendered.private} scoreAccounts={scoreAccounts} />
              </div>
            </div>
          ) : null}

          <details
            className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4"
            onToggle={(e) => setDebugRawExpanded((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-sm font-semibold text-zinc-800">
              Coze 传输原文（Debug）
            </summary>
            {debugRawExpanded ? (
              <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-100 p-3 text-xs leading-5 text-zinc-800">
                {draft.markdown}
              </pre>
            ) : null}
          </details>
        </div>
      )}
    </div>
  );
}
