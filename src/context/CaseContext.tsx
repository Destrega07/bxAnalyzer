"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type CaseRecord, type CaseSummary, type CasePolicyData, type CardMeta } from "@/lib/db";
import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";
import { getConfirmedPolicyRows } from "@/lib/reviewConfirmedPolicies";
import { aggregateHouseholdModel, type HouseholdModel } from "@/lib/aggregator";

export type ReviewDataState = {
  rawMarkdown: string;
  parsed: ParsedMarkdownTables | null;
  updatedAt: number | null;
  cardMeta: Record<string, CardMeta>;
};

const overviewCardId = "overview:stats";

const defaultReviewState: ReviewDataState = {
  rawMarkdown: "",
  parsed: null,
  updatedAt: null,
  cardMeta: {},
};

type CaseContextValue = {
  caseSummaries: CaseSummary[];
  activeCaseId: number | null;
  setActiveCaseId: (id: number | null) => void;
  activeCase: CaseRecord | null;
  state: ReviewDataState;
  setState: Dispatch<SetStateAction<ReviewDataState>>;
  clear: () => void;
  createNewCase: () => Promise<number>;
  updateCaseStatus: (id: number, status: CaseRecord["status"]) => Promise<void>;
  exportAllCases: () => Promise<CaseRecord[]>;
  importCases: (records: CaseRecord[], mode: "merge" | "overwrite") => Promise<void>;
};

const activeCaseStorageKey = "ipis.activeCaseId.v1";

const CaseContext = createContext<CaseContextValue | null>(null);

function toReviewState(record: CaseRecord | null): ReviewDataState {
  if (!record) return defaultReviewState;
  const policyData = record.policyData;
  return {
    rawMarkdown: record.rawMarkdown ?? "",
    parsed: policyData?.parsed ?? null,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
    cardMeta: policyData?.cardMeta ?? {},
  };
}

