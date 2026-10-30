import React from "react";

interface FormattedMessageProps {
  content: string;
  style?: React.CSSProperties;
}

/**
 * Parses inline formatting:
 * **bold**, `code`, *italic*
 */
function parseInline(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  // Match **bold**, `code`, or *italic*
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      tokens.push(text.slice(lastIdx, match.index));
    }

    const raw = match[0];
    const key = `${match.index}_${raw}`;

    if (raw.startsWith("**") && raw.endsWith("**") && raw.length >= 4) {
      tokens.push(
        <strong
          key={key}
          style={{
            color: "var(--text-white)",
            fontWeight: 700,
          }}
        >
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith("`") && raw.endsWith("`") && raw.length >= 2) {
      tokens.push(
        <code
          key={key}
          style={{
            backgroundColor: "rgba(165, 148, 249, 0.14)",
            color: "var(--accent-lavender)",
            padding: "1px 6px",
            borderRadius: "4px",
            fontSize: "12px",
            fontFamily: "monospace",
            border: "1px solid rgba(165, 148, 249, 0.25)",
          }}
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith("*") && raw.endsWith("*") && raw.length >= 2) {
      tokens.push(
        <em
          key={key}
          style={{
            color: "var(--text-white)",
            fontStyle: "italic",
          }}
        >
          {raw.slice(1, -1)}
        </em>
      );
    }

    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    tokens.push(text.slice(lastIdx));
  }

  return tokens.length > 0 ? tokens : [text];
}

/**
 * Formats Markdown responses into structured HTML elements:
 * - Headings (#, ##, ###)
 * - Bullet lists (- item, * item)
 * - Numbered lists (1. item)
 * - Paragraphs with bold & code highlights
 */
export const FormattedMessage: React.FC<FormattedMessageProps> = ({
  content,
  style,
}) => {
  if (!content) return null;

  // Split into lines to detect lists and headings
  const rawLines = content.split(/\r?\n/);
  const elements: React.ReactNode[] = [];

  let currentList: { type: "ul" | "ol"; items: React.ReactNode[] } | null = null;

  const flushList = () => {
    if (!currentList) return;
    const ListTag = currentList.type;
    elements.push(
      <ListTag
        key={`list_${elements.length}`}
        style={{
          margin: "6px 0 10px 0",
          paddingLeft: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          color: "var(--text-white)",
        }}
      >
        {currentList.items.map((item, idx) => (
          <li key={idx} style={{ lineHeight: "1.5" }}>
            {item}
          </li>
        ))}
      </ListTag>
    );
    currentList = null;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // Empty line -> flush list and skip
    if (!trimmed) {
      flushList();
      continue;
    }

    // Headings (###, ##, #)
    if (trimmed.startsWith("### ")) {
      flushList();
      elements.push(
        <h4
          key={`h4_${i}`}
          style={{
            margin: "12px 0 6px 0",
            fontSize: "14px",
            fontWeight: 700,
            color: "var(--text-white)",
          }}
        >
          {parseInline(trimmed.replace(/^###\s+/, ""))}
        </h4>
      );
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushList();
      elements.push(
        <h3
          key={`h3_${i}`}
          style={{
            margin: "14px 0 6px 0",
            fontSize: "15px",
            fontWeight: 700,
            color: "var(--text-white)",
          }}
        >
          {parseInline(trimmed.replace(/^##\s+/, ""))}
        </h3>
      );
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flushList();
      elements.push(
        <h2
          key={`h2_${i}`}
          style={{
            margin: "16px 0 8px 0",
            fontSize: "16px",
            fontWeight: 800,
            color: "var(--text-white)",
          }}
        >
          {parseInline(trimmed.replace(/^#\s+/, ""))}
        </h2>
      );
      continue;
    }

    // Bullet list item (- item, * item)
    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      if (!currentList || currentList.type !== "ul") {
        flushList();
        currentList = { type: "ul", items: [] };
      }
      currentList.items.push(parseInline(bulletMatch[1]));
      continue;
    }

    // Numbered list item (1. item)
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      if (!currentList || currentList.type !== "ol") {
        flushList();
        currentList = { type: "ol", items: [] };
      }
      currentList.items.push(parseInline(numMatch[2]));
      continue;
    }

    // Normal text paragraph
    flushList();
    elements.push(
      <p
        key={`p_${i}`}
        style={{
          margin: "0 0 8px 0",
          lineHeight: "1.55",
          color: "var(--text-white)",
        }}
      >
        {parseInline(trimmed)}
      </p>
    );
  }

  flushList();

  return (
    <div
      style={{
        fontSize: "13.5px",
        color: "var(--text-white)",
        ...style,
      }}
    >
      {elements}
    </div>
  );
};
