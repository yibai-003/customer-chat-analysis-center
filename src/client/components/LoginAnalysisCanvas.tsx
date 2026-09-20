import { BotanicalArt } from "./BotanicalArt";
import { WaterRippleCanvas } from "./WaterRippleCanvas";

const workflowStages = [
  { label: "导入记录", meta: "XLSX / SOURCE" },
  { label: "图像读取", meta: "VISION / OCR" },
  { label: "字段解析", meta: "MODEL / RULES" },
  { label: "人工复核", meta: "REVIEW / EXPORT" },
];

export function LoginAnalysisCanvas() {
  return (
    <aside className="signin-analysis-canvas signin-analysis-canvas--left" aria-hidden="true">
      <div className="signin-canvas-grid" />
      <WaterRippleCanvas />
      <header className="signin-canvas-header signin-ripple-pass-through">
        <div>
          <small>LOCAL ANALYSIS WORKSPACE</small>
          <strong>客服记录解析流程</strong>
        </div>
        <span className="signin-canvas-status"><i /> 服务端已连接</span>
      </header>

      <div className="signin-canvas-stage signin-ripple-pass-through">
        <div className="signin-workflow">
          {workflowStages.map((stage, index) => (
            <div className="signin-workflow-step" key={stage.label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{stage.label}</strong>
                <small>{stage.meta}</small>
              </div>
            </div>
          ))}
        </div>
        <BotanicalArt variant="single-specimen" />
      </div>

      <footer className="signin-canvas-footer signin-ripple-pass-through">
        <span>INTERNAL NETWORK</span>
        <span>ANALYSIS READY</span>
      </footer>
    </aside>
  );
}
