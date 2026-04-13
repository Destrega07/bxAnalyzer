"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type CaseRecord, type CaseSummaryWithClassification, type CasePolicyData, type CardMeta, type CustomerPersona, type ProtectionRatingLabel, type ReportDraft } from "@/lib/db";
import type { ParsedMarkdownTables } from "@/lib/markdownTableParser";
import { getConfirmedPolicyRows } from "@/lib/reviewConfirmedPolicies";
import { aggregateHouseholdModel, type HouseholdModel } from "@/lib/aggregator";
import { computeProtectionScore } from "@/lib/scoringEngine";

export type ReviewDataState = {
  rawMarkdown: string;
  parsed: ParsedMarkdownTables | null;
  updatedAt: number | null;
  cardMeta: Record<string, CardMeta>;
  persona: CustomerPersona;
};

const overviewCardId = "overview:stats";

const defaultReviewState: ReviewDataState = {
  rawMarkdown: "",
  parsed: null,
  updatedAt: null,
  cardMeta: {},
  persona: {
    schemaVersion: 1,
    customerName: "",
    ageRange: null,
    maritalStatus: null,
    childrenStatus: null,
    personalIncome: null,
    otherInfo: "",
    classification: null,
    classificationBasis: null,
  },
};

type CaseContextValue = {
  caseSummaries: CaseSummaryWithClassification[];
  activeCaseId: number | null;
  setActiveCaseId: (id: number | null) => void;
  activeCase: CaseRecord | null;
  state: ReviewDataState;
  setState: Dispatch<SetStateAction<ReviewDataState>>;
  clear: () => void;
  createNewCase: () => Promise<number>;
  updateCaseStatus: (id: number, status: CaseRecord["status"]) => Promise<void>;
  updateCaseScore: (score: number, ratingLabel: ProtectionRatingLabel) => Promise<void>;
  updateCaseReportDraft: (draft: ReportDraft) => Promise<void>;
  exportAllCases: () => Promise<CaseRecord[]>;
  importCases: (records: CaseRecord[], mode: "merge" | "overwrite") => Promise<void>;
};

const activeCaseStorageKey = "ipis.activeCaseId.v1";

const CaseContext = createContext<CaseContextValue | null>(null);

function toReviewState(record: CaseRecord | null): ReviewDataState {
  if (!record) return defaultReviewState;
  const policyData = record.policyData;
  const persona = record.persona;
  return {
    rawMarkdown: record.rawMarkdown ?? "",
    parsed: policyData?.parsed ?? null,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
    cardMeta: policyData?.cardMeta ?? {},
    persona:
      persona && typeof persona === "object"
        ? {
            schemaVersion: 1,
            customerName: typeof persona.customerName === "string" ? persona.customerName : "",
            ageRange:
              persona.ageRange === "0~18" ||
              persona.ageRange === "19~30" ||
              persona.ageRange === "25~35" ||
              persona.ageRange === "31~50" ||
              persona.ageRange === "50以上"
                ? persona.ageRange
                : null,
            maritalStatus: persona.maritalStatus === "已婚" || persona.maritalStatus === "未婚" ? persona.maritalStatus : null,
            childrenStatus: persona.childrenStatus === "有孩" || persona.childrenStatus === "无孩" ? persona.childrenStatus : null,
            personalIncome:
              persona.personalIncome === "10万以下" ||
              persona.personalIncome === "10~20万" ||
              persona.personalIncome === "20~50万" ||
              persona.personalIncome === "50~100万" ||
              persona.personalIncome === "100万以上"
                ? persona.personalIncome
                : null,
            otherInfo: typeof persona.otherInfo === "string" ? persona.otherInfo : "",
            classification:
              persona.classification &&
              typeof persona.classification === "object" &&
              (persona.classification.id === "minor" ||
                persona.classification.id === "senior" ||
                persona.classification.id === "pillar" ||
                persona.classification.id === "couple" ||
                persona.classification.id === "single") &&
              typeof persona.classification.label === "string"
                ? { id: persona.classification.id, label: persona.classification.label }
                : null,
            classificationBasis:
              persona.classificationBasis &&
              typeof persona.classificationBasis === "object" &&
              (persona.classificationBasis.ageRange === "0~18" ||
                persona.classificationBasis.ageRange === "19~30" ||
                persona.classificationBasis.ageRange === "25~35" ||
                persona.classificationBasis.ageRange === "31~50" ||
                persona.classificationBasis.ageRange === "50以上") &&
              (persona.classificationBasis.maritalStatus === "已婚" ||
                persona.classificationBasis.maritalStatus === "未婚") &&
              (persona.classificationBasis.childrenStatus === "有孩" ||
                persona.classificationBasis.childrenStatus === "无孩") &&
              (persona.classificationBasis.personalIncome === "10万以下" ||
                persona.classificationBasis.personalIncome === "10~20万" ||
                persona.classificationBasis.personalIncome === "20~50万" ||
                persona.classificationBasis.personalIncome === "50~100万" ||
                persona.classificationBasis.personalIncome === "100万以上")
                ? {
                    ageRange: persona.classificationBasis.ageRange,
                    maritalStatus: persona.classificationBasis.maritalStatus,
                    childrenStatus: persona.classificationBasis.childrenStatus,
                    personalIncome: persona.classificationBasis.personalIncome,
                  }
                : null,
          }
        : defaultReviewState.persona,
  };
}

