import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { CaseProvider } from "@/context/CaseContext";

export const metadata: Metadata = {
  title: "IPIS - 保险保单智能检视系统",
  description:
    "Insurance Policy Intelligence System：将银保保单检视报告解析为可编辑与可生成报告的数据工作流。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <CaseProvider>
          <AppShell>{children}</AppShell>
        </CaseProvider>
      </body>
    </html>
  );
}
