export class UploadError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
