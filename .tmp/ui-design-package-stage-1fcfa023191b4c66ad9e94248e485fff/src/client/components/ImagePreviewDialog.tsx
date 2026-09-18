import { useEffect, useState } from "react";

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;

export function ImagePreviewDialog({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const changeZoom = (amount: number) => {
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((current + amount).toFixed(2)))));
  };

  return (
    <div
      className="image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <div className="image-preview-panel" onClick={(event) => event.stopPropagation()}>
        <header className="image-preview-header">
          <div>
            <small>ORIGINAL CHAT SCREENSHOT</small>
            <strong>{alt}</strong>
          </div>
          <button type="button" aria-label="关闭图片预览" title="关闭" onClick={onClose}>×</button>
        </header>
        <div className="image-preview-stage">
          <img
            src={src}
            alt={alt}
            draggable={false}
            style={{ transform: `scale(${zoom})` }}
          />
        </div>
        <footer className="image-preview-controls">
          <button type="button" aria-label="缩小图片" title="缩小" onClick={() => changeZoom(-0.25)} disabled={zoom <= MIN_ZOOM}>−</button>
          <output aria-label="当前缩放比例">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大图片" title="放大" onClick={() => changeZoom(0.25)} disabled={zoom >= MAX_ZOOM}>＋</button>
          <button type="button" aria-label="适应窗口" title="适应窗口" onClick={() => setZoom(1)}>适应窗口</button>
        </footer>
      </div>
    </div>
  );
}
