import React, { useState, useRef, useEffect } from "react";
import { AgentStep, ChatMessage } from "../types.js";
import { ProposalCard } from "./ProposalCard.js";
import { KhadoomIcon } from "./KhadoomIcon.js";
import { FormattedMessage } from "./FormattedMessage.js";
import { PulsatingDots, TextShimmer } from "./LoadingIndicator.js";
import {
  Send,
  User,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Highlighter,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

function renderHighlightedPassage(content: string, matchedExcerpts: string[]): React.ReactNode {
  if (!matchedExcerpts || matchedExcerpts.length === 0) {
    return content;
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const excerpt of matchedExcerpts) {
    if (!excerpt) continue;
    let idx = content.indexOf(excerpt);
    if (idx === -1) {
      idx = content.toLowerCase().indexOf(excerpt.toLowerCase());
    }
    if (idx !== -1) {
      ranges.push({ start: idx, end: idx + excerpt.length });
    }
  }

  if (ranges.length === 0) return content;

  ranges.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r.start <= prev.end) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach((r, i) => {
    if (r.start > cursor) {
      nodes.push(<span key={`t-${i}`}>{content.slice(cursor, r.start)}</span>);
    }
    nodes.push(
      <mark
        key={`m-${i}`}
        style={{
          backgroundColor: "rgba(165, 148, 249, 0.26)",
          color: "var(--text-white)",
          padding: "1px 4px",
          borderRadius: "4px",
          borderBottom: "1.5px solid var(--accent-lavender)",
          fontWeight: 500,
        }}
      >
        {content.slice(r.start, r.end)}
      </mark>
    );
    cursor = r.end;
  });

  if (cursor < content.length) {
    nodes.push(<span key="t-end">{content.slice(cursor)}</span>);
  }
  return nodes;
}

interface ChatPaneProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => Promise<void>;
  onAcceptProposal: (sessionId: string) => Promise<void>;
  onRejectProposal: (sessionId: string) => Promise<void>;
  onModifyProposal: (sessionId: string, feedback: string) => Promise<void>;
  isLoading: boolean;
  liveSteps?: AgentStep[];
}

const STARTER_PROMPTS = [
  "Enable Tabby installments in my store",
  "Increase Ethiopian Yirgacheffe price to 72 SAR",
  "Add Express Riyadh shipping zone for 25 SAR",
  "What carrier partnerships does Mtajir have?",
  "Change primary theme color to #8B5CF6 and turn on the banner",
];

