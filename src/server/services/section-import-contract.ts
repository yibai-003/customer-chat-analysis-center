import type { GenericImportContract } from "../../shared/types";
import { excelHeaderMatches } from "./excel-template-service";
import { getSectionVersion } from "./section-config-version-service";
import { sectionBusinessRules } from "./section-business-rules";

export interface SectionImportContractInput {
  id: string;
  sourceFields?: string[];
  sectionConfigVersionId?: string;
}

function isGenericImportContract(value: unknown): value is GenericImportContract {
  if (!value || typeof value !== "object") return false;
  const contract = value as Partial<GenericImportContract>;
  return typeof contract.imageColumn === "string"
    && (contract.imageColumnRequired === undefined || typeof contract.imageColumnRequired === "boolean")
    && Array.isArray(contract.requiredColumns)
    && Array.isArray(contract.optionalColumns)
    && contract.requiredColumns.every((item) => typeof item === "string")
    && contract.optionalColumns.every((item) => typeof item === "string");
}

export function resolveGenericImportContract(
  section?: SectionImportContractInput,
): GenericImportContract | undefined {
  if (!section || section.id === "reception") return undefined;
  const version = section.sectionConfigVersionId
    ? getSectionVersion(section.sectionConfigVersionId)
    : undefined;
  if (section.sectionConfigVersionId) {
    if (!version || version.sectionId !== section.id) {
      throw new Error("解析板块配置版本不匹配");
    }
    if (version.status !== "published") {
      throw new Error("解析板块配置版本必须是已发布版本");
    }
  }
  const configured = version?.businessRules;
  const snapshotContract = configured && typeof configured === "object"
    ? (configured as { kind?: unknown; importContract?: unknown })
    : undefined;
  const snapshotImportContract = snapshotContract?.importContract;
  if (snapshotContract?.kind === "generic" && isGenericImportContract(snapshotImportContract)) {
    const imageColumnRequired = typeof snapshotImportContract.imageColumnRequired === "boolean"
      ? snapshotImportContract.imageColumnRequired
      : (version?.sectionSnapshot.sourceFields ?? []).some((field) =>
        excelHeaderMatches(field, snapshotImportContract.imageColumn));
    return { ...snapshotImportContract, imageColumnRequired };
  }
  const sourceFields = version?.sectionSnapshot.sourceFields ?? section.sourceFields ?? [];
  const fallback = sectionBusinessRules(section.id, sourceFields) as {
    importContract?: unknown;
  };
  return isGenericImportContract(fallback.importContract)
    ? fallback.importContract
    : undefined;
}

export function missingGenericImportHeaders(
  headers: string[],
  contract: GenericImportContract,
): string[] {
  const required = [contract.imageColumn, ...contract.requiredColumns];
  if (contract.imageColumnRequired === false) required.shift();
  return required.filter((expected, index) => required.indexOf(expected) === index
    && !headers.some((actual) => excelHeaderMatches(actual, expected)));
}

export function missingGenericImportHeadersBySheet(
  sheets: Array<{ name: string; headers: string[]; hasImageAnchors: boolean }>,
  contract: GenericImportContract,
): Array<{ sheetName: string; headers: string[] }> {
  return sheets
    .filter((sheet) => sheet.hasImageAnchors
      || sheet.headers.some((header) => excelHeaderMatches(header, contract.imageColumn)))
    .map((sheet) => ({
      sheetName: sheet.name,
      headers: missingGenericImportHeaders(sheet.headers, contract),
    }))
    .filter((sheet) => sheet.headers.length > 0);
}
