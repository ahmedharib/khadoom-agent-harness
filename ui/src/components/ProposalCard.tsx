import React, { useState } from "react";
import { StagingSession, SemanticChangeItem } from "../types.js";
import {
  Check,
  X,
  Edit3,
  ShieldCheck,
  ArrowRight,
  CornerDownLeft,
} from "lucide-react";

interface ProposalCardProps {
  session: StagingSession;
  onAccept: (sessionId: string) => Promise<void>;
  onReject: (sessionId: string) => Promise<void>;
  onModify: (sessionId: string, feedback: string) => Promise<void>;
  isLoading: boolean;
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function formatDiffValue(val: any): React.ReactNode {
  if (val === undefined) return null;
  if (val === null) return "null";

  if (typeof val === "boolean") {
    return val ? "Enabled" : "Disabled";
  }

  if (typeof val === "number") {
    return String(val);
  }

  if (typeof val === "string") {
    const trimmed = val.trim();
    if (HEX_COLOR_RE.test(trimmed)) {
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span
            style={{
              width: "11px",
              height: "11px",
              borderRadius: "3px",
              backgroundColor: trimmed,
              border: "1px solid rgba(255, 255, 255, 0.25)",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          <code style={{ fontFamily: "monospace", fontSize: "11.5px" }}>{trimmed}</code>
        </span>
      );
    }
    return trimmed.length > 42 ? `'${trimmed.slice(0, 42)}…'` : `'${trimmed}'`;
  }

  if (Array.isArray(val)) {
    if (val.every((v) => typeof v === "string" || typeof v === "number")) {
      return `[${val.join(", ")}]`;
    }
    return `${val.length} item${val.length === 1 ? "" : "s"}`;
  }

  if (typeof val === "object") {
    const label = val.title || val.name || val.label || val.id;
    const parts: string[] = [];
    if (label) parts.push(String(label));
    if (typeof val.price === "number") parts.push(`${val.price}`);
    if (Array.isArray(val.countries)) parts.push(`(${val.countries.join(", ")})`);
    if (Array.isArray(val.rates) && val.rates.length > 0) {
      const firstRate = val.rates[0];
      if (firstRate?.name !== undefined && firstRate?.price !== undefined) {
        parts.push(`• ${firstRate.name}: ${firstRate.price}`);
      }
    }
    if (parts.length > 0) return parts.join(" ");
    const json = JSON.stringify(val);
    return json.length > 48 ? `${json.slice(0, 48)}…` : json;
  }

  return String(val);
}

export const ProposalCard: React.FC<ProposalCardProps> = ({
  session,
  onAccept,
  onReject,
  onModify,
  isLoading,
}) => {
  const [showModifyInput, setShowModifyInput] = useState(false);
  const [feedback, setFeedback] = useState("");

  const isPending = session.status === "pending";
  const isCommitted = session.status === "committed";
  const isRejected = session.status === "rejected";

  // Build normalized diff rows from semanticChanges (with fallback to raw patches if needed)
  const diffItems: SemanticChangeItem[] =
    session.semanticChanges && session.semanticChanges.length > 0
      ? session.semanticChanges
      : (session.patches || []).map((p) => ({
          category: "general",
          path: p.path,
          operation: p.op,
          summary: `${p.op.toUpperCase()} ${p.path}`,
          details: { newValue: p.value },
        }));

  const handleModifySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback.trim()) return;
    onModify(session.sessionId, feedback.trim());
    setShowModifyInput(false);
  };

