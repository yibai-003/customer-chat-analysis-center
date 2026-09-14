import fs from "node:fs";
import express from "express";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { createSafeUpload, UploadError } from "./upload-safety";
import { diskReservations } from "./disk-reservations";

afterEach(() => vi.restoreAllMocks());
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Upload did not settle");
}
describe("simultaneous real uploads", () => {
  it("rejects overcommitted requests, then releases a disconnected upload and accepts a new one", async () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const app = express(); const upload = createSafeUpload();
    app.post("/upload", upload.single("file"), (req, res) => { if (req.file) fs.unlinkSync(req.file.path); res.json({ ok: true }); });
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof UploadError ? error.status : 400).json({ error: error.message }));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const root = `${config.dataDir}/uploads`; const before = fs.readdirSync(root);
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: config.minFreeDiskMb * 1048576 + 3000, bsize: 1 } as any);
    const req = http.request({ hostname: "127.0.0.1", port, path: "/upload", method: "POST",
      headers: { "content-length": 2500, "content-type": "multipart/form-data; boundary=test" } });
    req.on("error", () => {});
    try {
      req.write('--test\r\nContent-Disposition: form-data; name="file"; filename="test.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\nx');
      await until(() => diskReservations.reservedBytes > 2000);
      const form = new FormData(); form.append("file", new Blob(["x".repeat(1200)]), "test.xlsx");
      expect((await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: form })).status).toBe(507);
      req.destroy(); await until(() => diskReservations.activeReservations === 0);
      expect(fs.readdirSync(root)).toEqual(before);
      const next = new FormData(); next.append("file", new Blob(["x".repeat(1200)]), "test.xlsx");
      expect((await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: next })).status).toBe(200);
      expect(diskReservations.activeReservations).toBe(0); expect(fs.readdirSync(root)).toEqual(before);
    } finally { req.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
