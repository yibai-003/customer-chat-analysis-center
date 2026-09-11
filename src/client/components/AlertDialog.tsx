import { Modal } from "./Modal";

export function AlertDialog({ title = "操作提示", message, close }: { title?: string; message: string; close: () => void }) {
  return <Modal title={title} subtitle="PIXEL OPERATIONS / NOTICE" close={close}>
    <div className="confirm-dialog"><span className="confirm-icon">i</span><p>{message}</p></div>
    <div className="modal-actions"><button className="button dark" onClick={close}>知道了</button></div>
  </Modal>;
}
