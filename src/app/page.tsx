"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, Search, Upload } from "lucide-react";
import CaseCard from "@/components/CaseCard";
import { useCaseContext } from "@/context/CaseContext";
import type { CaseRecord, CaseStatus } from "@/lib/db";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBackup(records: CaseRecord[]) {
  const json = JSON.stringify({ version: 1, exportedAt: Date.now(), records });
  const bytes = new TextEncoder().encode(json);
  const base64 = bytesToBase64(bytes);
  return `ipis_bk_v1.${base64}`;
}

function decodeBackup(payload: string): CaseRecord[] {
  const trimmed = payload.trim();
  const base64 = trimmed.startsWith("ipis_bk_v1.") ? trimmed.slice("ipis_bk_v1.".length) : trimmed;
  const bytes = base64ToBytes(base64);
  const json = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(json) as { records?: unknown };
  if (!parsed || !Array.isArray(parsed.records)) return [];
  return parsed.records as CaseRecord[];
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type SortKey = "updatedAtDesc" | "nameAsc";
type StatusFilterKey = "all" | CaseStatus;

export default function Home() {
  const router = useRouter();
  const {
    caseSummaries,
    activeCaseId,
    setActiveCaseId,
    createNewCase,
    updateCaseStatus,
    exportAllCases,
    importCases,
  } = useCaseContext();
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updatedAtDesc");
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("all");
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<null | "export" | "import">(null);

  const filtered = useMemo(() => {
    const keyword = search.trim();
    const nameFiltered = keyword.length
      ? caseSummaries.filter((c) => (c.customerName ?? "").includes(keyword))
      : caseSummaries.slice();
    const rows =
      statusFilter === "all"
        ? nameFiltered
        : nameFiltered.filter((c) => c.status === statusFilter);

    if (sortKey === "updatedAtDesc") {
      return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return rows.sort((a, b) => {
      const an = (a.customerName ?? "").trim();
      const bn = (b.customerName ?? "").trim();
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return an.localeCompare(bn, "zh-CN", { sensitivity: "base" });
    });
  }, [caseSummaries, search, sortKey, statusFilter]);

  async function handleExport() {
    try {
      setBusy("export");
      const records = await exportAllCases();
      const encoded = encodeBackup(records);
      const filename = `ipis_backup_${new Date().toISOString().slice(0, 10)}.json`;
      downloadText(filename, encoded);
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFile(file: File) {
    const text = await file.text();
    const records = decodeBackup(text);
    if (records.length === 0) return;

    const overwrite = window.confirm("是否覆盖本地案卷仓？\n确定：覆盖\n取消：合并");
    await importCases(records, overwrite ? "overwrite" : "merge");
  }

  function handleImport() {
    importInputRef.current?.click();
  }

  async function handleStartNewParse() {
    await createNewCase();
    router.push("/review");
  }

  function handleViewSummary(caseId: number) {
    setActiveCaseId(caseId);
    router.push("/summary");
  }

  const statusOptions: Array<{ key: StatusFilterKey; label: string }> = [
    { key: "all", label: "全部" },
    { key: "pending", label: "待提案" },
    { key: "proposed", label: "已提案" },
    { key: "closed", label: "已成交" },
    { key: "rejected", label: "被拒绝" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">案卷管理工作台</h1>
          <p className="text-sm text-zinc-600">管理客户案卷、快速切换状态、备份与恢复。</p>
        </div>
        <button
          type="button"
          onClick={handleStartNewParse}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          <Plus className="h-4 w-4" />
          开始新解析
        </button>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="按客户姓名搜索..."
                className="h-10 w-full rounded-xl border border-zinc-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-zinc-400"
              />
            </div>

            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
            >
              <option value="updatedAtDesc">最近更新</option>
              <option value="nameAsc">姓名首字母</option>
            </select>

            <button
              type="button"
              onClick={handleExport}
              disabled={busy === "export"}
              className={[
                "inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold",
                busy === "export"
                  ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
                  : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
              ].join(" ")}
            >
              <Download className="h-4 w-4" />
              导出备份
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={busy === "import"}
              className={[
                "inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold",
                busy === "import"
                  ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
                  : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
              ].join(" ")}
            >
              <Upload className="h-4 w-4" />
              导入恢复
            </button>

            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  setBusy("import");
                  await handleImportFile(file);
                } finally {
                  setBusy(null);
                  e.target.value = "";
                }
              }}
            />
          </div>

          <div className="-mx-1 overflow-x-auto px-1">
            <div className="flex w-max gap-2">
              {statusOptions.map((opt) => {
                const active = statusFilter === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setStatusFilter(opt.key)}
                    className={[
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                      active
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
                    ].join(" ")}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((c) => {
            if (c.id == null) return null;
            return (
              <CaseCard
                key={c.id}
                caseId={c.id}
                summary={c}
                active={activeCaseId === c.id}
                onSelect={() => setActiveCaseId(c.id ?? null)}
                onStatusChange={(status) => updateCaseStatus(c.id ?? 0, status)}
                onViewSummary={() => handleViewSummary(c.id ?? 0)}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
          暂无案卷。点击“开始新解析”创建一个新的客户案卷。
        </div>
      )}
    </div>
  );
}
