import type { ReactNode } from "react";

function inlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

export function MarkdownPreview({ value }: { value: string }) {
  const lines = value.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const listMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (listMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[-*]\s+(.+)/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }
    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)/);
    if (orderedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*\d+\.\s+(.+)/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }
    const headingMatch = line.match(/^\s*(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const Heading = `h${headingMatch[1].length}` as "h1" | "h2" | "h3";
      blocks.push(<Heading key={`heading-${index}`}>{inlineMarkdown(headingMatch[2])}</Heading>);
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      blocks.push(<blockquote key={`quote-${index}`}>{inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>);
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^\s*(#{1,3})\s+/.test(lines[index]) && !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*\d+\.\s+/.test(lines[index]) && !lines[index].startsWith(">")) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{paragraph.map((item, itemIndex) => <span key={itemIndex}>{item}{itemIndex < paragraph.length - 1 && <br />}</span>)}</p>);
  }

  return <div className="markdown-preview">{blocks.length ? blocks : <span className="muted">暂无 Markdown 内容</span>}</div>;
}
