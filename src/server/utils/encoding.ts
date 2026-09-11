export function normalizeUploadedFilename(filename: string) {
  try {
    const repaired = Buffer.from(filename, "latin1").toString("utf8");
    return repaired.includes("�") ? filename : repaired;
  } catch {
    return filename;
  }
}
