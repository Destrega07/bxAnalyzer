"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseMarkdownTables } from "@/lib/markdownTableParser";
import { useCaseContext } from "@/context/CaseContext";
import { ArrowRight, ChevronDown, Loader2, Send, Upload } from "lucide-react";
import {
  getConfirmedPolicyRows,
  getReviewPolicyCards,
} from "@/lib/reviewConfirmedPolicies";
import { cleanInsuranceData } from "@/lib/cleaner";
import { classifyPersona, getClassificationPillClasses } from "@/lib/classifier";
import { inferInsuranceType, insuranceTypeOptions } from "@/lib/insuranceMapper";
import type { InsuranceType } from "@/lib/db";
import { computeProtectionScore } from "@/lib/scoringEngine";

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

function extractOverviewFields(parsed: ReturnType<typeof parseMarkdownTables>) {
  const fields: Record<string, string> = {};
  if (parsed.meta.customerName) fields["客户姓名"] = parsed.meta.customerName;

  for (const section of parsed.sections) {
    for (const table of section.tables) {
      if (!table.headers.includes("统计项") || !table.headers.includes("统计值")) continue;
      table.rows.forEach((row) => {
        const k = (row["统计项"] ?? "").trim();
        const v = (row["统计值"] ?? "").trim();
        if (!k || !v) return;
        fields[k] = v;
      });
      if (
        overviewKeyGroup1.every((k) => fields[k]) &&
        overviewKeyGroup2.every((k) => fields[k])
      ) {
        return fields;
      }
    }
  }

  return fields;
}

function extractMonthlyPremiums(parsed: ReturnType<typeof parseMarkdownTables>) {
  const rows: Array<{ yearMonth: string; totalPremium: string }> = [];
  for (const section of parsed.sections) {
    if (!section.heading.includes("月度交费备忘录")) continue;
    for (const table of section.tables) {
      const ymHeader = table.headers.find((h) => h.trim() === "年月") ?? "";
      const premiumHeader = table.headers.find((h) => h.trim().startsWith("保费合计")) ?? "";
      if (!ymHeader || !premiumHeader) continue;
      table.rows.forEach((row) => {
        const ym = (row[ymHeader] ?? "").trim();
        const total = (row[premiumHeader] ?? "").trim();
        if (!ym) return;
        rows.push({ yearMonth: ym, totalPremium: total });
      });
      if (rows.length > 0) return rows;
    }
  }
  return rows;
}

function isFlaggedValue(fieldName: string, value: string) {
  if (value.includes("!!")) return true;
  const v = value.trim();
  if (!v) return false;

  if (fieldName.includes("日期")) {
    if (v === "终身") return false;
    return !/^\d{4}-\d{2}-\d{2}$/.test(v);
  }

  if (
    fieldName.includes("保额") ||
    fieldName.includes("金额") ||
    fieldName.includes("保费") ||
    fieldName.includes("现金价值") ||
    fieldName.includes("账户价值") ||
    fieldName.includes("累计")
  ) {
    return !/^[\d,]+(\.\d+)?$/.test(v);
  }

  return false;
}

