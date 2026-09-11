import type { ReactNode } from "react";

export function Modal({ title, subtitle, children, close, className = "" }: { title: string; subtitle: string; children: ReactNode; close: () => void; className?: string }) {
  return <div className={`backdrop ${className}`.trim()} onClick={close}><div className="modal" onClick={(event) => event.stopPropagation()}><header><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={close}>×</button></header>{children}</div></div>;
}
