function findTagEnd(source, start) {
  let quote;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return source.length;
}

function firstAttributeValue(source, start, end, targetName) {
  const seen = new Set();
  let index = start;

  while (index < end) {
    while (index < end && /\s/.test(source[index])) index += 1;
    if (source[index] === "/") {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (index < end && !/[\s=/>]/.test(source[index])) index += 1;
    if (nameStart === index) {
      index += 1;
      continue;
    }

    const name = source.slice(nameStart, index).toLowerCase();
    const isFirst = !seen.has(name);
    seen.add(name);
    while (index < end && /\s/.test(source[index])) index += 1;

    let value = "";
    if (source[index] === "=") {
      index += 1;
      while (index < end && /\s/.test(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < end && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (index < end) index += 1;
      } else {
        const valueStart = index;
        while (index < end && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }

    if (isFirst && name === targetName) return value;
  }

  return undefined;
}

function normalizeAssetPath(value, extension) {
  const trimmed = value.trim();
  const suffixIndex = trimmed.search(/[?#]/);
  let assetPath = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);

  let previous;
  do {
    previous = assetPath;
    assetPath = assetPath.replace(/^\/+/, "").replace(/^\.\/+/, "");
  } while (assetPath !== previous);

  return assetPath.toLowerCase().endsWith(extension) ? assetPath : undefined;
}

function findRawTextClosingTag(sourceLower, start, tagName) {
  const needle = `</${tagName}`;
  let index = sourceLower.indexOf(needle, start);
  while (index !== -1) {
    const boundary = sourceLower[index + needle.length];
    if (boundary === undefined || /[\s/>]/.test(boundary)) return index;
    index = sourceLower.indexOf(needle, index + needle.length);
  }
  return -1;
}

export function extractEntryAssets(html) {
  const source = String(html);
  const sourceLower = source.toLowerCase();
  const assets = { scripts: [], styles: [] };
  const seen = { scripts: new Set(), styles: new Set() };
  let cursor = 0;

  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening === -1) break;

    if (source.startsWith("<!--", opening)) {
      const commentEnd = source.indexOf("-->", opening + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    const marker = source[opening + 1];
    if (
      marker === undefined
      || marker === "/"
      || marker === "!"
      || marker === "?"
      || /\s/.test(marker)
    ) {
      cursor = marker === "!" || marker === "?"
        ? findTagEnd(source, opening + 2) + 1
        : opening + 1;
      continue;
    }

    let index = opening + 1;
    if (!/[A-Za-z]/.test(source[index])) {
      cursor = opening + 1;
      continue;
    }
    const nameStart = index;
    while (index < source.length && /[A-Za-z0-9:-]/.test(source[index])) index += 1;
    const tagName = source.slice(nameStart, index).toLowerCase();
    const tagEnd = findTagEnd(source, index);

    const definition = tagName === "script"
      ? { attribute: "src", extension: ".js", collection: "scripts" }
      : tagName === "link"
        ? { attribute: "href", extension: ".css", collection: "styles" }
        : undefined;
    if (definition) {
      const value = firstAttributeValue(
        source,
        index,
        tagEnd,
        definition.attribute,
      );
      const assetPath = value === undefined
        ? undefined
        : normalizeAssetPath(value, definition.extension);
      if (assetPath && !seen[definition.collection].has(assetPath)) {
        seen[definition.collection].add(assetPath);
        assets[definition.collection].push(assetPath);
      }
    }

    if (tagName === "script" || tagName === "style") {
      const closing = findRawTextClosingTag(sourceLower, tagEnd + 1, tagName);
      cursor = closing === -1
        ? source.length
        : findTagEnd(source, closing + tagName.length + 2) + 1;
    } else {
      cursor = tagEnd + 1;
    }
  }

  return assets;
}
