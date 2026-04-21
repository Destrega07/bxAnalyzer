"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCaseContext } from "@/context/CaseContext";
import { getConfirmedPolicyRows } from "@/lib/reviewConfirmedPolicies";
import { aggregateHouseholdModel } from "@/lib/aggregator";
import { buildClientDataJson, buildReportSnapshot } from "@/lib/reportGenerator";
import { computeProtectionScoreDetails } from "@/lib/scoringEngine";
import type { ReportStrategy } from "@/lib/db";
import {
  ArrowLeft,
  FileText,
  Info,
  LayoutPanelTop,
  ShieldAlert,
} from "lucide-react";

function formatNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatCurrency(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return `￥${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function parseNumberLoose(input: string) {
  const normalized = String(input ?? "").trim().replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

function niceStep(value: number) {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs <= 0) return 1;
  return Math.pow(10, Math.max(0, Math.floor(Math.log10(abs)) - 1));
}

function niceFloor(value: number) {
  const step = niceStep(value);
  return Math.floor(value / step) * step;
}

function niceCeil(value: number) {
  const step = niceStep(value);
  return Math.ceil(value / step) * step;
}

function pickAxisBreak(values: number[]) {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length < 4) return null;

  let bestGap = 0;
  let bestIndex = -1;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }

  if (bestIndex <= 0) return null;
  const lowerMax = sorted[bestIndex - 1] ?? 0;
  const upperMin = sorted[bestIndex] ?? 0;
  if (upperMin <= 0 || upperMin <= lowerMax) return null;
  if (bestGap < Math.max(50_000, lowerMax * 2)) return null;

  return { lowerMax, upperMin };
}

function MonthlyMemoBarChart({
  data,
}: {
  data: Array<{ yearMonth: string; totalPremium: number }>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const option = useMemo(() => {
    const categories = data.map((d) => d.yearMonth);
    const values = data.map((d) => d.totalPremium);
    const axisBreak = pickAxisBreak(values);

    const common = {
      tooltip: {
        trigger: "axis" as const,
        axisPointer: { type: "shadow" as const },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params];
          const first = list[0] as { dataIndex?: number; axisValue?: string } | undefined;
          const idx = first?.dataIndex ?? -1;
          const label = first?.axisValue ?? (idx >= 0 ? categories[idx] : "");
          const raw = idx >= 0 ? values[idx] : null;
          const valueText =
            typeof raw === "number" && Number.isFinite(raw)
              ? raw.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
              : "-";
          return `${label}<br/>保费合计：${valueText}`;
        },
      },
      color: ["#3b82f6"],
      grid: [
        { left: 48, right: 16, top: 12, height: 130 },
        { left: 48, right: 16, top: 150, bottom: 36 },
      ],
      xAxis: [
        {
          type: "category" as const,
          data: categories,
          gridIndex: 0,
          axisLabel: { show: false },
          axisTick: { show: false },
          axisLine: { show: false },
        },
        {
          type: "category" as const,
          data: categories,
          gridIndex: 1,
          axisLabel: { color: "#71717a", fontSize: 10 },
          axisTick: { show: false },
          axisLine: { lineStyle: { color: "#e4e4e7" } },
        },
      ],
      yAxis: [
        {
          type: "value" as const,
          gridIndex: 0,
          axisLabel: {
            color: "#71717a",
            fontSize: 10,
            formatter: (v: unknown) =>
              Number.isFinite(Number(v))
                ? Math.round(Number(v)).toLocaleString("zh-CN")
                : "-",
          },
          splitLine: { lineStyle: { color: "#f4f4f5" } },
        },
        {
          type: "value" as const,
          gridIndex: 1,
          axisLabel: {
            color: "#71717a",
            fontSize: 10,
            formatter: (v: unknown) =>
              Number.isFinite(Number(v))
                ? Math.round(Number(v)).toLocaleString("zh-CN")
                : "-",
          },
          splitLine: { lineStyle: { color: "#f4f4f5" } },
        },
      ],
      series: [],
    };

    if (!axisBreak) {
      return {
        ...common,
        grid: [{ left: 48, right: 16, top: 12, bottom: 36 }],
        xAxis: [
          {
            type: "category" as const,
            data: categories,
            axisLabel: { color: "#71717a", fontSize: 10 },
            axisTick: { show: false },
            axisLine: { lineStyle: { color: "#e4e4e7" } },
          },
        ],
        yAxis: [
          {
            type: "value" as const,
            axisLabel: { color: "#71717a", fontSize: 10 },
            splitLine: { lineStyle: { color: "#f4f4f5" } },
          },
        ],
        series: [
          {
            type: "bar" as const,
            data: values,
            barMaxWidth: 22,
            itemStyle: { borderRadius: [6, 6, 0, 0] },
          },
        ],
      };
    }

    const lowerBreak = niceCeil(axisBreak.lowerMax);
    const upperBreak = niceFloor(axisBreak.upperMin);
    const maxTopPart = values.reduce((acc, v) => {
      if (!Number.isFinite(v) || v <= upperBreak) return acc;
      return Math.max(acc, v - upperBreak);
    }, 0);
    const topRange = Math.max(1, niceCeil(maxTopPart * 3));
    const topMax = upperBreak + topRange;

    const bottomData = values.map((v) => {
      const value = Math.min(v, lowerBreak);
      const crossesBreak = v > upperBreak;
      const shouldRoundTop = value > 0 && !crossesBreak;
      return {
        value,
        itemStyle: {
          borderRadius: shouldRoundTop ? ([6, 6, 0, 0] as const) : ([0, 0, 0, 0] as const),
        },
      };
    });
    const topOffset = values.map((v) => (v > upperBreak ? upperBreak : "-"));
    const topPart = values.map((v) => (v > upperBreak ? v - upperBreak : "-"));

    return {
      ...common,
      yAxis: [
        {
          ...(common.yAxis[0] as object),
          min: upperBreak,
          max: topMax,
        },
        {
          ...(common.yAxis[1] as object),
          min: 0,
          max: lowerBreak,
        },
      ],
      series: [
        {
          type: "bar" as const,
          data: topOffset,
          xAxisIndex: 0,
          yAxisIndex: 0,
          stack: "top",
          silent: true,
          barMaxWidth: 22,
          itemStyle: { color: "transparent" },
          tooltip: { show: false },
        },
        {
          type: "bar" as const,
          data: topPart,
          xAxisIndex: 0,
          yAxisIndex: 0,
          stack: "top",
          barMaxWidth: 22,
          itemStyle: { borderRadius: [6, 6, 0, 0] },
        },
        {
          type: "bar" as const,
          data: bottomData,
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 22,
          itemStyle: { borderRadius: [0, 0, 0, 0] },
        },
      ],
      graphic: [
        {
          type: "group",
          left: 40,
          top: 146,
          children: [
            {
              type: "line",
              shape: { x1: 0, y1: 0, x2: 10, y2: 2 },
              style: { stroke: "#a1a1aa", lineWidth: 2 },
            },
            {
              type: "line",
              shape: { x1: 0, y1: 2, x2: 10, y2: 4 },
              style: { stroke: "#a1a1aa", lineWidth: 2 },
            },
          ],
        },
        {
          type: "group",
          right: 20,
          top: 146,
          children: [
            {
              type: "line",
              shape: { x1: 0, y1: 0, x2: 10, y2: 2 },
              style: { stroke: "#a1a1aa", lineWidth: 2 },
            },
            {
              type: "line",
              shape: { x1: 0, y1: 2, x2: 10, y2: 4 },
              style: { stroke: "#a1a1aa", lineWidth: 2 },
            },
          ],
        },
      ],
    };
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    let chart: { dispose: () => void; resize: () => void; setOption: (o: unknown) => void } | null =
      null;
    let ro: ResizeObserver | null = null;

    async function init() {
      const el = containerRef.current;
      if (!el) return;
      const echarts = await import("echarts");
      if (cancelled) return;
      chart = echarts.init(el);
      chart.setOption(option);
      ro = new ResizeObserver(() => chart?.resize());
      ro.observe(el);
    }

    init();

    return () => {
      cancelled = true;
      ro?.disconnect();
      chart?.dispose();
    };
  }, [option]);

  return <div ref={containerRef} className="h-[320px] w-full" />;
}

type AccountKey = "health" | "life" | "wealth";

function getAccountLabel(account: AccountKey) {
  if (account === "health") return "健康账户";
  if (account === "life") return "生命账户";
  return "财富账户";
}

const overviewCardId = "overview:stats";

const overviewKeyGroup1 = [
  "有效保单件数",
  "作为投保人和被保人",
  "仅作为被保人",
  "仅作为投保人",
] as const;

const overviewKeyGroup2 = [
  "累计已交保费",
  "现金价值",
  "累计红利",
  "账户价值",
] as const;

const monthlyMemoCardId = "memo:monthlyPremiums";

export default function SummaryPage() {
  const { state, updateCaseReportDraft, updateCaseScore } = useCaseContext();
  const router = useRouter();
  const [hidePending, setHidePending] = useState(false);
  const [drawer, setDrawer] = useState<{ insuredName: string; account: AccountKey } | null>(
    null,
  );
  const [tooltipKey, setTooltipKey] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [relayoutLoading, setRelayoutLoading] = useState(false);
  const [expandedMembers, setExpandedMembers] = useState<Record<string, boolean>>({});
  const [debugDialog, setDebugDialog] = useState<
    null | { jsonText: string; strategy: ReportStrategy; clientDataJson: unknown }
  >(null);
  const [debugCopied, setDebugCopied] = useState(false);
  const [debugForceEnabled, setDebugForceEnabled] = useState(false);
  const debugClickRef = useRef<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });

  const confirmedRows = useMemo(() => {
    return getConfirmedPolicyRows(state.parsed, state.cardMeta);
  }, [state.cardMeta, state.parsed]);

  const summary = useMemo(() => {
    return aggregateHouseholdModel(
      confirmedRows.map((r) => r.row),
      state.parsed,
    );
  }, [confirmedRows, state.parsed]);

  const members = useMemo(() => {
    if (!hidePending) return summary.members;
    return summary.members.filter((m) => m.status !== "pending");
  }, [hidePending, summary.members]);

  const scorePercentByMember = useMemo(() => {
    const allConfirmedPolicies = confirmedRows.map((r) => r.row);
    const findInsured = (row: Record<string, string>) =>
      String(
        row["被保人"] ??
          row["被保险人"] ??
          row["被保人姓名"] ??
          row["被保人名称"] ??
          row["客户姓名"] ??
          "",
      ).trim();

    const byMember = new Map<string, { health: number; life: number; wealth: number }>();
    members.forEach((m) => {
      const memberPolicies = allConfirmedPolicies.filter((row) => findInsured(row) === m.insuredName);
      if (memberPolicies.length <= 0) {
        byMember.set(m.insuredName, { health: 0, life: 0, wealth: 0 });
        return;
      }
      const details = computeProtectionScoreDetails({
        persona: state.persona,
        parsed: state.parsed,
        confirmedPolicies: memberPolicies,
      });
      const accountPercent = (account: "健康账户" | "生命账户" | "财富账户") => {
        const row = details?.accounts.find((a) => a.account === account);
        if (!row || row.maxScore <= 0) return 0;
        return Math.max(0, Math.min(100, Math.round((row.score / row.maxScore) * 100)));
      };
      byMember.set(m.insuredName, {
        health: accountPercent("健康账户"),
        life: accountPercent("生命账户"),
        wealth: accountPercent("财富账户"),
      });
    });
    return byMember;
  }, [confirmedRows, members, state.parsed, state.persona]);

  const overviewMeta = state.cardMeta[overviewCardId];
  const overviewFields = overviewMeta?.overviewFields ?? {};
  const overviewConfirmed = Boolean(overviewMeta?.confirmed);
  const monthlyPremiumRows = state.cardMeta[monthlyMemoCardId]?.monthlyPremiums;
  const monthlyChartData = useMemo(() => {
    return (monthlyPremiumRows ?? [])
      .map((r) => ({
        yearMonth: r.yearMonth,
        totalPremium: parseNumberLoose(r.totalPremium),
      }))
      .filter((r) => r.yearMonth.trim().length > 0);
  }, [monthlyPremiumRows]);

  function openDrawer(insuredName: string, account: AccountKey) {
    setDrawer({ insuredName, account });
    setTooltipKey(null);
  }

  function closeDrawer() {
    setDrawer(null);
  }

  async function runInterpretAndGo(strategy: ReportStrategy, clientDataJson: unknown) {
    await updateCaseReportDraft({
      strategy,
      clientDataJson,
      markdown: "",
      generatedAt: Date.now(),
      job: null,
    });
    router.push("/report?loading=true");
  }

  async function handleGenerateInitialReport(strategy: ReportStrategy = "professional_premium") {
    if (reportLoading) return;
    setReportLoading(true);
    try {
      const confirmedPolicies = confirmedRows.map((r) => r.row);
      const details = computeProtectionScoreDetails({
        persona: state.persona,
        parsed: state.parsed,
        confirmedPolicies,
      });
      if (details) {
        await updateCaseScore(details.score, details.ratingLabel);
      }
      const snapshot = buildReportSnapshot({
        persona: state.persona,
        ratingLabel: details?.ratingLabel ?? null,
        totalScore: details?.score ?? 0,
        scoringAccounts: details?.accounts ?? [
          { account: "健康账户", score: 0, maxScore: 0, missingScore: 0, gaps: [] },
          { account: "生命账户", score: 0, maxScore: 0, missingScore: 0, gaps: [] },
          { account: "财富账户", score: 0, maxScore: 0, missingScore: 0, gaps: [] },
        ],
        scoringItems: details?.items ?? [],
        confirmedPolicyRows: confirmedRows.map((r) => ({ id: r.id, row: r.row })),
        monthlyPremiums: state.cardMeta["memo:monthlyPremiums"]?.monthlyPremiums ?? [],
      });
      const clientDataJson = buildClientDataJson({ strategy, snapshot });

      const shouldDebug = debugForceEnabled;
      if (shouldDebug) {
        setDebugCopied(false);
        setDebugDialog({
          jsonText: JSON.stringify(clientDataJson, null, 2),
          strategy,
          clientDataJson,
        });
        return;
      }

      await runInterpretAndGo(strategy, clientDataJson);
    } catch (err) {
      console.error("[summary] interpret failed", err);
    } finally {
      setReportLoading(false);
    }
  }

  function startMockRelayout() {
    if (relayoutLoading) return;
    setRelayoutLoading(true);
    window.setTimeout(() => setRelayoutLoading(false), 1200);
  }

  const drawerMember = drawer
    ? members.find((m) => m.insuredName === drawer.insuredName) ?? null
    : null;

  const drawerPolicies =
    drawerMember && drawer
      ? drawer.account === "health"
        ? [
            ...drawerMember.accounts.healthCritical.policies,
            ...drawerMember.accounts.healthMedical.policies,
          ]
        : drawer.account === "life"
          ? drawerMember.accounts.lifeDeath.policies
          : drawerMember.accounts.wealth.policies
      : [];

  return (

    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">家庭保障全景</h1>
          <div className="text-xs text-zinc-500">
            汇总基于“已确认保单”，并按被保人聚合至三大保障账户。
          </div>
        </div>
        <Link
          href="/review"
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          <ArrowLeft className="h-4 w-4" />
          校对工作台
        </Link>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">显示控制</div>
          <div className="mt-1 text-xs text-zinc-500">
            隐藏仅在投保人视图出现、待补充明细的家庭成员
          </div>
        </div>
        <button
          type="button"
          aria-pressed={hidePending}
          onClick={() => setHidePending((v) => !v)}
          className="flex shrink-0 items-center gap-2"
        >
          <span className="text-xs font-medium text-zinc-700">
            隐藏待完善成员
          </span>
          <span
            className={[
              "relative inline-flex h-6 w-10 items-center rounded-full border transition-colors",
              hidePending
                ? "border-emerald-500 bg-emerald-500"
                : "border-zinc-300 bg-zinc-200",
            ].join(" ")}
          >
            <span
              className={[
                "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                hidePending ? "translate-x-[18px]" : "translate-x-0.5",
              ].join(" ")}
            />
          </span>
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-end justify-between gap-3">
          <div className="text-sm font-medium">家庭保障总览</div>
          <div className="text-xs text-zinc-500">
            {overviewConfirmed ? "已确认" : "未确认"} ·{" "}
            <span
              className="cursor-pointer select-none"
              onClick={() => {
                const now = Date.now();
                const lastAt = debugClickRef.current.lastAt;
                const nextCount = now - lastAt <= 900 ? debugClickRef.current.count + 1 : 1;
                debugClickRef.current = { count: nextCount, lastAt: now };
                if (nextCount >= 5) {
                  setDebugForceEnabled(true);
                  debugClickRef.current = { count: 0, lastAt: 0 };
                }
              }}
            >
              {overviewFields["客户姓名"] || summary.customerName || "主客户"}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <div className="grid grid-cols-2 gap-3">
              {overviewKeyGroup1.map((k) => (
                <div key={k} className="min-w-0">
                  <div className="text-[11px] text-zinc-500">{k}</div>
                  <div className="mt-1 truncate text-sm font-semibold tabular-nums text-zinc-900">
                    {overviewFields[k] ?? "-"}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <div className="grid grid-cols-2 gap-3">
              {overviewKeyGroup2.map((k) => (
                <div key={k} className="min-w-0">
                  <div className="text-[11px] text-zinc-500">{k}</div>
                  <div className="mt-1 truncate text-sm font-semibold tabular-nums text-zinc-900">
                    {overviewFields[k] ?? "-"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {confirmedRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
          暂无已确认保单。请先返回{" "}
          <Link href="/review" className="font-medium text-zinc-900 underline">
            校对工作台
          </Link>{" "}
          勾选“确认无误”后再生成汇总。
        </div>
      ) : (
        <div className="grid gap-3">
          {members.map((m) => {
            const missingCritical = m.accounts.healthCritical.mainAmount <= 0;
            const hasLinked =
              m.accounts.healthCritical.policies.some((p) => p.isLinked) ||
              m.accounts.lifeDeath.policies.some((p) => p.isLinked);
            const scorePercent = scorePercentByMember.get(m.insuredName) ?? {
              health: 0,
              life: 0,
              wealth: 0,
            };
            const isSelf = m.role === "self";

            const cardTone =
              m.status === "pending"
                ? "border-amber-200 bg-amber-50"
                : "border-zinc-200 bg-white";

            const roleLabel = m.role === "self" ? "本人" : "家人";
            const expanded = Boolean(expandedMembers[m.insuredName]);
            const hasGroupPolicy = [
              ...m.accounts.healthCritical.policies,
              ...m.accounts.healthMedical.policies,
              ...m.accounts.lifeDeath.policies,
              ...m.accounts.wealth.policies,
            ].some((p) => p.policyName.includes("团体"));

            return (
              <div
                key={m.insuredName}
                className={["rounded-xl border p-4", cardTone].join(" ")}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold">{m.insuredName}</div>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                        {roleLabel}
                      </span>
                      {m.status === "pending" ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          待完善
                        </span>
                      ) : null}
                      {missingCritical ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          保障缺失
                        </span>
                      ) : null}
                    </div>
                    {m.status === "pending" ? (
                      <div className="mt-1 text-xs text-amber-900/80">
                        数据不全，共 {m.policyCount} 件保单待补充
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-zinc-500">
                        已确认 {m.policyCount} 份保单（含附加险）
                        {hasGroupPolicy ? (
                          <span className="ml-2 font-medium text-rose-600">
                            团体险额度待查
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedMembers((prev) => ({
                          ...prev,
                          [m.insuredName]: !Boolean(prev[m.insuredName]),
                        }))
                      }
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      {expanded ? "收起" : "展开"}
                    </button>
                    {hasLinked ? (
                      <button
                        type="button"
                        onClick={() =>
                          setTooltipKey((prev) =>
                            prev === `linked:${m.insuredName}` ? null : `linked:${m.insuredName}`,
                          )
                        }
                        className="relative inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        已去重
                        <Info className="h-3.5 w-3.5" />
                        {tooltipKey === `linked:${m.insuredName}` ? (
                          <div className="absolute right-0 top-9 z-20 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-left text-xs text-zinc-600 shadow-lg">
                            注：该保单的身故保障与重大疾病保障共用保额，理赔其一后另一项等额减少。
                          </div>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 grid gap-3">
                  <button
                    type="button"
                    onClick={() => openDrawer(m.insuredName, "health")}
                    className="rounded-xl border border-zinc-200 bg-white p-3 text-left transition-colors hover:bg-zinc-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-xs font-medium text-zinc-700">
                        健康账户
                      </div>
                      <div className="text-xs text-zinc-500">点击查看明细</div>
                    </div>
                    <div className="mt-2 space-y-3">
                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-medium text-zinc-700">
                            重疾
                          </div>
                          <div className="text-sm font-semibold tabular-nums">
                            {isSelf
                              ? `${scorePercent.health}% | ${formatCurrency(m.accounts.healthCritical.mainAmount)}`
                              : formatCurrency(m.accounts.healthCritical.mainAmount)}
                          </div>
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-500">
                          含中症/轻症：{formatNumber(m.accounts.healthCritical.middleAmount)} /{" "}
                          {formatNumber(m.accounts.healthCritical.lightAmount)}
                        </div>
                        {isSelf ? (
                          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                            <div
                              className="h-full rounded-full bg-emerald-500 transition-[width]"
                              style={{
                                width: `${scorePercent.health}%`,
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-medium text-zinc-700">
                            医疗
                          </div>
                          <div className="text-sm font-semibold tabular-nums">
                            {isSelf
                              ? `${scorePercent.health}% | ${formatCurrency(m.accounts.healthMedical.annualLimit)}`
                              : formatCurrency(m.accounts.healthMedical.annualLimit)}
                          </div>
                        </div>
                        {isSelf ? (
                          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                            <div
                              className="h-full rounded-full bg-sky-500 transition-[width]"
                              style={{
                                width: `${scorePercent.health}%`,
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => openDrawer(m.insuredName, "life")}
                    className="rounded-xl border border-zinc-200 bg-white p-3 text-left transition-colors hover:bg-zinc-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-xs font-medium text-zinc-700">
                        生命账户（身故）
                      </div>
                      <div className="flex items-center gap-2">
                        {m.accounts.lifeDeath.policies.some((p) => p.isLinked) ? (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                            已去重
                          </span>
                        ) : null}
                        <div className="text-sm font-semibold tabular-nums">
                          {isSelf
                            ? `${scorePercent.life}% | ${formatCurrency(m.accounts.lifeDeath.amount)}`
                            : formatCurrency(m.accounts.lifeDeath.amount)}
                        </div>
                      </div>
                    </div>
                    {isSelf ? (
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                        <div
                          className="h-full rounded-full bg-indigo-500 transition-[width]"
                          style={{
                            width: `${scorePercent.life}%`,
                          }}
                        />
                      </div>
                    ) : null}
                    {expanded &&
                    m.status === "active" &&
                    m.accounts.lifeDeath.level2Details.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        <div className="text-[11px] font-medium text-zinc-700">
                          二级保障明细
                        </div>
                        <div className="space-y-1">
                          {m.accounts.lifeDeath.level2Details.map((d) => (
                            <div
                              key={d.name}
                              className="flex items-center justify-between gap-3 text-[11px] text-zinc-600"
                            >
                              <div className="min-w-0 truncate">{d.name}</div>
                              <div className="shrink-0 tabular-nums">
                                {formatNumber(d.amount)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </button>

                  <button
                    type="button"
                    onClick={() => openDrawer(m.insuredName, "wealth")}
                    className="rounded-xl border border-zinc-200 bg-white p-3 text-left transition-colors hover:bg-zinc-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-xs font-medium text-zinc-700">
                        财富账户（已交保费）
                      </div>
                      <div className="text-sm font-semibold tabular-nums">
                        {isSelf
                          ? `${scorePercent.wealth}% | ${formatCurrency(m.accounts.wealth.paidPremium)}`
                          : formatCurrency(m.accounts.wealth.paidPremium)}
                      </div>
                    </div>
                    {isSelf ? (
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                        <div
                          className="h-full rounded-full bg-fuchsia-500 transition-[width]"
                          style={{
                            width: `${scorePercent.wealth}%`,
                          }}
                        />
                      </div>
                    ) : null}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">月度交费备忘录</div>
            <div className="text-xs text-zinc-500">断轴柱状图（以校对后的数据为准）</div>
          </div>
          <div className="text-xs text-zinc-500">单位：元</div>
        </div>

        {monthlyChartData.length > 0 ? (
          <div className="mt-4">
            <MonthlyMemoBarChart data={monthlyChartData} />
          </div>
        ) : (
          <div className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
            暂无数据。请先在校对工作台解析并补充“月度交费备忘录”。
          </div>
        )}
      </div>

      <div className="grid gap-2 pt-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => handleGenerateInitialReport("professional_premium")}
          disabled={reportLoading}
          className={[
            "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold",
            reportLoading
              ? "cursor-wait bg-zinc-200 text-zinc-600"
              : "bg-[#D31145] text-white hover:bg-[#b50f3a]",
          ].join(" ")}
        >
          <FileText className="h-4 w-4" />
          {reportLoading ? "生成中…" : "生成初步报告"}
        </button>
        <button
          type="button"
          onClick={startMockRelayout}
          disabled={relayoutLoading}
          className={[
            "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold",
            relayoutLoading
              ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
              : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
          ].join(" ")}
        >
          <LayoutPanelTop className="h-4 w-4" />
          {relayoutLoading ? "排版中…" : "重新排版"}
        </button>
      </div>

      <div
        className={[
          "fixed inset-0 z-50",
          drawer ? "pointer-events-auto" : "pointer-events-none",
        ].join(" ")}
        aria-hidden={!drawer}
      >
        <div
          onClick={closeDrawer}
          className={[
            "absolute inset-0 bg-black/30 transition-opacity",
            drawer ? "opacity-100" : "opacity-0",
          ].join(" ")}
        />
        <div
          className={[
            "absolute bottom-0 left-0 right-0 mx-auto w-full max-w-5xl transform transition-transform",
            drawer ? "translate-y-0" : "translate-y-full",
          ].join(" ")}
        >
          <div className="rounded-t-2xl border border-zinc-200 bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {drawerMember?.insuredName ?? "-"} ·{" "}
                  {drawer ? getAccountLabel(drawer.account) : "-"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  二级保障明细 / 三级保障（本人）/ 保单来源
                </div>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
              >
                关闭
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto px-4 py-4">
              {!drawerMember || !drawer ? (
                <div className="text-sm text-zinc-600">暂无数据</div>
              ) : (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">二级保障明细</div>
                    {drawer.account === "health" ? (
                      drawerMember.status === "pending" ? (
                        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900/80">
                          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                          该成员当前仅有投保人视图数据，二级/三级保障明细待补充。
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <div className="text-sm font-medium text-zinc-800">
                              重疾
                            </div>
                            {drawerMember.accounts.healthCritical.level2Details.length > 0 ? (
                              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
                                {drawerMember.accounts.healthCritical.level2Details.map((item) => (
                                  <div
                                    key={`critical:${item.name}`}
                                    className="flex items-center justify-between gap-3 px-4 py-3"
                                  >
                                    <div className="min-w-0 truncate text-sm text-zinc-700">
                                      {item.name}
                                    </div>
                                    <div className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">
                                      {formatNumber(item.amount)}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-zinc-600">暂无重疾二级明细</div>
                            )}
                          </div>

                          <div className="space-y-2">
                            <div className="text-sm font-medium text-zinc-800">
                              医疗
                            </div>
                            {drawerMember.accounts.healthMedical.level2Details.length > 0 ? (
                              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
                                {drawerMember.accounts.healthMedical.level2Details.map((item) => (
                                  <div
                                    key={`medical:${item.name}`}
                                    className="flex items-center justify-between gap-3 px-4 py-3"
                                  >
                                    <div className="min-w-0 truncate text-sm text-zinc-700">
                                      {item.name}
                                    </div>
                                    <div className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">
                                      {formatNumber(item.amount)}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-zinc-600">暂无医疗二级明细</div>
                            )}
                          </div>
                        </div>
                      )
                    ) : drawer.account === "wealth" ? (
                      <div className="text-sm text-zinc-600">
                        财富账户以保单维度归集“累计已交保费”，不展示二级保障表。
                      </div>
                    ) : drawerMember.status === "pending" ? (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900/80">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        该成员当前仅有投保人视图数据，二级/三级保障明细待补充。
                      </div>
                    ) : drawerMember.accounts.lifeDeath.level2Details.length > 0 ? (
                      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
                        {drawerMember.accounts.lifeDeath.level2Details.map((item) => (
                          <div
                            key={item.name}
                            className="flex items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0 truncate text-sm text-zinc-700">
                              {item.name}
                            </div>
                            <div className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">
                              {formatNumber(item.amount)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-zinc-600">暂无二级保障明细</div>
                    )}
                  </div>

                  {drawer.account === "life" && drawerMember.role === "self" ? (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">三级保障（精读）</div>
                      {drawerMember.accounts.lifeDeath.level3Details.length > 0 ? (
                        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
                          {drawerMember.accounts.lifeDeath.level3Details.map((item) => (
                            <div
                              key={item.name}
                              className="flex items-center justify-between gap-3 px-4 py-3"
                            >
                              <div className="min-w-0 truncate text-sm text-zinc-700">
                                {item.name}
                              </div>
                              <div className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">
                                {formatNumber(item.amount)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-zinc-600">暂无三级保障明细</div>
                      )}
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <div className="text-sm font-medium">保单来源</div>
                    {drawerPolicies.length > 0 ? (
                        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
                          {drawerPolicies.map((p, idx) => (
                            <div key={`${p.policyName}:${idx}`} className="px-4 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-zinc-900">
                                    {p.policyName}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                                    {p.reportSource ? (
                                      <span>来源：{p.reportSource}</span>
                                    ) : null}
                                    {typeof p.amount === "number" && p.amount > 0 ? (
                                      <span>保额：{formatNumber(p.amount)}</span>
                                    ) : null}
                                    {typeof p.paidPremium === "number" && p.paidPremium > 0 ? (
                                      <span>已交：{formatNumber(p.paidPremium)}</span>
                                    ) : null}
                                  </div>
                                </div>
                                {p.isLinked ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setTooltipKey((prev) =>
                                        prev === `policy:${drawerMember.insuredName}:${drawer.account}:${idx}`
                                          ? null
                                          : `policy:${drawerMember.insuredName}:${drawer.account}:${idx}`,
                                      )
                                    }
                                    className="relative inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-700"
                                  >
                                    已去重
                                    <Info className="h-3.5 w-3.5" />
                                    {tooltipKey ===
                                    `policy:${drawerMember.insuredName}:${drawer.account}:${idx}` ? (
                                      <div className="absolute right-0 top-8 z-20 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-left text-xs text-zinc-600 shadow-lg">
                                        {p.linkReason ??
                                          "注：该保单的身故保障与重大疾病保障共用保额，理赔其一后另一项等额减少。"}
                                      </div>
                                    ) : null}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                    ) : (
                      <div className="text-sm text-zinc-600">暂无保单来源</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {debugDialog ? (
        <div className="fixed inset-0 z-[120] pointer-events-auto">
          <div
            onClick={() => setDebugDialog(null)}
            className="absolute inset-0 bg-black/30"
          />
          <div className="absolute left-1/2 top-1/2 w-[min(92vw,920px)] -translate-x-1/2 -translate-y-1/2">
            <div className="rounded-2xl border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">
                    Debug：client_data_json（发给 Coze）
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    可一键复制到 Coze 平台做离线测试
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const text = debugDialog.jsonText;
                      if (!text) return;
                      try {
                        await navigator.clipboard.writeText(text);
                        setDebugCopied(true);
                        window.setTimeout(() => setDebugCopied(false), 1200);
                      } catch {
                        console.log(text);
                      }
                    }}
                    className="inline-flex h-9 items-center justify-center rounded-lg bg-[#D31145] px-3 text-sm font-medium text-white hover:bg-[#b50f3a]"
                  >
                    {debugCopied ? "已复制" : "一键复制"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDebugForceEnabled(false);
                      setDebugDialog(null);
                      setDebugCopied(false);
                      debugClickRef.current = { count: 0, lastAt: 0 };
                    }}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                  >
                    关闭并重置唤醒
                  </button>
                  <button
                    type="button"
                    onClick={() => setDebugDialog(null)}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                  >
                    关闭
                  </button>
                </div>
              </div>
              <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
                <pre className="whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-800">
                  {debugDialog.jsonText}
                </pre>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-4">
                <button
                  type="button"
                  onClick={async () => {
                    setDebugDialog(null);
                    await runInterpretAndGo(debugDialog.strategy, debugDialog.clientDataJson);
                  }}
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-[#D31145] px-4 text-sm font-semibold text-white hover:bg-[#b50f3a]"
                >
                  确认并查看报告
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
