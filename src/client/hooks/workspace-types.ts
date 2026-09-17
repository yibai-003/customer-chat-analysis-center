export interface JobOperationToken {
  operationId: number;
  jobId: string | null;
  generation: number;
}

export interface JobOperationHelpers {
  captureJobOperation: () => JobOperationToken;
  isJobOperationCurrent: (token: JobOperationToken) => boolean;
  startBusyOperation: (token: JobOperationToken) => void;
  finishBusyOperation: (token: JobOperationToken) => void;
  startTaskActionOperation: (token: JobOperationToken) => void;
  finishTaskActionOperation: (token: JobOperationToken) => void;
}