function toPolicyData(state: ReviewDataState): CasePolicyData {
  return {
    parsed: state.parsed ?? null,
    cardMeta: state.cardMeta ?? {},
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function computeGapScore(summary: HouseholdModel | null) {
  if (!summary) return 0;
  const self = summary.members.find((m) => m.role === "self") ?? summary.members[0];
  if (!self) return 0;

  let score = 100;
  if (self.accounts.healthCritical.mainAmount < 500_000) score -= 30;
  if (self.accounts.healthMedical.annualLimit <= 0) score -= 30;
  if (self.accounts.lifeDeath.amount <= 0) score -= 10;
  return clamp(score, 0, 100);
}

function parseIntLoose(input: string) {
  const normalized = String(input ?? "").replace(/[^\d]/g, "");
  const value = Number.parseInt(normalized, 10);
  return Number.isFinite(value) ? value : 0;
}

function formatWanYuanFromYuan(yuan: number) {
  if (!Number.isFinite(yuan) || yuan <= 0) return "";
  const wan = yuan / 10_000;
  const text = wan.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return `${text}万元`;
}

function extractPolicyStats(next: ReviewDataState, summary: HouseholdModel | null, confirmedCount: number) {
  const overviewFields = next.cardMeta[overviewCardId]?.overviewFields ?? {};

  const policyCountText = overviewFields["有效保单件数"] ?? "";
  const policyCount = policyCountText.trim().length ? parseIntLoose(policyCountText) : confirmedCount;

  const premiumText = String(overviewFields["累计已交保费"] ?? "").trim();
  if (premiumText.length) {
    if (premiumText.includes("万")) return { policyCount, totalPremium: premiumText.includes("元") ? premiumText : premiumText };
    return { policyCount, totalPremium: `${premiumText}万元` };
  }

  const fallbackYuan = summary
    ? summary.members.reduce((acc, m) => acc + (Number(m.accounts.wealth.paidPremium) || 0), 0)
    : 0;
  return { policyCount, totalPremium: formatWanYuanFromYuan(fallbackYuan) };
}

function safeParseInt(value: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function CaseProvider({ children }: { children: ReactNode }) {
  const caseSummaries = useLiveQuery(async () => {
    const rows = await db.cases.orderBy("updatedAt").reverse().toArray();
    const patches: Array<{
      id: number;
      policyCount?: number;
      totalPremium?: string;
      gapScore?: number;
      summaryData?: HouseholdModel | null;
    }> = [];
    const summaries = rows.map((r) => {
      const storedPolicyCount = Number.isFinite(r.policyCount) ? r.policyCount : 0;
      const storedTotalPremium = typeof r.totalPremium === "string" ? r.totalPremium : "";

      const storedGapScore = Number.isFinite(r.gapScore) ? r.gapScore : 0;
      const parsed = r.policyData?.parsed ?? null;
      const cardMeta = r.policyData?.cardMeta ?? {};
      const confirmedRows = getConfirmedPolicyRows(parsed, cardMeta);
      const summary =
        parsed != null
          ? aggregateHouseholdModel(
              confirmedRows.map((row) => row.row),
              parsed,
            )
          : null;
      const stats = extractPolicyStats(
        {
          rawMarkdown: "",
          parsed,
          updatedAt: null,
          cardMeta,
        },
        summary,
        confirmedRows.length,
      );
      const computedGapScore = computeGapScore(summary);

      const shouldPatchPolicy =
        (storedPolicyCount === 0 && stats.policyCount > 0) ||
        (storedTotalPremium.trim().length === 0 && stats.totalPremium.trim().length > 0);
      const shouldPatchScore = storedGapScore !== computedGapScore;
      const shouldPatchSummary = r.summaryData == null && summary != null;

      if ((shouldPatchPolicy || shouldPatchScore || shouldPatchSummary) && r.id != null) {
        patches.push(
          {
            id: r.id,
            ...(shouldPatchPolicy ? { policyCount: stats.policyCount, totalPremium: stats.totalPremium } : {}),
            ...(shouldPatchScore ? { gapScore: computedGapScore } : {}),
            ...(shouldPatchSummary ? { summaryData: summary } : {}),
          },
        );
      }

      return {
        id: r.id,
        customerName: r.customerName,
        status: r.status,
        gapScore: computedGapScore,
        policyCount: shouldPatchPolicy ? stats.policyCount : storedPolicyCount,
        totalPremium: shouldPatchPolicy ? stats.totalPremium : storedTotalPremium,
        updatedAt: r.updatedAt,
      };
    });

    if (patches.length > 0) {
      void db.transaction("rw", db.cases, async () => {
        await Promise.all(patches.map((p) => db.cases.update(p.id, p)));
      });
    }

    return summaries;
  }, [], []) as CaseSummary[];

  const [activeCaseId, setActiveCaseIdState] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    return safeParseInt(window.localStorage.getItem(activeCaseStorageKey));
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeCaseId == null) {
      window.localStorage.removeItem(activeCaseStorageKey);
      return;
    }
    window.localStorage.setItem(activeCaseStorageKey, String(activeCaseId));
  }, [activeCaseId]);

  const activeCase = useLiveQuery(async () => {
    if (activeCaseId == null) return null;
    return (await db.cases.get(activeCaseId)) ?? null;
  }, [activeCaseId], null) as CaseRecord | null;

  const [state, setLocalState] = useState<ReviewDataState>(defaultReviewState);

  useEffect(() => {
    setLocalState(toReviewState(activeCase));
  }, [activeCase]);

  useEffect(() => {
    if (activeCaseId != null) return;
    if (caseSummaries.length > 0 && caseSummaries[0]?.id != null) {
      setActiveCaseIdState(caseSummaries[0].id ?? null);
      return;
    }

    let cancelled = false;
    async function ensureCase() {
      const now = Date.now();
      const id = await db.cases.add({
        customerName: "",
        status: "pending",
        gapScore: 0,
        policyCount: 0,
        totalPremium: "",
        rawMarkdown: "",
        policyData: { parsed: null, cardMeta: {} },
        summaryData: null,
        updatedAt: now,
      });
      if (!cancelled) setActiveCaseIdState(id);
    }
    void ensureCase();
    return () => {
      cancelled = true;
    };
  }, [activeCaseId, caseSummaries]);

  const setState: Dispatch<SetStateAction<ReviewDataState>> = (updater) => {
    setLocalState((prev) => {
      const next = typeof updater === "function" ? (updater as (s: ReviewDataState) => ReviewDataState)(prev) : updater;
      void persist(next);
      return next;
    });
  };

  function clear() {
    setLocalState(defaultReviewState);
    void persist(defaultReviewState);
  }

  async function createNewCase() {
    const now = Date.now();
    const id = await db.cases.add({
      customerName: "",
      status: "pending",
      gapScore: 0,
      policyCount: 0,
      totalPremium: "",
      rawMarkdown: "",
      policyData: { parsed: null, cardMeta: {} },
      summaryData: null,
      updatedAt: now,
    });
    setActiveCaseIdState(id);
    setLocalState(defaultReviewState);
    return id;
  }

  async function updateCaseStatus(id: number, status: CaseRecord["status"]) {
    await db.cases.update(id, { status, updatedAt: Date.now() });
  }

  async function exportAllCases() {
    return db.cases.toArray();
  }

  async function importCases(records: CaseRecord[], mode: "merge" | "overwrite") {
    const normalized = records.map((r) => ({
      ...r,
      policyCount: Number.isFinite(r.policyCount) ? r.policyCount : 0,
      totalPremium: typeof r.totalPremium === "string" ? r.totalPremium : "",
      gapScore: Number.isFinite(r.gapScore) ? r.gapScore : 0,
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
      rawMarkdown: typeof r.rawMarkdown === "string" ? r.rawMarkdown : "",
      customerName: typeof r.customerName === "string" ? r.customerName : "",
      status:
        r.status === "pending" || r.status === "proposed" || r.status === "closed" || r.status === "rejected"
          ? r.status
          : "pending",
    }));
    await db.transaction("rw", db.cases, async () => {
      if (mode === "overwrite") {
        await db.cases.clear();
      }
      await db.cases.bulkPut(normalized);
    });
  }

  async function persist(next: ReviewDataState) {
    const now = Date.now();
    const customerName = next.parsed?.meta.customerName ?? activeCase?.customerName ?? "";
    const confirmedRows = getConfirmedPolicyRows(next.parsed, next.cardMeta);
    const summary =
      next.parsed != null
        ? aggregateHouseholdModel(
            confirmedRows.map((r) => r.row),
            next.parsed,
          )
        : null;
    const gapScore = computeGapScore(summary);
    const { policyCount, totalPremium } = extractPolicyStats(next, summary, confirmedRows.length);

    const patch: Partial<CaseRecord> = {
      customerName,
      rawMarkdown: next.rawMarkdown ?? "",
      policyData: toPolicyData(next),
      summaryData: summary,
      gapScore,
      policyCount,
      totalPremium,
      updatedAt: now,
    };

    if (activeCaseId == null) {
      const id = await db.cases.add({
        customerName,
        status: "pending",
        gapScore,
        policyCount,
        totalPremium,
        rawMarkdown: patch.rawMarkdown ?? "",
        policyData: patch.policyData ?? { parsed: null, cardMeta: {} },
        summaryData: summary,
        updatedAt: now,
      });
      setActiveCaseIdState(id);
      return;
    }

    await db.cases.update(activeCaseId, patch);
  }

  const value: CaseContextValue = {
    caseSummaries,
    activeCaseId,
    setActiveCaseId: setActiveCaseIdState,
    activeCase,
    state,
    setState,
    clear,
    createNewCase,
    updateCaseStatus,
    exportAllCases,
    importCases,
  };

  return <CaseContext.Provider value={value}>{children}</CaseContext.Provider>;
}

export function useCaseContext() {
  const ctx = useContext(CaseContext);
  if (!ctx) {
    throw new Error("useCaseContext must be used within CaseProvider");
  }
  return ctx;
}

export function getConfirmedPolicyRowIds(ids: string[], cardMeta: Record<string, CardMeta>) {
  return ids.filter((id) => Boolean(cardMeta[id]?.confirmed));
}
