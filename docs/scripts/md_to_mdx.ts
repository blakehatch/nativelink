import type {
  Blockquote,
  Code,
  Heading,
  InlineCode,
  Paragraph,
  Root,
  RootContent,
  Text,
} from "mdast";
import { remark } from "remark";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";

const DEFAULT_TITLE = "Default Title";
const BLOCK_TYPES = ["caution", "note", "tip"];

export function parseMarkdown(markdown: string): Root {
  return remark().use(remarkParse).parse(markdown) as Root;
}

export function extractTitle(tree: Root): {
  title: string;
  content: RootContent[];
} {
  const { title, index } = extractTitleFromTree(tree);
  const content = removeTitleFromTree(tree, index);
  return { title, content };
}

function extractTitleFromTree(tree: Root): {
  title: string;
  index: number;
} {
  let title = DEFAULT_TITLE;
  let titleIndex = -1;

  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];
    if (node && node.type === "heading" && (node as Heading).depth === 1) {
      title = extractTextFromNode(node as Heading);
      titleIndex = i;
      break;
    }
  }

  return { title, index: titleIndex };
}

function removeTitleFromTree(tree: Root, index: number): RootContent[] {
  if (index >= 0) {
    return [
      ...tree.children.slice(0, index),
      ...tree.children.slice(index + 1),
    ];
  }
  return tree.children;
}

function extractTextFromNode(node: Heading | Paragraph): string {
  return (node.children as Text[]).map((child) => child.value).join("");
}

export function generateFrontMatter(
  title: string,
  description: string,
  pagefind: boolean,
): string {
  return `---
title: "${title}"
description: "${description}"
pagefind: ${pagefind}
---
`;
}

export function transformGithubMarkdown(content: RootContent[]): RootContent[] {
  return content.flatMap((node) => {
    if (node.type === "blockquote") {
      const transformed = transformBlockquote(node as Blockquote);
      if (transformed) {
        return [transformed];
      }
    }
    return [node];
  });
}

function transformBlockquote(blockquote: Blockquote): RootContent | null {
  const firstParagraph = blockquote.children[0] as Paragraph;
  const firstText = extractTextFromNode(firstParagraph).trim();

  const blockType = extractBlockType(firstText);
  if (blockType) {
    const contentText = extractBlockquoteContent(blockquote);
    const cleanedContentText = cleanBlockTypeFromContent(
      contentText,
      blockType,
      firstText.match(/^\[\!(\w+)\]/)?.[1] || "",
    );

    return {
      type: "html",
      value: `:::${blockType}\n${cleanedContentText}\n:::`,
    };
  }
  return null;
}

function extractBlockType(firstText: string): string | null {
  const match = firstText.match(/^\[\!(\w+)\]/);
  if (match?.[1]) {
    let blockType = match[1];
    if (blockType.toUpperCase() === "WARNING") {
      blockType = "caution";
    }
    blockType = blockType.toLowerCase();
    if (BLOCK_TYPES.includes(blockType)) {
      return blockType;
    }
  }
  return null;
}

function extractBlockquoteContent(blockquote: Blockquote): string {
  return blockquote.children
    .map((paragraph) => {
      if (paragraph.type === "paragraph") {
        return (paragraph as Paragraph).children
          .map((child) => {
            if (child.type === "text") {
              return (child as Text).value;
            }
            if (child.type === "inlineCode") {
              return `\`${(child as InlineCode).value}\``;
            }
            return "";
          })
          .join("");
      }
      if (paragraph.type === "code") {
        return `\`${(paragraph as Code).value}\``;
      }
      return "";
    })
    .join("\n");
}

function cleanBlockTypeFromContent(
  contentText: string,
  blockType: string,
  originalBlockType: string,
): string {
  return contentText
    .replace(`[!${blockType.toUpperCase()}]`, "")
    .replace(`[!${originalBlockType.toUpperCase()}]`, "")
    .trim();
}

export function preserveInlineCode(content: RootContent[]): RootContent[] {
  visit({ type: "root", children: content } as Root, "text", (node: Text) => {
    node.value = node.value.replace(/\\/g, "");
  });
  return content;
}

export function preProcessMarkdown(markdown: string): string {
  const processed = markdown
    .replace(/<!--\s*vale\s+(on|off)\s*-->/g, "")
    .replace(/<!--\s*generated by git-cliff\s*-->/g, "");

  const lines = processed.split("\n");
  const processedLines = [];
  let inMermaidBlock = false;
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```mermaid")) {
      inMermaidBlock = true;
      processedLines.push(line);
      continue;
    }
    if (inMermaidBlock && line.trim() === "```") {
      inMermaidBlock = false;
      processedLines.push(line);
      continue;
    }

    if (line.trim().startsWith("```") && !inMermaidBlock) {
      inCodeBlock = !inCodeBlock;
      processedLines.push(line);
      continue;
    }

    if (inMermaidBlock || inCodeBlock) {
      processedLines.push(line);
      continue;
    }

    if (
      line.trim().startsWith(">") ||
      /^\[!(TIP|NOTE|WARNING|IMPORTANT|CAUTION)\]/.test(line)
    ) {
      processedLines.push(line);
      continue;
    }

    const htmlTagPattern = /^[<\s][^>]*>/g;
    if (htmlTagPattern.test(line)) {
      processedLines.push(line);
    } else {
      processedLines.push(line.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
  }

  return processedLines.join("\n");
}

export async function transformMarkdownToMdx(
  markdown: string,
  description: string,
  pagefind = true,
): Promise<string> {
  const preprocessedMarkdown = preProcessMarkdown(markdown);
  const tree = parseMarkdown(preprocessedMarkdown);
  const { title, content } = extractTitle(tree);

  let transformedContent = transformGithubMarkdown(content);
  transformedContent = preserveInlineCode(transformedContent);

  const modifiedMarkdown = remark()
    .use(remarkStringify)
    .stringify({ type: "root", children: transformedContent });

  const processedMdx = await remark()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkStringify)
    .process(modifiedMarkdown);

  const frontMatter = generateFrontMatter(title, description, pagefind);
  return frontMatter + String(processedMdx);
}