  return (
    <div
      style={{
        marginTop: "12px",
        backgroundColor: "var(--surface-indigo)",
        border: `1px solid ${
          isCommitted
            ? "var(--status-emerald)"
            : isRejected
            ? "var(--border-subtle)"
            : "var(--border-indigo)"
        }`,
        borderRadius: "14px",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        transition: "all 0.2s ease",
      }}
    >
      {/* Header with Status Badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ShieldCheck size={16} color="var(--accent-lavender)" />
          <span
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "var(--text-white)",
            }}
          >
            Proposed Store Changes ({diffItems.length})
          </span>
        </div>

        {isCommitted ? (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "var(--status-emerald)",
              backgroundColor: "rgba(110, 231, 183, 0.12)",
              padding: "3px 10px",
              borderRadius: "9999px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <Check size={12} /> Committed to v{session.stagedStore.version}
          </span>
        ) : isRejected ? (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-muted)",
              backgroundColor: "rgba(255, 255, 255, 0.05)",
              padding: "3px 10px",
              borderRadius: "9999px",
            }}
          >
            Rejected
          </span>
        ) : (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--accent-lavender)",
              backgroundColor: "rgba(165, 148, 249, 0.12)",
              border: "1px solid rgba(165, 148, 249, 0.25)",
              padding: "3px 10px",
              borderRadius: "9999px",
            }}
          >
            Staged Preview (Base v{session.baseVersion})
          </span>
        )}
      </div>

      {/* Explanation */}
      <p
        style={{
          margin: 0,
          fontSize: "13px",
          color: "var(--text-secondary)",
          lineHeight: "1.45",
        }}
      >
        {session.explanation}
      </p>

      {/* Semantic Diff Rows */}
      <div
        style={{
          backgroundColor: "var(--surface-charcoal)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "10px",
          overflow: "hidden",
        }}
      >
        {diffItems.map((change, idx) => {
          const op = (change.operation || "replace").toLowerCase();
          const opLabel = op === "replace" ? "MODIFY" : op.toUpperCase();
          const oldVal = change.details?.oldValue;
          const newVal = change.details?.newValue;
          const hasOld = oldVal !== undefined;
          const hasNew = newVal !== undefined;

          return (
            <div
              key={idx}
              style={{
                padding: "11px 14px",
                borderBottom:
                  idx === diffItems.length - 1
                    ? "none"
                    : "1px solid var(--border-subtle)",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              {/* Top line: Operation badge + Category pill + Human summary */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "7px",
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.03em",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      flexShrink: 0,
                      backgroundColor:
                        op === "add"
                          ? "rgba(110, 231, 183, 0.15)"
                          : op === "remove"
                          ? "rgba(217, 155, 82, 0.18)"
                          : "rgba(165, 148, 249, 0.15)",
                      color:
                        op === "add"
                          ? "var(--status-emerald)"
                          : op === "remove"
                          ? "var(--status-amber)"
                          : "var(--accent-lavender)",
                    }}
                  >
                    {opLabel}
                  </span>

                  {change.category && (
                    <span
                      style={{
                        fontSize: "10.5px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        color: "var(--text-secondary)",
                        backgroundColor: "rgba(255, 255, 255, 0.04)",
                        padding: "2px 7px",
                        borderRadius: "9999px",
                        flexShrink: 0,
                      }}
                    >
                      {change.category}
                    </span>
                  )}

                  <span
                    style={{
                      fontSize: "12.5px",
                      color: "var(--text-white)",
                      fontWeight: 500,
                      lineHeight: "1.4",
                    }}
                  >
                    {change.summary}
                  </span>
                </div>

                {/* Before -> After Value Diff Pill */}
                {(hasOld || hasNew) && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "12px",
                      fontVariantNumeric: "tabular-nums",
                      backgroundColor: "rgba(255, 255, 255, 0.02)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "9999px",
                      padding: "3px 10px",
                      flexShrink: 0,
                    }}
                  >
                    {hasOld && hasNew ? (
                      <>
                        <span
                          style={{
                            color: "var(--text-muted)",
                            textDecoration: "line-through",
                          }}
                        >
                          {formatDiffValue(oldVal)}
                        </span>
                        <ArrowRight size={11} color="var(--text-secondary)" />
                        <span
                          style={{
                            color: "var(--status-emerald)",
                            fontWeight: 600,
                          }}
                        >
                          {formatDiffValue(newVal)}
                        </span>
                      </>
                    ) : hasNew ? (
                      <span
                        style={{
                          color: "var(--status-emerald)",
                          fontWeight: 600,
                        }}
                      >
                        + {formatDiffValue(newVal)}
                      </span>
                    ) : (
                      <span
                        style={{
                          color: "var(--status-amber)",
                          textDecoration: "line-through",
                        }}
                      >
                        {formatDiffValue(oldVal)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Subtle target path */}
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  fontFamily: "monospace",
                }}
              >
                {change.path}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action Buttons for Pending State */}
      {isPending && (
        <div>
          {!showModifyInput ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {/* Primary Action Pill */}
              <button
                onClick={() => onAccept(session.sessionId)}
                disabled={isLoading}
                style={{
                  flex: 1,
                  height: "38px",
                  backgroundColor: "var(--accent-lavender)",
                  color: "var(--accent-dark)",
                  border: "none",
                  borderRadius: "9999px",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: isLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px",
                  transition: "opacity 0.15s ease",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.9")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
              >
                <Check size={15} strokeWidth={2.5} />
                <span>Accept Changes</span>
              </button>

              {/* Modify Outlined Pill */}
              <button
                onClick={() => setShowModifyInput(true)}
                disabled={isLoading}
                style={{
                  height: "38px",
                  padding: "0 16px",
                  backgroundColor: "transparent",
                  color: "var(--text-white)",
                  border: "1px solid var(--border-secondary)",
                  borderRadius: "9999px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: isLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = "transparent")
                }
              >
                <Edit3 size={13} />
                <span>Modify</span>
              </button>

              {/* Reject Outlined Pill */}
              <button
                onClick={() => onReject(session.sessionId)}
                disabled={isLoading}
                style={{
                  height: "38px",
                  padding: "0 14px",
                  backgroundColor: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "9999px",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: isLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
                  e.currentTarget.style.color = "var(--text-white)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = "var(--text-secondary)";
                }}
              >
                <X size={14} />
                <span>Reject</span>
              </button>
            </div>
          ) : (
            <form
              onSubmit={handleModifySubmit}
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder="How would you like to tweak this proposal? (e.g. set price to 45 instead)"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                style={{
                  flex: 1,
                  height: "38px",
                  backgroundColor: "var(--surface-charcoal)",
                  border: "1px solid var(--border-secondary)",
                  borderRadius: "9999px",
                  padding: "0 16px",
                  color: "var(--text-white)",
                  fontSize: "13px",
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={isLoading || !feedback.trim()}
                style={{
                  height: "38px",
                  padding: "0 16px",
                  backgroundColor: "var(--accent-lavender)",
                  color: "var(--accent-dark)",
                  border: "none",
                  borderRadius: "9999px",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: isLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span>Update</span>
                <CornerDownLeft size={13} />
              </button>
              <button
                type="button"
                onClick={() => setShowModifyInput(false)}
                style={{
                  height: "38px",
                  padding: "0 12px",
                  backgroundColor: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "9999px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
