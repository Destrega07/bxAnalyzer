"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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

function MarkdownView({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return (
    <div className="space-y-2">
      {lines.map((line, idx) => {
        const raw = line.trimEnd();
        if (!raw) return <div key={`sp:${idx}`} className="h-2" />;
        if (raw.trim() === "---") {
          return (
            <div
              key={`hr:${idx}`}
              className="my-4 border-t border-zinc-200"
            />
          );
        }
        const heading = raw.match(/^(#{1,6})\s*(.*)$/);
        if (heading) {
          const level = heading[1]?.length ?? 1;
          const title = heading[2] ?? "";
          if (level <= 1) {
            return (
              <h2 key={`h1:${idx}`} className="text-lg font-semibold tracking-tight text-zinc-900">
                {title}
              </h2>
            );
          }
          if (level === 2) {
            return (
              <h3 key={`h2:${idx}`} className="pt-2 text-base font-semibold text-zinc-900">
                {title}
              </h3>
            );
          }
          return (
            <h4 key={`h3:${idx}`} className="pt-2 text-sm font-semibold text-zinc-900">
              {title}
            </h4>
          );
        }
        const li = raw.match(/^-+\s+(.*)$/);
        if (li) {
          const parts = renderInlineBold(li[1]);
          return (
            <div key={`li:${idx}`} className="flex gap-2 text-sm text-zinc-800">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" />
              <div className="min-w-0">
                {parts.map((p, i) =>
                  p.type === "strong" ? (
                    <strong key={i} className="font-semibold text-[#D31145]">
                      {p.value}
                    </strong>
                  ) : (
                    <span key={i}>{p.value}</span>
                  ),
                )}
              </div>
            </div>
          );
        }
        const parts = renderInlineBold(raw);
        return (
          <p key={`p:${idx}`} className="text-sm leading-6 text-zinc-800">
            {parts.map((p, i) =>
              p.type === "strong" ? (
                <strong key={i} className="font-semibold text-[#D31145]">
                  {p.value}
                </strong>
              ) : (
                <span key={i}>{p.value}</span>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

function getStrategyLabel(strategy: ReportStrategy) {
  if (strategy === "professional_premium") return "专业溢价";
  if (strategy === "needs_resonance") return "需求共鸣";
  return "方案测试";
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
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [loadingHintIndex, setLoadingHintIndex] = useState(0);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const loadingStartedAtRef = useRef<number>(0);
  const loadingDoneRef = useRef(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  const draft = activeCase?.reportDraft ?? null;

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
    if (!base) return { main: "" };
    const label = getStrategyLabel(strategy);
    const withStrategy = base.includes("**话术策略：**")
      ? base.replace(/\*\*话术策略：\*\*.+/g, `**话术策略：** ${label}`)
      : `**话术策略：** ${label}\n\n${base}`;
    return { main: withStrategy.trim() };
  }, [draft?.markdown, editEnabled, editedMarkdown, strategy]);

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
    const dataUrl = await toPng(el, { cacheBust: true, pixelRatio: 2 });
    const a = document.createElement("a");
    a.href = dataUrl;
    const name = activeCase?.customerName?.trim() || "客户";
    a.download = `${name}-保障解读.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
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

          <div ref={exportRef} className="mt-6 border-t border-zinc-200 pt-6">
            <MarkdownView markdown={rendered.main} />
            <div className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
              您的专属保障规划师：[待自定义]
            </div>
            <div className="mt-4 text-center text-xs text-zinc-500">
              友邦保险 · 健康长久好生活
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
