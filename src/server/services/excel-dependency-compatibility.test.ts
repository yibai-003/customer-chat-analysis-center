import ExcelJS from "exceljs";
import unzipper from "unzipper";
import { describe, expect, it } from "vitest";

describe("Excel dependency compatibility", () => {
  it("round-trips screenshots and creates unique extended-format IDs through the CommonJS uuid API", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("退款分析");
    sheet.addRow(["退款金额", "截图"]); sheet.addRow([23, "证据"]); sheet.addRow([45, "复核"]);
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    sheet.addImage(workbook.addImage({ buffer: pixel as any, extension: "png" }), "B2:B2");
    for (const ref of ["A2:A3", "B2:B3"]) {
      sheet.addConditionalFormatting({ ref, rules: [{ type: "iconSet", iconSet: "3Stars", priority: 1,
        cfvo: [{ type: "percent", value: 0 }, { type: "percent", value: 33 }, { type: "percent", value: 67 }] }] });
    }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const archive = await unzipper.Open.buffer(bytes);
    const xml = (await archive.files.find(file => file.path === "xl/worksheets/sheet1.xml")!.buffer()).toString("utf8");
    const ids = [...xml.matchAll(/<x14:cfRule[^>]*\bid="\{([0-9a-f-]+)\}"/gi)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const restored = new ExcelJS.Workbook(); await restored.xlsx.load(bytes as any);
    expect(restored.worksheets[0].name).toBe("退款分析");
    expect(restored.worksheets[0].getCell("A2").value).toBe(23);
    expect(restored.worksheets[0].getCell("B2").value).toBe("证据");
    const images = restored.worksheets[0].getImages(); expect(images).toHaveLength(1);
    expect(Buffer.from(restored.getImage(Number(images[0].imageId)).buffer!)).toEqual(pixel);
  });
});
