import { Modal } from "./Modal";

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确认删除",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <Modal title={title} subtitle="PIXEL OPERATIONS / CONFIRM ACTION" close={onCancel}>
    <div className="confirm-dialog"><span className="confirm-icon danger">!</span><p>{message}</p></div>
    <div className="modal-actions"><button className="button light" onClick={onCancel}>取消</button><button className="button danger-button" onClick={onConfirm}>{confirmLabel}</button></div>
  </Modal>;
}
