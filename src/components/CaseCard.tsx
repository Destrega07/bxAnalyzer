"use client";

import type { CaseRecord, CaseStatus, CaseSummary } from "@/lib/db";

type Props = {
  caseId: number;
  summary: CaseSummary;
  active: boolean;
  onSelect: () => void;
  onStatusChange: (status: CaseStatus) => void;
  onViewSummary: () => void;
};

function getStatusLabel(status: CaseStatus) {
  if (status === "pending") return "待提案";
  if (status === "proposed") return "已提案";
  if (status === "closed") return "已成交";
  return "被拒绝";
}

function getStatusTone(status: CaseRecord["status"]) {
  if (status === "pending") return "border-amber-200 bg-amber-50";
  if (status === "proposed") return "border-sky-200 bg-sky-50";
  if (status === "closed") return "border-emerald-200 bg-emerald-50";
  return "border-zinc-200 bg-zinc-100";
}

function getStatusDot(status: CaseStatus) {
  if (status === "pending") return "bg-amber-500";
  if (status === "proposed") return "bg-sky-500";
  if (status === "closed") return "bg-emerald-500";
  return "bg-zinc-500";
}

function formatUpdatedAt(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export default function CaseCard({ summary, active, onSelect, onStatusChange, onViewSummary }: Props) {
  const score = Number.isFinite(summary.gapScore) ? summary.gapScore : 0;
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const ring = `conic-gradient(#3b82f6 ${pct}%, #e4e4e7 0)`;

  const name = summary.customerName?.trim().length ? summary.customerName.trim() : "未命名客户";
  const tone = getStatusTone(summary.status);
  const statusLabel = getStatusLabel(summary.status);
  const policyCount = Number.isFinite(summary.policyCount) ? summary.policyCount : 0;
  const totalPremium = (summary.totalPremium ?? "").trim();

  const statusOptions: Array<{ key: CaseStatus; label: string }> = [
    { key: "pending", label: "待提案" },
    { key: "proposed", label: "已提案" },
    { key: "closed", label: "已成交" },
    { key: "rejected", label: "被拒绝" },
  ];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        "w-full rounded-xl border p-4 text-left transition-colors",
        tone,
        active ? "ring-2 ring-zinc-900/10" : "hover:bg-white/60",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={["h-2.5 w-2.5 rounded-full", getStatusDot(summary.status)].join(" ")} />
            <div className="truncate text-sm font-semibold">{name}</div>
          </div>
          <div className="mt-1 text-xs text-zinc-600">
            有效保单: {policyCount}件 | 累计保费: {totalPremium.length ? totalPremium : "-"}
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            {statusLabel} · 最近更新：{formatUpdatedAt(summary.updatedAt)}
          </div>
        </div>

        <div className="shrink-0">
          <div className="relative h-14 w-14 rounded-full" style={{ background: ring }}>
            <div className="absolute inset-1 flex items-center justify-center rounded-full bg-white">
              <div className="text-center leading-none">
                <div className="text-xs font-semibold text-zinc-900">{pct}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">评分</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {statusOptions.map((opt) => {
          const selected = summary.status === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(opt.key);
              }}
              className={[
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                selected
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white/70 text-zinc-700 hover:bg-white",
              ].join(" ")}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewSummary();
          }}
          className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-white/70 text-sm font-semibold text-zinc-900 hover:bg-white"
        >
          查看保障全景
        </button>
      </div>
    </div>
  );
}