function toPolicyData(state: ReviewDataState): CasePolicyData {
  return {
    parsed: state.parsed ?? null,
    cardMeta: state.cardMeta ?? {},
  };
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
      summaryData?: HouseholdModel | null;
    }> = [];
    const summaries = rows.map((r) => {
      const storedPolicyCount = Number.isFinite(r.policyCount) ? r.policyCount : 0;
      const storedTotalPremium = typeof r.totalPremium === "string" ? r.totalPremium : "";

      const storedGapScore = Number.isFinite(r.gapScore) ? r.gapScore : 0;
      const storedRatingLabel =
        r.ratingLabel === "完美配置" || r.ratingLabel === "优质配置" || r.ratingLabel === "合格配置" || r.ratingLabel === "保障薄弱"
          ? r.ratingLabel
          : null;
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
          persona: defaultReviewState.persona,
        },
        summary,
        confirmedRows.length,
      );

      const shouldPatchPolicy =
        (storedPolicyCount === 0 && stats.policyCount > 0) ||
        (storedTotalPremium.trim().length === 0 && stats.totalPremium.trim().length > 0);
      const shouldPatchSummary = r.summaryData == null && summary != null;

      if ((shouldPatchPolicy || shouldPatchSummary) && r.id != null) {
        patches.push(
          {
            id: r.id,
            ...(shouldPatchPolicy ? { policyCount: stats.policyCount, totalPremium: stats.totalPremium } : {}),
            ...(shouldPatchSummary ? { summaryData: summary } : {}),
          },
        );
      }

      return {
        id: r.id,
        customerName: r.customerName,
        status: r.status,
        gapScore: storedGapScore,
        ratingLabel: storedRatingLabel,
        policyCount: shouldPatchPolicy ? stats.policyCount : storedPolicyCount,
        totalPremium: shouldPatchPolicy ? stats.totalPremium : storedTotalPremium,
        updatedAt: r.updatedAt,
        classification: r.persona?.classification ?? null,
      };
    });

    if (patches.length > 0) {
      void db.transaction("rw", db.cases, async () => {
        await Promise.all(patches.map((p) => db.cases.update(p.id, p)));
      });
    }

    return summaries;
  }, [], []) as CaseSummaryWithClassification[];

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
        ratingLabel: null,
        policyCount: 0,
        totalPremium: "",
        rawMarkdown: "",
        policyData: { parsed: null, cardMeta: {} },
        persona: defaultReviewState.persona,
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
      ratingLabel: null,
      policyCount: 0,
      totalPremium: "",
      rawMarkdown: "",
      policyData: { parsed: null, cardMeta: {} },
      persona: defaultReviewState.persona,
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

  async function updateCaseScore(score: number, ratingLabel: ProtectionRatingLabel) {
    if (activeCaseId == null) return;
    await db.cases.update(activeCaseId, {
      gapScore: Math.max(0, Math.min(100, Math.round(score))),
      ratingLabel,
      updatedAt: Date.now(),
    });
  }

  async function updateCaseReportDraft(draft: ReportDraft) {
    if (activeCaseId == null) return;
    await db.cases.update(activeCaseId, {
      reportDraft: draft,
      updatedAt: Date.now(),
    });
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
      ratingLabel:
        r.ratingLabel === "完美配置" || r.ratingLabel === "优质配置" || r.ratingLabel === "合格配置" || r.ratingLabel === "保障薄弱"
          ? r.ratingLabel
          : null,
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
      rawMarkdown: typeof r.rawMarkdown === "string" ? r.rawMarkdown : "",
      customerName: typeof r.customerName === "string" ? r.customerName : "",
      status:
        r.status === "pending" || r.status === "proposed" || r.status === "closed" || r.status === "rejected"
          ? r.status
          : "pending",
      persona:
        r.persona && typeof r.persona === "object"
          ? ({
              schemaVersion: 1,
              customerName:
                typeof (r.persona as CustomerPersona).customerName === "string"
                  ? (r.persona as CustomerPersona).customerName
                  : "",
              ageRange:
                (r.persona as CustomerPersona).ageRange === "0~18" ||
                (r.persona as CustomerPersona).ageRange === "19~30" ||
                (r.persona as CustomerPersona).ageRange === "25~35" ||
                (r.persona as CustomerPersona).ageRange === "31~50" ||
                (r.persona as CustomerPersona).ageRange === "50以上"
                  ? (r.persona as CustomerPersona).ageRange
                  : null,
              maritalStatus:
                (r.persona as CustomerPersona).maritalStatus === "已婚" ||
                (r.persona as CustomerPersona).maritalStatus === "未婚"
                  ? (r.persona as CustomerPersona).maritalStatus
                  : null,
              childrenStatus:
                (r.persona as CustomerPersona).childrenStatus === "有孩" ||
                (r.persona as CustomerPersona).childrenStatus === "无孩"
                  ? (r.persona as CustomerPersona).childrenStatus
                  : null,
              personalIncome:
                (r.persona as CustomerPersona).personalIncome === "10万以下" ||
                (r.persona as CustomerPersona).personalIncome === "10~20万" ||
                (r.persona as CustomerPersona).personalIncome === "20~50万" ||
                (r.persona as CustomerPersona).personalIncome === "50~100万" ||
                (r.persona as CustomerPersona).personalIncome === "100万以上"
                  ? (r.persona as CustomerPersona).personalIncome
                  : null,
              otherInfo: typeof (r.persona as CustomerPersona).otherInfo === "string" ? (r.persona as CustomerPersona).otherInfo : "",
              classification:
                (r.persona as CustomerPersona).classification &&
                typeof (r.persona as CustomerPersona).classification === "object" &&
                (((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).id === "minor" ||
                  ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).id === "senior" ||
                  ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).id === "pillar" ||
                  ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).id === "couple" ||
                  ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).id === "single") &&
                typeof ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).label === "string"
                  ? {
                      id: ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).id,
                      label: ((r.persona as CustomerPersona).classification as NonNullable<CustomerPersona["classification"]>).label,
                    }
                  : null,
              classificationBasis:
                (r.persona as CustomerPersona).classificationBasis &&
                typeof (r.persona as CustomerPersona).classificationBasis === "object" &&
                (((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).ageRange === "0~18" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).ageRange ===
                    "19~30" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).ageRange ===
                    "25~35" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).ageRange ===
                    "31~50" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).ageRange ===
                    "50以上") &&
                (((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).maritalStatus ===
                  "已婚" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).maritalStatus ===
                    "未婚") &&
                (((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).childrenStatus ===
                  "有孩" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).childrenStatus ===
                    "无孩") &&
                (((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                  .personalIncome === "10万以下" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                    .personalIncome === "10~20万" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                    .personalIncome === "20~50万" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                    .personalIncome === "50~100万" ||
                  ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                    .personalIncome === "100万以上")
                  ? {
                      ageRange: ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>).ageRange,
                      maritalStatus: ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                        .maritalStatus,
                      childrenStatus: ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                        .childrenStatus,
                      personalIncome: ((r.persona as CustomerPersona).classificationBasis as NonNullable<CustomerPersona["classificationBasis"]>)
                        .personalIncome,
                    }
                  : null,
            } satisfies CustomerPersona)
          : defaultReviewState.persona,
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
    const { policyCount, totalPremium } = extractPolicyStats(next, summary, confirmedRows.length);

    const patch: Partial<CaseRecord> = {
      customerName,
      rawMarkdown: next.rawMarkdown ?? "",
      policyData: toPolicyData(next),
      persona: next.persona,
      summaryData: summary,
      policyCount,
      totalPremium,
      updatedAt: now,
    };

    if (activeCaseId == null) {
      const scoreResult = computeProtectionScore({
        persona: next.persona,
        parsed: next.parsed,
        confirmedPolicies: confirmedRows.map((r) => r.row),
      });
      const id = await db.cases.add({
        customerName,
        status: "pending",
        gapScore: scoreResult?.score ?? 0,
        ratingLabel: scoreResult?.ratingLabel ?? null,
        policyCount,
        totalPremium,
        rawMarkdown: patch.rawMarkdown ?? "",
        policyData: patch.policyData ?? { parsed: null, cardMeta: {} },
        persona: patch.persona ?? defaultReviewState.persona,
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
    updateCaseScore,
    updateCaseReportDraft,
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
