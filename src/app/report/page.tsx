export default function ReportPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">报告预览</h1>
        <p className="text-sm text-zinc-600">
          这里将展示生成后的《家庭保单报告》，支持后续渲染导出为 H5/PDF。
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
        页面骨架已就绪：后续在此对接智能分析结果与渲染模板。
      </div>
    </div>
  );
}