export default function ReviewPage() {
  const { state, setState, updateCaseScore } = useCaseContext();
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [previewingDecrypted, setPreviewingDecrypted] = useState(false);
  const [sendingHint, setSendingHint] = useState<string | null>(null);
  const [sendingProgress, setSendingProgress] = useState(0);
  const [capturedRaw, setCapturedRaw] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [cleanWarning, setCleanWarning] = useState<string | null>(null);

  const parsedMeta = state.parsed?.meta;
  const reportId = parsedMeta?.reportId;
  const persona = state.persona;
  const personaRequiredComplete = Boolean(
    persona.ageRange && persona.maritalStatus && persona.childrenStatus && persona.personalIncome,
  );
  const personaBasis = personaRequiredComplete
    ? {
        ageRange: persona.ageRange!,
        maritalStatus: persona.maritalStatus!,
        childrenStatus: persona.childrenStatus!,
        personalIncome: persona.personalIncome!,
      }
    : null;
  const personaBasisMatches = Boolean(
    personaBasis &&
      persona.classificationBasis &&
      persona.classificationBasis.ageRange === personaBasis.ageRange &&
      persona.classificationBasis.maritalStatus === personaBasis.maritalStatus &&
      persona.classificationBasis.childrenStatus === personaBasis.childrenStatus &&
      persona.classificationBasis.personalIncome === personaBasis.personalIncome,
  );
  const shouldPulseClassificationButton = personaRequiredComplete && (!persona.classification || !personaBasisMatches);

  const summary = useMemo(() => {
    const sections = state.parsed?.sections ?? [];
    const tableCount = sections.reduce((acc, s) => acc + s.tables.length, 0);
    const rowCount = sections.reduce((acc, s) => {
      return (
        acc + s.tables.reduce((tAcc, t) => tAcc + t.rows.length, 0)
      );
    }, 0);
    return { sectionCount: sections.length, tableCount, rowCount };
  }, [state.parsed]);

  const policyCards = useMemo(() => {
    return getReviewPolicyCards(state.parsed).map((card) => {
      const productName =
        card.row["产品名称"]?.trim() ||
        card.row["保险条款名称"]?.trim() ||
        card.row["保险产品名称"]?.trim() ||
        "未命名产品";
      const insured =
        card.row["被保人"]?.trim() ||
        card.row["被保险人"]?.trim() ||
        card.row["被保人姓名"]?.trim() ||
        card.row["被保人名称"]?.trim() ||
        "-";
      const effectiveDate =
        card.row["生效日期"]?.trim() || card.row["生效日"]?.trim() || "-";
      return { ...card, productName, insured, effectiveDate };
    });
  }, [state.parsed]);

  const confirmStats = useMemo(() => {
    const total = policyCards.length;
    const confirmedRows = getConfirmedPolicyRows(state.parsed, state.cardMeta);
    return { total, confirmed: confirmedRows.length, confirmedRows };
  }, [policyCards.length, state.cardMeta, state.parsed]);

  function parseAndSave(input: string) {
    try {
      const parsed = parseMarkdownTables(input);
      const nextParsed = (() => {
        const name = parsed.meta.customerName;
        if (!name) return parsed;

        const sections = parsed.sections.slice();
        let changed = false;

        parsed.sections.forEach((section, sectionIndex) => {
          const tables = section.tables.map((table) => {
            const headers = table.headers ?? [];
            const looksLikePolicyTable =
              headers.includes("保险条款名称") &&
              headers.includes("生效日期") &&
              headers.length >= 3;
            if (!looksLikePolicyTable) return table;

            let tableChanged = false;
            const rows = table.rows.map((row) => {
              let nextRow = row;
              (["被保人", "被保险人", "被保人姓名", "投保人"] as const).forEach((key) => {
                if (typeof nextRow[key] === "string" && nextRow[key].trim() === "本人") {
                  nextRow = { ...nextRow, [key]: name };
                }
              });
              if (
                section.heading.includes("被保人视图") &&
                !("被保人" in nextRow) &&
                !("被保险人" in nextRow) &&
                !("被保人姓名" in nextRow)
              ) {
                nextRow = { ...nextRow, 被保人: name };
              }
              if (nextRow !== row) {
                tableChanged = true;
                changed = true;
              }
              return nextRow;
            });

            return tableChanged ? { ...table, rows } : table;
          });

          if (tables.some((table, tableIndex) => table !== section.tables[tableIndex])) {
            sections[sectionIndex] = { ...section, tables };
          }
        });

        return changed ? { ...parsed, sections } : parsed;
      })();
      setExpandedById({});
      const extractedMonthly = extractMonthlyPremiums(nextParsed);
      const extractedOverview = extractOverviewFields(nextParsed);
      setState((prev) => {
        const nextCustomerName =
          String(extractedOverview["客户姓名"] ?? "").trim() ||
          String(nextParsed.meta.customerName ?? "").trim() ||
          prev.persona.customerName;
        const prevMonthly = prev.cardMeta[monthlyMemoCardId]?.monthlyPremiums ?? [];
        const prevMonthlyByYm = new Map(
          prevMonthly.map((r) => [r.yearMonth, r.totalPremium] as const),
        );
        const mergedMonthly = extractedMonthly.map((r) => {
          const existing = prevMonthlyByYm.get(r.yearMonth);
          if (typeof existing === "string" && existing.trim().length > 0) {
            return { ...r, totalPremium: existing };
          }
          return r;
        });
        const mergedSet = new Set(mergedMonthly.map((r) => r.yearMonth));
        prevMonthly.forEach((r) => {
          if (!mergedSet.has(r.yearMonth)) mergedMonthly.push(r);
        });

        return {
          ...prev,
          rawMarkdown: input,
          parsed: nextParsed,
          cardMeta: {
            ...prev.cardMeta,
            [overviewCardId]: {
              confirmed: Boolean(prev.cardMeta[overviewCardId]?.confirmed),
              overviewFields: {
                ...extractedOverview,
                ...(prev.cardMeta[overviewCardId]?.overviewFields ?? {}),
              },
            },
            [monthlyMemoCardId]: {
              confirmed: Boolean(prev.cardMeta[monthlyMemoCardId]?.confirmed),
              monthlyPremiums: mergedMonthly,
            },
          },
          persona: { ...prev.persona, customerName: nextCustomerName },
          updatedAt: Date.now(),
        };
      });
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "解析失败");
    }
  }

  function handleParseAndSave() {
    const input = textareaRef.current?.value ?? "";
    parseAndSave(input);
  }

  function stopPolling() {
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function scrollToWorkspace() {
    const target = workspaceRef.current;
    if (target) {
      const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - 16);
      window.scrollTo({ top, behavior: "smooth" });
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleCleanCapturedRaw() {
    const result = cleanInsuranceData(capturedRaw);
    if (!result) {
      setToast("未能从捕获原文中清洗出保单 Markdown，请检查原文内容");
      setCleanWarning("未识别到标准保单章节，请检查原文格式或重新发送银保报告");
      return;
    }
    if (!result.hasPolicyTable) {
      setCleanWarning("未识别到标准保单章节，请检查原文格式或重新发送银保报告");
    }
    if (textareaRef.current) {
      textareaRef.current.value = result.markdown;
    }
    parseAndSave(result.markdown);
    window.setTimeout(() => scrollToWorkspace(), 120);
  }

  async function handleSendToCoze() {
    if (!selectedFile || sending) return;
    setSending(true);
    setSendingHint("正在上传并发起解析任务...");
    setSendingProgress(6);
    setStatus("idle");
    setErrorMessage(null);
    setCapturedRaw("");
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
    stopPolling();
    try {
      const form = new FormData();
      form.set("file", selectedFile, selectedFile.name);
      if (password.trim().length > 0) {
        form.set("password", password.trim());
      }
      const res = await fetch("/api/analyze", { method: "POST", body: form });
      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const parsed =
          contentType.includes("application/json") && raw.trim().length
            ? (JSON.parse(raw) as unknown)
            : null;
        if (parsed && typeof parsed === "object") {
          const rec = parsed as Record<string, unknown>;
          const step = typeof rec.step === "string" ? rec.step : "";
          const err = typeof rec.error === "object" && rec.error ? (rec.error as Record<string, unknown>) : null;
          const code = err && typeof err.code === "string" ? err.code : "";
          const msg = err && typeof err.msg === "string" ? err.msg : typeof rec.error === "string" ? rec.error : "";
          const looksLikePasswordError =
            step === "decrypt" &&
            (code === "PDF_PASSWORD_INCORRECT" ||
              msg.includes("密码错误") ||
              msg.toLowerCase().includes("password"));
          const looksLikePasswordRequired =
            step === "decrypt" &&
            (code === "PDF_PASSWORD_REQUIRED" || msg.includes("请输入查询密码"));
          if (looksLikePasswordError) {
            setToast("PDF 查询密码错误，请重新输入后再发送。");
            return;
          }
          if (looksLikePasswordRequired) {
            setToast("该 PDF 为加密文件，请先输入查询密码后再发送。");
            return;
          }
        }
        const detail =
          parsed && typeof parsed === "object" && parsed
            ? (() => {
                const rec = parsed as Record<string, unknown>;
                const step = typeof rec.step === "string" ? rec.step : "";
                const msg =
                  typeof rec.error === "string"
                    ? rec.error
                    : typeof rec.error === "object" && rec.error && "msg" in rec.error
                      ? String((rec.error as Record<string, unknown>).msg ?? "")
                      : "";
                const status = res.status;
                const text = [step ? `步骤:${step}` : "", msg ? `原因:${msg}` : "", `HTTP:${status}`]
                  .filter(Boolean)
                  .join(" / ");
                return text.length ? `（${text}）` : "";
              })()
            : `（HTTP:${res.status}）`;

        setToast(`智能体解析失败，请尝试手动粘贴内容${detail}`);
        setSendingProgress(0);
        return;
      }
      const startPayload = (await res.json()) as unknown;
      const startRec =
        startPayload && typeof startPayload === "object"
          ? (startPayload as Record<string, unknown>)
          : null;
      const conversationId =
        typeof startRec?.conversationId === "string"
          ? startRec.conversationId
          : typeof startRec?.conversation_id === "string"
            ? (startRec.conversation_id as string)
            : "";
      const chatId =
        typeof startRec?.chatId === "string"
          ? startRec.chatId
          : typeof startRec?.chat_id === "string"
            ? (startRec.chat_id as string)
            : "";
      if (!conversationId || !chatId) {
        setToast("智能体解析失败，请尝试手动粘贴内容（缺少任务ID）");
        setSendingProgress(0);
        return;
      }

      const timeoutMs = 300_000;
      const startedAt = Date.now();
      const poll = async () => {
        if (Date.now() - startedAt > timeoutMs) {
          setToast("解析耗时较长，请稍后手动检查或尝试重新上传");
          setSending(false);
          setSendingHint(null);
          setSendingProgress(0);
          stopPolling();
          return;
        }

        try {
          const u = new URL("/api/analyze", window.location.origin);
          u.searchParams.set("conversation_id", conversationId);
          u.searchParams.set("chat_id", chatId);
          const r = await fetch(u.toString(), { method: "GET" });
          if (r.status === 200) {
            const raw = await r.text();
            setCapturedRaw(raw);
            setSendingProgress(100);
            setSending(false);
            setSendingHint("已捕获 Coze 原始报文，请点击“数据清洗”");
            stopPolling();
            return;
          }

          if (r.status === 202) {
            const payload = (await r.json()) as unknown;
            const rec = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
            const chatStatus = typeof rec?.status === "string" ? rec.status : "RUNNING";
            const retryAfterMs = typeof rec?.retryAfterMs === "number" ? rec.retryAfterMs : 1500;
            const elapsedMs = Date.now() - startedAt;
            const durationBase = 12 + (elapsedMs / 80_000) * 80;
            const statusBoost =
              chatStatus === "QUEUED"
                ? 0
                : chatStatus === "IN_PROGRESS"
                  ? 5
                  : chatStatus === "RUNNING"
                    ? 8
                    : 0;
            const nextProgress = Math.min(95, Math.round(durationBase + statusBoost));
            setSendingProgress((prev) => Math.max(prev, nextProgress));
            setSendingHint(`正在深度解析中，请稍候...（${chatStatus}）`);
            pollTimerRef.current = window.setTimeout(poll, Math.max(800, Math.min(5000, retryAfterMs)));
            return;
          }

          const contentType = r.headers.get("content-type") ?? "";
          const raw = await r.text();
          const parsed =
            contentType.includes("application/json") && raw.trim().length ? (JSON.parse(raw) as unknown) : null;
          const detail =
            parsed && typeof parsed === "object" && parsed
              ? (() => {
                  const rr = parsed as Record<string, unknown>;
                  const step = typeof rr.step === "string" ? rr.step : "";
                  const msg =
                    typeof rr.error === "string"
                      ? rr.error
                      : typeof rr.error === "object" && rr.error && "msg" in rr.error
                        ? String((rr.error as Record<string, unknown>).msg ?? "")
                        : "";
                  const debug =
                    typeof rr.debug_all_messages === "string" && rr.debug_all_messages.length > 0
                      ? rr.debug_all_messages.slice(0, 180)
                      : "";
                  const status = r.status;
                  const text = [
                    step ? `步骤:${step}` : "",
                    msg ? `原因:${msg}` : "",
                    `HTTP:${status}`,
                    debug ? `调试:${debug}` : "",
                  ]
                    .filter(Boolean)
                    .join(" / ");
                  return text.length ? `（${text}）` : "";
                })()
              : `（HTTP:${r.status}）`;
          setToast(`智能体解析失败，请尝试手动粘贴内容${detail}`);
          setSending(false);
          setSendingHint(null);
          setSendingProgress(0);
          stopPolling();
        } catch {
          setToast("智能体解析失败，请尝试手动粘贴内容");
          setSending(false);
          setSendingHint(null);
          setSendingProgress(0);
          stopPolling();
        }
      };

      setSendingHint("正在深度解析中，请稍候...");
      setSendingProgress(10);
      pollTimerRef.current = window.setTimeout(poll, 800);
    } catch {
      setToast("智能体解析失败，请尝试手动粘贴内容");
      setSendingProgress(0);
    } finally {
      if (!pollTimerRef.current) {
        setSending(false);
        setSendingHint(null);
        setSendingProgress(0);
      }
    }
  }

  async function handlePreviewDecryptedPdf() {
    if (!selectedFile || sending || previewingDecrypted) return;
    setPreviewingDecrypted(true);
    try {
      const form = new FormData();
      form.set("file", selectedFile, selectedFile.name);
      if (password.trim().length > 0) {
        form.set("password", password.trim());
      }
      const res = await fetch("/api/analyze?debug_download=true", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const parsed =
          contentType.includes("application/json") && raw.trim().length
            ? (JSON.parse(raw) as unknown)
            : null;
        if (parsed && typeof parsed === "object") {
          const rec = parsed as Record<string, unknown>;
          const step = typeof rec.step === "string" ? rec.step : "";
          const err =
            typeof rec.error === "object" && rec.error
              ? (rec.error as Record<string, unknown>)
              : null;
          const code = err && typeof err.code === "string" ? err.code : "";
          const msg =
            err && typeof err.msg === "string"
              ? err.msg
              : typeof rec.error === "string"
                ? rec.error
                : "";
          const looksLikePasswordError =
            step === "decrypt" &&
            (code === "PDF_PASSWORD_INCORRECT" ||
              msg.includes("密码错误") ||
              msg.toLowerCase().includes("password"));
          const looksLikePasswordRequired =
            step === "decrypt" &&
            (code === "PDF_PASSWORD_REQUIRED" || msg.includes("请输入查询密码"));
          if (looksLikePasswordError) {
            setToast("PDF 查询密码错误，请重新输入后再预览。");
            return;
          }
          if (looksLikePasswordRequired) {
            setToast("该 PDF 为加密文件，请先输入查询密码后再预览。");
            return;
          }
        }
        const detail =
          parsed && typeof parsed === "object" && parsed
            ? (() => {
                const rec = parsed as Record<string, unknown>;
                const step = typeof rec.step === "string" ? rec.step : "";
                const msg =
                  typeof rec.error === "string"
                    ? rec.error
                    : typeof rec.error === "object" && rec.error && "msg" in rec.error
                      ? String((rec.error as Record<string, unknown>).msg ?? "")
                      : "";
                const status = res.status;
                const text = [
                  step ? `步骤:${step}` : "",
                  msg ? `原因:${msg}` : "",
                  `HTTP:${status}`,
                ]
                  .filter(Boolean)
                  .join(" / ");
                return text.length ? `（${text}）` : "";
              })()
            : `（HTTP:${res.status}）`;
        setToast(`预览解密失败，请检查密码或稍后重试${detail}`);
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const raw = await res.text();
        const parsed =
          raw.trim().length > 0 ? (JSON.parse(raw) as unknown) : null;
        const msg =
          parsed && typeof parsed === "object" && parsed && "error" in parsed
            ? String((parsed as Record<string, unknown>).error ?? "")
            : "返回格式异常";
        setToast(`预览解密失败：${msg}`);
        return;
      }

      const blob = await res.blob();
      const baseName = selectedFile.name.replace(/\.pdf$/i, "");
      const filename = `${baseName}-decrypted.pdf`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1200);
    } catch {
      setToast("预览解密失败，请稍后重试");
    } finally {
      setPreviewingDecrypted(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!cleanWarning) return;
    const t = window.setTimeout(() => setCleanWarning(null), 3200);
    return () => window.clearTimeout(t);
  }, [cleanWarning]);

  useEffect(() => {
    return () => stopPolling();
  }, []);

  function confirmAllVisible() {
    setState((prev) => {
      const nextMeta = { ...prev.cardMeta };
      policyCards.forEach((card) => {
        nextMeta[card.id] = { ...nextMeta[card.id], confirmed: true };
      });
      nextMeta[overviewCardId] = { ...nextMeta[overviewCardId], confirmed: true };
      return { ...prev, cardMeta: nextMeta, updatedAt: Date.now() };
    });
  }

  function toggleExpanded(id: string) {
    setExpandedById((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function setConfirmed(id: string, confirmed: boolean) {
    setState((prev) => ({
      ...prev,
      cardMeta: { ...prev.cardMeta, [id]: { ...prev.cardMeta[id], confirmed } },
      updatedAt: Date.now(),
    }));
  }

  function setReportSource(id: string, reportSource: string) {
    setState((prev) => ({
      ...prev,
      cardMeta: {
        ...prev.cardMeta,
        [id]: { ...prev.cardMeta[id], reportSource },
      },
      updatedAt: Date.now(),
    }));
  }

  function setPolicyInsuranceType(id: string, insuranceType: InsuranceType | null) {
    setState((prev) => {
      const prevMeta = prev.cardMeta[id];
      return {
        ...prev,
        cardMeta: {
          ...prev.cardMeta,
          [id]: {
            ...prevMeta,
            confirmed: Boolean(prevMeta?.confirmed),
            reportSource: prevMeta?.reportSource,
            insuranceType: insuranceType ?? undefined,
          },
        },
        updatedAt: Date.now(),
      };
    });
  }

  function setOverviewField(key: string, value: string) {
    setState((prev) => {
      const next = {
        ...prev,
        cardMeta: {
          ...prev.cardMeta,
          [overviewCardId]: {
            confirmed: Boolean(prev.cardMeta[overviewCardId]?.confirmed),
            overviewFields: {
              ...(prev.cardMeta[overviewCardId]?.overviewFields ?? {}),
              [key]: value,
            },
          },
        },
        updatedAt: Date.now(),
      };
      if (key === "客户姓名") {
        return { ...next, persona: { ...prev.persona, customerName: value } };
      }
      return next;
    });
  }

  function setPersonaField<K extends keyof typeof persona>(key: K, value: (typeof persona)[K]) {
    setState((prev) => ({
      ...prev,
      persona: { ...prev.persona, [key]: value },
      updatedAt: Date.now(),
    }));
  }

  function setOverviewConfirmed(confirmed: boolean) {
    setState((prev) => ({
      ...prev,
      cardMeta: {
        ...prev.cardMeta,
        [overviewCardId]: { ...prev.cardMeta[overviewCardId], confirmed },
      },
      updatedAt: Date.now(),
    }));
  }

  function setMonthlyPremium(yearMonth: string, totalPremium: string) {
    setState((prev) => {
      const prevRows = prev.cardMeta[monthlyMemoCardId]?.monthlyPremiums ?? [];
      const nextRows = prevRows.map((r) =>
        r.yearMonth === yearMonth ? { ...r, totalPremium } : r,
      );
      return {
        ...prev,
        cardMeta: {
          ...prev.cardMeta,
          [monthlyMemoCardId]: {
            confirmed: Boolean(prev.cardMeta[monthlyMemoCardId]?.confirmed),
            monthlyPremiums: nextRows,
          },
        },
        updatedAt: Date.now(),
      };
    });
  }

  function updatePolicyCell(
    card: (typeof policyCards)[number],
    fieldName: string,
    value: string,
  ) {
    setState((prev) => {
      const parsed = prev.parsed;
      if (!parsed) return prev;

      const sections = parsed.sections.slice();
      let changed = false;

      card.sourceRefs.forEach((ref) => {
        if (!ref.headers.includes(fieldName)) return;
        const section = sections[ref.sectionIndex];
        if (!section) return;
        const tables = section.tables.slice();
        const table = tables[ref.tableIndex];
        if (!table) return;

        const rows = table.rows.slice();
        const row = rows[ref.rowIndex];
        if (!row) return;
        if ((row[fieldName] ?? "") === value) return;

        rows[ref.rowIndex] = { ...row, [fieldName]: value };
        tables[ref.tableIndex] = { ...table, rows };
        sections[ref.sectionIndex] = { ...section, tables };
        changed = true;
      });

      if (!changed) return prev;

      return {
        ...prev,
        parsed: { ...parsed, sections },
        updatedAt: Date.now(),
      };
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">校对工作台</h1>
      </div>

      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
        <div className="text-sm font-semibold">第1步，摘录与解析《银保报告》关键信息</div>

        <div className="text-xs font-medium text-zinc-700">1.1 将银保报告发给AI</div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setSelectedFile(file);
                setPassword("");
                setStatus("idle");
                setErrorMessage(null);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              className={[
                "inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium",
                sending
                  ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
                  : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
              ].join(" ")}
            >
              <Upload className="h-4 w-4" />
              上传银保报告
            </button>
            <div className="min-w-0 truncate text-xs text-zinc-500">
              {selectedFile ? selectedFile.name : "未选择文件"}
            </div>
          </div>

          {selectedFile ? (
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={sending || previewingDecrypted}
                placeholder="若 PDF 是加密文件，请输入查询密码；若PDF没有加密，直接点击发送按钮即可"
                className={[
                  "h-9 w-[min(23vw,210px)] rounded-lg border px-3 text-sm outline-none",
                  sending || previewingDecrypted
                    ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
                    : "border-zinc-200 bg-white focus:border-zinc-400",
                ].join(" ")}
              />
              <button
                type="button"
                onClick={handlePreviewDecryptedPdf}
                disabled={sending || previewingDecrypted}
                className={[
                  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium",
                  sending || previewingDecrypted
                    ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
                    : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
                ].join(" ")}
              >
                {previewingDecrypted ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                预览解密版PDF
              </button>
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleSendToCoze}
            disabled={!selectedFile || sending}
            className={[
              "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium",
              !selectedFile || sending
                ? "cursor-not-allowed bg-zinc-200 text-zinc-600"
                : "bg-zinc-900 text-white hover:bg-zinc-800",
            ].join(" ")}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? "深度解析中" : "发送"}
          </button>
        </div>

        {sending && sendingHint ? (
          <div className="relative overflow-hidden rounded-lg border border-emerald-200 bg-emerald-50">
            <div
              className="absolute inset-y-0 left-0 bg-emerald-300 transition-[width] duration-700 ease-out"
              style={{ width: `${sendingProgress}%` }}
            />
            <div className="relative z-10 px-3 py-2 text-xs font-medium text-emerald-900">
              {sendingHint}（约 {sendingProgress}%）
            </div>
          </div>
        ) : null}

        <div className="border-t border-zinc-200" />

        <div className="text-xs font-medium text-zinc-700">1.2 清洗AI返回原始数据</div>
        <textarea
          value={capturedRaw}
          disabled={sending}
          onChange={(e) => setCapturedRaw(e.target.value)}
          className={[
            "h-48 w-full resize-y rounded-lg border px-3 py-2 text-sm outline-none",
            sending
              ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
              : "border-zinc-200 bg-white focus:border-zinc-400",
          ].join(" ")}
          placeholder="等待AI自动返回《银保报告》的摘录信息"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCleanCapturedRaw}
            disabled={sending || capturedRaw.trim().length === 0}
            className={[
              "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium",
              sending || capturedRaw.trim().length === 0
                ? "cursor-not-allowed bg-zinc-200 text-zinc-600"
                : "bg-zinc-900 text-white hover:bg-zinc-800",
            ].join(" ")}
          >
            数据清洗
          </button>
        </div>

        <div className="border-t border-zinc-200" />

        <div className="text-xs font-medium text-zinc-700">1.3 解析《银保报告》摘录信息</div>
        <textarea
          key={state.updatedAt ?? 0}
          ref={textareaRef}
          defaultValue={state.rawMarkdown ?? ""}
          disabled={sending}
          onChange={() => {
            setStatus("idle");
            setErrorMessage(null);
          }}
          className={[
            "h-64 w-full resize-y rounded-lg border px-3 py-2 text-sm outline-none",
            sending
              ? "cursor-wait border-zinc-200 bg-zinc-100 text-zinc-600"
              : "border-zinc-200 bg-white focus:border-zinc-400",
          ].join(" ")}
          placeholder="等待清洗数据流入"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleParseAndSave}
            disabled={sending}
            className={[
              "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium",
              sending
                ? "cursor-wait bg-zinc-200 text-zinc-600"
                : "bg-zinc-900 text-white hover:bg-zinc-800",
            ].join(" ")}
          >
            解析并保存
          </button>

          <div className="ml-auto text-xs text-zinc-500">
            {state.updatedAt
              ? `已保存：${new Date(state.updatedAt).toLocaleString()}`
              : "未保存"}
          </div>
        </div>

        {status === "success" ? (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            解析成功：{summary.sectionCount} 个区块 / {summary.tableCount} 个表格 /{" "}
            {summary.rowCount} 行
          </div>
        ) : null}

        {status === "error" ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {errorMessage ?? "解析失败"}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">第2步，完善客户画像</div>
            <div className="text-xs text-zinc-500">用于保障评级（本地保存，刷新页面不丢失）</div>
          </div>
          <div className="flex items-center gap-2">
            {persona.classification ? (
              <span className={getClassificationPillClasses(persona.classification.id)}>
                {persona.classification.label}
              </span>
            ) : null}
            <button
              type="button"
              disabled={sending || !personaRequiredComplete}
              onClick={async () => {
                if (!personaRequiredComplete || !personaBasis) return;
                const classification = classifyPersona(persona);
                if (!classification) {
                  setToast("当前画像未匹配到分类标签，请检查必填项选择");
                  return;
                }
                setState((prev) => ({
                  ...prev,
                  persona: {
                    ...prev.persona,
                    classification,
                    classificationBasis: personaBasis,
                  },
                  updatedAt: Date.now(),
                }));
                console.log("[标签更新] classification", classification);
                const confirmedRows = getConfirmedPolicyRows(state.parsed, state.cardMeta);
                const scoreResult = computeProtectionScore({
                  persona: { ...persona, classification, classificationBasis: personaBasis },
                  parsed: state.parsed,
                  confirmedPolicies: confirmedRows.map((r) => r.row),
                });
                if (scoreResult) {
                  await updateCaseScore(scoreResult.score, scoreResult.ratingLabel);
                }
              }}
              className={[
                "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition",
                sending || !personaRequiredComplete
                  ? "cursor-not-allowed bg-zinc-200 text-zinc-600"
                  : "bg-[#D31145] text-white hover:bg-[#b50f3a]",
                !sending && shouldPulseClassificationButton ? "animate-pulse" : "",
              ].join(" ")}
            >
              写入分类标签
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="text-xs text-zinc-500">客户姓名</div>
            <input
              value={persona.customerName}
              disabled
              className="h-10 w-full rounded-lg border border-zinc-200 bg-zinc-100 px-3 text-sm text-zinc-700 outline-none"
            />
          </div>

          <div className="space-y-1">
            <div className="text-xs text-zinc-500">年龄（必填）</div>
            <select
              value={persona.ageRange ?? ""}
              disabled={sending}
              onChange={(e) => setPersonaField("ageRange", (e.target.value || null) as typeof persona.ageRange)}
              className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
            >
              <option value="">请选择</option>
              {(["0~18", "19~30", "25~35", "31~50", "50以上"] as const).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-zinc-500">婚否（必填）</div>
            <select
              value={persona.maritalStatus ?? ""}
              disabled={sending}
              onChange={(e) =>
                setPersonaField("maritalStatus", (e.target.value || null) as typeof persona.maritalStatus)
              }
              className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
            >
              <option value="">请选择</option>
              {(["已婚", "未婚"] as const).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-zinc-500">子女（必填）</div>
            <select
              value={persona.childrenStatus ?? ""}
              disabled={sending}
              onChange={(e) =>
                setPersonaField("childrenStatus", (e.target.value || null) as typeof persona.childrenStatus)
              }
              className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
            >
              <option value="">请选择</option>
              {(["有孩", "无孩"] as const).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <div className="text-xs text-zinc-500">个人收入（必填）</div>
            <select
              value={persona.personalIncome ?? ""}
              disabled={sending}
              onChange={(e) =>
                setPersonaField("personalIncome", (e.target.value || null) as typeof persona.personalIncome)
              }
              className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
            >
              <option value="">请选择</option>
              {(["10万以下", "10~20万", "20~50万", "50~100万", "100万以上"] as const).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <div className="text-xs text-zinc-500">其他信息（可选）</div>
            <textarea
              value={persona.otherInfo}
              disabled={sending}
              onChange={(e) => setPersonaField("otherInfo", e.target.value)}
              className="h-28 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
              placeholder="输入客户背景、职业、健康状态、风险偏好等..."
            />
          </div>
        </div>
      </div>

      {toast ? (
        <div
          className="fixed bottom-20 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-800 shadow-lg"
          role="status"
          aria-live="polite"
          onClick={() => setToast(null)}
        >
          {toast}
        </div>
      ) : null}

      {cleanWarning ? (
        <div
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-900 shadow-xl"
          role="status"
          aria-live="polite"
          onClick={() => setCleanWarning(null)}
        >
          {cleanWarning}
        </div>
      ) : null}

      <div ref={workspaceRef} className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium">第3步，检查修正解析后的关键信息</div>
          <button
            type="button"
            onClick={confirmAllVisible}
            disabled={confirmStats.total === 0}
            className={[
              "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium",
              confirmStats.total === 0
                ? "cursor-not-allowed bg-zinc-100 text-zinc-400"
                : "bg-emerald-600 text-white hover:bg-emerald-500",
            ].join(" ")}
          >
            全选确认
          </button>
          <div className="ml-auto text-xs text-zinc-500">
            默认折叠，点击卡片展开后可编辑全部字段
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">
              已确认 {confirmStats.confirmed}/{confirmStats.total} 份保单（含附加险）
            </div>
            <div className="text-xs text-zinc-500">
              汇总计算仅使用已确认数据（{confirmStats.confirmedRows.length} 行）
            </div>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width]"
              style={{
                width:
                  confirmStats.total > 0
                    ? `${Math.round(
                        (confirmStats.confirmed / confirmStats.total) * 100,
                      )}%`
                    : "0%",
              }}
            />
          </div>
        </div>

        <div
          className={[
            "overflow-hidden rounded-xl border bg-white",
            state.cardMeta[overviewCardId]?.confirmed
              ? "border-emerald-400"
              : "border-zinc-200",
          ].join(" ")}
        >
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
            <div className="space-y-1">
              <div className="text-sm font-semibold">汇总统计</div>
              <div className="text-xs text-zinc-500">
                可编辑，确认后将用于家庭保障总览展示
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setOverviewConfirmed(!Boolean(state.cardMeta[overviewCardId]?.confirmed))
              }
              className={[
                "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium",
                state.cardMeta[overviewCardId]?.confirmed
                  ? "bg-emerald-600 text-white hover:bg-emerald-500"
                  : "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
              ].join(" ")}
            >
              确认无误
            </button>
          </div>

          <div className="border-t border-zinc-200 px-4 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {["客户姓名", ...overviewKeyGroup1, ...overviewKeyGroup2].map((k) => (
                <div key={k} className="space-y-1">
                  <div className="text-xs text-zinc-500">{k}</div>
                  <input
                    value={state.cardMeta[overviewCardId]?.overviewFields?.[k] ?? ""}
                    onChange={(e) => setOverviewField(k, e.target.value)}
                    className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {policyCards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
            暂未识别到“保单信息”
          </div>
        ) : (
          <div className="grid gap-3">
            {policyCards.map((card) => {
              const expanded = Boolean(expandedById[card.id]);
              const confirmed = Boolean(state.cardMeta[card.id]?.confirmed);
              const product =
                card.productName.length > 0 ? card.productName : "未命名产品";
              const insured = card.insured.length > 0 ? card.insured : "-";
              const effective =
                card.effectiveDate.length > 0 ? card.effectiveDate : "-";

              return (
                <div
                  key={card.id}
                  className={[
                    "overflow-hidden rounded-xl border bg-white",
                    confirmed ? "border-emerald-400" : "border-zinc-200",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={() => toggleExpanded(card.id)}
                    className="flex w-full items-start gap-3 px-4 py-4 text-left active:bg-zinc-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="min-w-0 truncate text-sm font-semibold">
                          {product}
                        </div>
                        {(() => {
                          const stored = state.cardMeta[card.id]?.insuranceType;
                          const storedValid =
                            stored && insuranceTypeOptions.includes(stored as InsuranceType)
                              ? stored
                              : undefined;
                          const inferred = inferInsuranceType(product)?.type;
                          const value = storedValid ?? inferred ?? "";
                          return (
                            <select
                              value={value}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                const next = e.target.value as InsuranceType | "";
                                setPolicyInsuranceType(card.id, next ? next : null);
                              }}
                              className={[
                                "h-7 rounded-full border px-2 text-xs font-medium outline-none",
                                "border-zinc-200 bg-white text-zinc-700",
                              ].join(" ")}
                            >
                              <option value="">请选择</option>
                              {insuranceTypeOptions.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          );
                        })()}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600">
                        <div className="min-h-5">
                          <span className="text-zinc-500">被保人：</span>
                          <span className="font-medium text-zinc-800">
                            {insured}
                          </span>
                        </div>
                        <div className="min-h-5">
                          <span className="text-zinc-500">生效日期：</span>
                          <span className="font-medium text-zinc-800">
                            {effective}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <label
                        className="flex select-none items-center gap-2 text-xs text-zinc-600"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-emerald-600"
                          checked={confirmed}
                          onChange={(e) => setConfirmed(card.id, e.target.checked)}
                        />
                        确认无误
                      </label>
                      <ChevronDown
                        className={[
                          "h-5 w-5 text-zinc-500 transition-transform",
                          expanded ? "rotate-180" : "rotate-0",
                        ].join(" ")}
                      />
                    </div>
                  </button>

                  {expanded ? (
                    <div className="border-t border-zinc-200 px-4 py-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {card.headers.map((fieldName) => {
                          const value = card.row[fieldName] ?? "";
                          const flagged = isFlaggedValue(fieldName, value);
                          return (
                            <div key={`${card.id}:${fieldName}`} className="space-y-1">
                              <div className="text-xs text-zinc-500">
                                {fieldName}
                              </div>
                              <input
                                value={value}
                                onChange={(e) =>
                                  updatePolicyCell(card, fieldName, e.target.value)
                                }
                                className={[
                                  "h-10 w-full rounded-lg border px-3 text-sm outline-none",
                                  flagged
                                    ? "border-rose-200 bg-rose-50 focus:border-rose-300"
                                    : "border-zinc-200 bg-white focus:border-zinc-400",
                                ].join(" ")}
                              />
                            </div>
                          );
                        })}
                        <div className="space-y-1 sm:col-span-2">
                          <div className="text-xs text-zinc-500">报告来源</div>
                          <input
                            value={state.cardMeta[card.id]?.reportSource ?? reportId ?? ""}
                            onChange={(e) => setReportSource(card.id, e.target.value)}
                            className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400"
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">月度交费备忘录</div>
            <div className="text-xs text-zinc-500">
              来源：智能体输出表格（可核对修正“保费合计”）
            </div>
          </div>
        </div>

        {state.cardMeta[monthlyMemoCardId]?.monthlyPremiums?.length ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200">
            <div className="grid grid-cols-2 bg-zinc-50 px-4 py-2 text-xs font-medium text-zinc-600">
              <div>年月</div>
              <div className="text-right">保费合计</div>
            </div>
            <div className="divide-y divide-zinc-100">
              {(state.cardMeta[monthlyMemoCardId]?.monthlyPremiums ?? []).map((r) => (
                <div
                  key={r.yearMonth}
                  className="grid grid-cols-2 items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 truncate text-sm text-zinc-700">
                    {r.yearMonth}
                  </div>
                  <div className="flex items-center justify-end">
                    <input
                      value={r.totalPremium}
                      onChange={(e) => setMonthlyPremium(r.yearMonth, e.target.value)}
                      className="h-10 w-full max-w-[180px] rounded-lg border border-zinc-200 bg-white px-3 text-right text-sm tabular-nums outline-none focus:border-zinc-400"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
            暂未解析到“月度交费备忘录”
          </div>
        )}
      </div>

      <div className="pt-2">
        {confirmStats.confirmed > 0 ? (
          <button
            type="button"
            onClick={async () => {
              const basis =
                personaRequiredComplete && personaBasis
                  ? personaBasis
                  : persona.classificationBasis;
              const classification = persona.classification ?? (personaRequiredComplete ? classifyPersona(persona) : null);
              if (classification && basis) {
                const confirmedRows = getConfirmedPolicyRows(state.parsed, state.cardMeta);
                const scoreResult = computeProtectionScore({
                  persona: { ...persona, classification, classificationBasis: basis },
                  parsed: state.parsed,
                  confirmedPolicies: confirmedRows.map((r) => r.row),
                });
                if (scoreResult) {
                  await updateCaseScore(scoreResult.score, scoreResult.ratingLabel);
                }
              }
              router.push("/summary");
            }}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            确认无误，生成家庭汇总
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled
            className="flex h-12 w-full cursor-not-allowed items-center justify-center rounded-xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-400"
          >
            确认无误，生成家庭汇总
          </button>
        )}
      </div>
    </div>
  );
}
