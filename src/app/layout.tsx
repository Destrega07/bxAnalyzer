import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { CaseProvider } from "@/context/CaseContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <CaseProvider>
          <AppShell>{children}</AppShell>
        </CaseProvider>
      </body>
    </html>
  );
}
