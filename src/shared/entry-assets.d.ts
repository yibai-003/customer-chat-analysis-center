export interface EntryAssets {
  scripts: string[];
  styles: string[];
}

export function extractEntryAssets(html: unknown): EntryAssets;
