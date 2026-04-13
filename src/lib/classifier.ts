import type { CustomerClassification, CustomerClassificationId, CustomerPersona } from "@/lib/db";

export function classifyPersona(persona: CustomerPersona): CustomerClassification | null {
  const ageRange = persona.ageRange;
  const marital = persona.maritalStatus;
  const children = persona.childrenStatus;

  if (ageRange === "0~18") return { id: "minor", label: "未成年者" };
  if (ageRange === "50以上") return { id: "senior", label: "资深长者" };

  const isAdultAge =
    ageRange === "19~30" || ageRange === "25~35" || ageRange === "31~50";
  if (isAdultAge) {
    if (marital === "已婚" && children === "有孩") return { id: "pillar", label: "家庭支柱" };
    if (marital === "已婚" && children === "无孩") return { id: "couple", label: "二人世界" };
    if (marital === "未婚") return { id: "single", label: "单身贵族" };
  }

  return null;
}

export function getClassificationPillClasses(id: CustomerClassificationId) {
  const base = "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium";
  if (id === "pillar") return `${base} border-blue-200 bg-blue-600 text-white`;
  if (id === "single") return `${base} border-emerald-200 bg-emerald-100 text-emerald-800`;
  if (id === "minor") return `${base} border-orange-200 bg-orange-100 text-orange-800`;
  if (id === "senior") return `${base} border-violet-200 bg-violet-100 text-violet-800`;
  return `${base} border-rose-200 bg-rose-100 text-rose-800`;
}