export const ChatPane: React.FC<ChatPaneProps> = ({
  messages,
  onSendMessage,
  onAcceptProposal,
  onRejectProposal,
  onModifyProposal,
  isLoading,
  liveSteps = [],
}) => {
  const [inputText, setInputText] = useState("");
  const [expandedCitation, setExpandedCitation] = useState<{
    msgId: string;
    title: string;
  } | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, liveSteps]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  const handleChipClick = (prompt: string) => {
    if (isLoading) return;
    onSendMessage(prompt);
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 64px)",
        backgroundColor: "var(--bg-obsidian)",
        borderRight: "1px solid var(--border-subtle)",
      }}
    >
      {/* Messages Scroll Area */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              margin: "auto 0",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "14px",
              padding: "20px 0",
            }}
          >
            <div
              style={{
                width: "52px",
                height: "52px",
                borderRadius: "50%",
                backgroundColor: "var(--surface-ai)",
                border: "1px solid var(--border-ai)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <KhadoomIcon size={26} color="var(--accent-lavender)" />
            </div>

            <h3
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 700,
                color: "var(--text-white)",
              }}
            >
              How can I assist your store today?
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: "13.5px",
                color: "var(--text-secondary)",
                maxWidth: "400px",
                lineHeight: "1.5",
              }}
            >
              Ask questions about Mtajir policies or ask me to change catalog
              prices, payment gateways, and shipping zones with reversible staging.
            </p>

            {/* Quick Starter Chips */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                width: "100%",
                maxWidth: "440px",
                marginTop: "8px",
              }}
            >
              {STARTER_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleChipClick(prompt)}
                  style={{
                    backgroundColor: "var(--surface-charcoal)",
                    color: "var(--text-white)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "9999px",
                    padding: "9px 16px",
                    fontSize: "12.5px",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--surface-hover)";
                    e.currentTarget.style.borderColor = "var(--border-secondary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--surface-charcoal)";
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                  }}
                >
                  <span>{prompt}</span>
                  <span style={{ color: "var(--accent-lavender)", fontSize: "14px" }}>
                    +
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-start",
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              maxWidth: msg.role === "user" ? "82%" : "95%",
            }}
          >
            {msg.role === "assistant" && (
              <div
                style={{
                  width: "30px",
                  height: "30px",
                  borderRadius: "50%",
                  backgroundColor: "var(--surface-ai)",
                  border: "1px solid var(--border-ai)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: "2px",
                }}
              >
                <KhadoomIcon size={17} color="var(--accent-lavender)" />
              </div>
            )}

            <div style={{ flex: 1 }}>
              {msg.role === "assistant" &&
                ((msg.steps && msg.steps.length > 0) || msg.telemetry) && (() => {
                  const isStepsOpen = Boolean(expandedSteps[msg.id]);
                  const stepCount = msg.steps?.length || 0;
                  return (
                    <div style={{ marginBottom: "6px" }}>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSteps((prev) => ({
                            ...prev,
                            [msg.id]: !prev[msg.id],
                          }))
                        }
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          background: "transparent",
                          border: "none",
                          padding: "2px 4px",
                          color: "var(--text-muted)",
                          opacity: isStepsOpen ? 0.92 : 0.65,
                          fontSize: "12px",
                          cursor: "pointer",
                          transition: "opacity 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.opacity = "0.95";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.opacity = isStepsOpen ? "0.92" : "0.65";
                        }}
                      >
                        {isStepsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <span>
                          Show steps and metrics
                          {stepCount > 0 ? ` (${stepCount})` : ""}
                        </span>
                      </button>

                      {isStepsOpen && (
                        <div
                          style={{
                            marginTop: "6px",
                            padding: "10px 12px",
                            borderRadius: "10px",
                            backgroundColor: "rgba(255, 255, 255, 0.025)",
                            border: "1px solid var(--border-subtle)",
                            fontSize: "12px",
                            color: "var(--text-secondary)",
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                          }}
                        >
                          {msg.steps && msg.steps.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                              {msg.steps.map((step, idx) => (
                                <div
                                  key={step.id || idx}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "10px",
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
                                    {step.status === "error" ? (
                                      <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                                    ) : (
                                      <CheckCircle2
                                        size={13}
                                        color="var(--accent-lavender)"
                                        style={{ flexShrink: 0 }}
                                      />
                                    )}
                                    <span style={{ color: "var(--text-white)" }}>{step.label}</span>
                                    {step.detail && (
                                      <span
                                        style={{
                                          color: "var(--text-muted)",
                                          fontSize: "11px",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                          maxWidth: "260px",
                                        }}
                                        title={step.detail}
                                      >
                                        · {step.detail}
                                      </span>
                                    )}
                                  </div>
                                  {typeof step.durationMs === "number" && (
                                    <span
                                      style={{
                                        color: "var(--text-muted)",
                                        fontSize: "11px",
                                        flexShrink: 0,
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      {step.durationMs}ms
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {msg.telemetry && (
                            <div
                              style={{
                                paddingTop: msg.steps && msg.steps.length > 0 ? "8px" : 0,
                                borderTop:
                                  msg.steps && msg.steps.length > 0
                                    ? "1px solid rgba(255, 255, 255, 0.06)"
                                    : "none",
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "12px",
                                fontSize: "11.5px",
                                color: "var(--text-muted)",
                              }}
                            >
                              <span>
                                Latency:{" "}
                                <strong style={{ color: "var(--text-white)", fontWeight: 500 }}>
                                  {msg.telemetry.latencyMs}ms
                                </strong>
                                {typeof msg.telemetry.llmLatencyMs === "number" &&
                                msg.telemetry.llmLatencyMs > 0
                                  ? ` (LLM ${msg.telemetry.llmLatencyMs}ms${
                                      typeof msg.telemetry.llmCallsCount === "number" &&
                                      msg.telemetry.llmCallsCount > 0
                                        ? `, ${msg.telemetry.llmCallsCount} call${
                                            msg.telemetry.llmCallsCount > 1 ? "s" : ""
                                          }`
                                        : ""
                                    })`
                                  : ""}
                                {typeof msg.telemetry.tokensPerSecond === "number" &&
                                msg.telemetry.tokensPerSecond > 0
                                  ? ` · ${msg.telemetry.tokensPerSecond} tok/s`
                                  : ""}
                              </span>
                              <span>
                                Tokens:{" "}
                                <strong style={{ color: "var(--text-white)", fontWeight: 500 }}>
                                  {msg.telemetry.usage.promptTokens.toLocaleString()}
                                </strong>{" "}
                                in
                                {msg.telemetry.usage.cachedTokens > 0
                                  ? ` (${msg.telemetry.usage.cachedTokens.toLocaleString()} cached)`
                                  : ""}{" "}
                                /{" "}
                                <strong style={{ color: "var(--text-white)", fontWeight: 500 }}>
                                  {msg.telemetry.usage.completionTokens.toLocaleString()}
                                </strong>{" "}
                                out
                              </span>
                              <span>
                                Est. Cost:{" "}
                                <strong style={{ color: "var(--text-white)", fontWeight: 500 }}>
                                  ${msg.telemetry.cost.totalCostUsd.toFixed(6)}
                                </strong>
                              </span>
                              <span>Model: {msg.telemetry.model}</span>
                              {msg.telemetry.semanticCacheHit && (
                                <span style={{ color: "var(--accent-lavender)" }}>Cache Hit</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

              {/* Message Bubble */}
              <div
                style={{
                  backgroundColor:
                    msg.role === "user"
                      ? "var(--surface-active)"
                      : "var(--surface-charcoal)",
                  border: `1px solid ${
                    msg.role === "user"
                      ? "var(--border-secondary)"
                      : "var(--border-subtle)"
                  }`,
                  borderRadius:
                    msg.role === "user"
                      ? "16px 16px 4px 16px"
                      : "16px 16px 16px 4px",
                  padding: "12px 16px",
                  fontSize: "13.5px",
                  lineHeight: "1.55",
                  color: "var(--text-white)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {msg.role === "assistant" ? (
                  <FormattedMessage content={msg.content} />
                ) : (
                  msg.content
                )}

                {/* Clickable Citations & Expandable Highlighted Source Passages */}
                {msg.citations && msg.citations.length > 0 && (() => {
                  const selectedDetail =
                    expandedCitation?.msgId === msg.id
                      ? msg.citationDetails?.find((d) => d.title === expandedCitation.title)
                      : undefined;
                  const hasHighlightedParts = Boolean(
                    selectedDetail?.passages.some((p) => p.matchedExcerpts.length > 0)
                  );

                  return (
                    <div
                      style={{
                        marginTop: "10px",
                        paddingTop: "8px",
                        borderTop: "1px solid rgba(255, 255, 255, 0.08)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "6px",
                        }}
                      >
                        <BookOpen size={12} color="var(--accent-lavender)" />
                        <span
                          style={{
                            fontSize: "11px",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Sources:
                        </span>
                        {msg.citations.map((cite, cIdx) => {
                          const detail = msg.citationDetails?.find((d) => d.title === cite);
                          const isSelected =
                            expandedCitation?.msgId === msg.id &&
                            expandedCitation?.title === cite;
                          const isClickable = Boolean(detail && detail.passages.length > 0);

                          return (
                            <button
                              key={cIdx}
                              type="button"
                              disabled={!isClickable}
                              title={
                                isClickable
                                  ? isSelected
                                    ? "Hide retrieved passage"
                                    : "Click to inspect retrieved passage"
                                  : "Cached citation title"
                              }
                              onClick={() => {
                                if (!isClickable) return;
                                setExpandedCitation(
                                  isSelected ? null : { msgId: msg.id, title: cite }
                                );
                              }}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                fontSize: "11px",
                                fontWeight: 500,
                                backgroundColor: isSelected
                                  ? "rgba(165, 148, 249, 0.26)"
                                  : "rgba(165, 148, 249, 0.12)",
                                color: isSelected
                                  ? "var(--text-white)"
                                  : "var(--accent-lavender)",
                                padding: "2px 9px",
                                borderRadius: "9999px",
                                border: isSelected
                                  ? "1px solid var(--accent-lavender)"
                                  : "1px solid rgba(165, 148, 249, 0.25)",
                                cursor: isClickable ? "pointer" : "default",
                                transition: "all 0.15s ease",
                                fontFamily: "inherit",
                              }}
                            >
                              <span>{cite}</span>
                              {isClickable &&
                                (isSelected ? (
                                  <ChevronUp size={12} />
                                ) : (
                                  <ChevronDown size={12} />
                                ))}
                            </button>
                          );
                        })}
                      </div>

                      {selectedDetail && (
                        <div
                          style={{
                            backgroundColor: "var(--bg-obsidian)",
                            border: "1px solid var(--border-indigo)",
                            borderRadius: "10px",
                            padding: "10px 12px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "10px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              flexWrap: "wrap",
                              gap: "6px",
                              borderBottom: "1px solid var(--border-subtle)",
                              paddingBottom: "6px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.04em",
                                  backgroundColor: "var(--surface-indigo)",
                                  color: "var(--accent-lavender)",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                }}
                              >
                                {selectedDetail.category}
                              </span>
                              <span
                                style={{
                                  fontSize: "12px",
                                  fontWeight: 600,
                                  color: "var(--text-white)",
                                }}
                              >
                                {selectedDetail.title}
                              </span>
                            </div>

                            {hasHighlightedParts && (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontSize: "10.5px",
                                  color: "var(--accent-lavender)",
                                }}
                              >
                                <Highlighter size={11} />
                                Highlighted = used in answer
                              </span>
                            )}
                          </div>

                          {selectedDetail.passages.map((passage) => (
                            <div
                              key={passage.chunkId}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "4px",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "8px",
                                  flexWrap: "wrap",
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  § {passage.sectionHeader}
                                </span>
                                <span
                                  style={{
                                    fontSize: "10px",
                                    color: "var(--text-muted)",
                                  }}
                                >
                                  {[
                                    passage.rerankScore !== undefined
                                      ? `Rerank ${(passage.rerankScore * 100).toFixed(0)}%`
                                      : null,
                                    passage.vectorSimilarity !== undefined
                                      ? `Vec ${(passage.vectorSimilarity * 100).toFixed(0)}%`
                                      : null,
                                    passage.bm25Score !== undefined
                                      ? `BM25 ${passage.bm25Score.toFixed(2)}`
                                      : null,
                                    passage.rrfScore !== undefined
                                      ? `RRF ${passage.rrfScore.toFixed(4)}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </div>
                              <div
                                style={{
                                  fontSize: "12.5px",
                                  lineHeight: "1.6",
                                  color: "var(--text-secondary)",
                                  whiteSpace: "pre-wrap",
                                  backgroundColor: "rgba(255, 255, 255, 0.02)",
                                  padding: "8px 10px",
                                  borderRadius: "6px",
                                  borderLeft:
                                    passage.matchedExcerpts.length > 0
                                      ? "2px solid var(--accent-lavender)"
                                      : "2px solid var(--border-subtle)",
                                }}
                              >
                                {renderHighlightedPassage(
                                  passage.content,
                                  passage.matchedExcerpts
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Staged Mutation Card */}
              {msg.stagedMutation && (
                <ProposalCard
                  session={msg.stagedMutation}
                  onAccept={onAcceptProposal}
                  onReject={onRejectProposal}
                  onModify={onModifyProposal}
                  isLoading={isLoading}
                />
              )}
            </div>

            {msg.role === "user" && (
              <div
                style={{
                  width: "30px",
                  height: "30px",
                  borderRadius: "50%",
                  backgroundColor: "var(--surface-hover)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: "2px",
                }}
              >
                <User size={15} color="var(--text-secondary)" />
              </div>
            )}
          </div>
        ))}

        {/* Loading State (Loading UI: PulsatingDots + TextShimmer) */}
        {isLoading && (
          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-start",
              alignSelf: "flex-start",
            }}
          >
            <div
              style={{
                width: "30px",
                height: "30px",
                borderRadius: "50%",
                backgroundColor: "var(--surface-ai)",
                border: "1px solid var(--border-ai)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                marginTop: "2px",
              }}
            >
              <KhadoomIcon size={17} color="var(--accent-lavender)" />
            </div>
            <div
              style={{
                backgroundColor: "var(--surface-charcoal)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "16px 16px 16px 4px",
                padding: "11px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "7px",
                minWidth: "260px",
                maxWidth: "460px",
              }}
            >
              {liveSteps.length === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <PulsatingDots />
                  <TextShimmer>Analyzing request...</TextShimmer>
                </div>
              ) : (
                liveSteps.map((step) => (
                  <div
                    key={step.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                      fontSize: "12.5px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        minWidth: 0,
                      }}
                    >
                      {step.status === "running" ? (
                        <PulsatingDots />
                      ) : step.status === "error" ? (
                        <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                      ) : (
                        <CheckCircle2
                          size={13}
                          color="var(--accent-lavender)"
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      {step.status === "running" ? (
                        <TextShimmer>{step.label}</TextShimmer>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>{step.label}</span>
                      )}
                      {step.detail && (
                        <span
                          style={{
                            color: "var(--text-muted)",
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: "180px",
                          }}
                          title={step.detail}
                        >
                          {step.detail}
                        </span>
                      )}
                    </div>
                    {typeof step.durationMs === "number" && (
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: "11px",
                          flexShrink: 0,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {step.durationMs}ms
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Form Bar */}
      <div
        style={{
          padding: "16px 24px",
          borderTop: "1px solid var(--border-subtle)",
          backgroundColor: "var(--surface-charcoal)",
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            backgroundColor: "var(--bg-obsidian)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "9999px",
            padding: "4px 6px 4px 18px",
          }}
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={isLoading}
            placeholder="Ask a question or request store changes..."
            style={{
              flex: 1,
              backgroundColor: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-white)",
              fontSize: "13.5px",
            }}
          />
          <button
            type="submit"
            disabled={isLoading || !inputText.trim()}
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "50%",
              backgroundColor:
                !inputText.trim() || isLoading
                  ? "var(--surface-hover)"
                  : "var(--accent-lavender)",
              color:
                !inputText.trim() || isLoading
                  ? "var(--text-muted)"
                  : "var(--accent-dark)",
              border: "none",
              cursor: !inputText.trim() || isLoading ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.15s ease",
            }}
          >
            <Send size={15} />
          </button>
        </form>
      </div>
    </div>
  );
};
