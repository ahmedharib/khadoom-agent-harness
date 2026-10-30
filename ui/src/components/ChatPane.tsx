import React, { useState, useRef, useEffect } from "react";
import { ChatMessage } from "../types.js";
import { ProposalCard } from "./ProposalCard.js";
import { KhadoomIcon } from "./KhadoomIcon.js";
import { FormattedMessage } from "./FormattedMessage.js";
import { PulsatingDots, TextShimmer } from "./LoadingIndicator.js";
import { Send, User, BookOpen } from "lucide-react";

interface ChatPaneProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => Promise<void>;
  onAcceptProposal: (sessionId: string) => Promise<void>;
  onRejectProposal: (sessionId: string) => Promise<void>;
  onModifyProposal: (sessionId: string, feedback: string) => Promise<void>;
  isLoading: boolean;
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
}) => {
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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

                {/* Citations if available */}
                {msg.citations && msg.citations.length > 0 && (
                  <div
                    style={{
                      marginTop: "10px",
                      paddingTop: "8px",
                      borderTop: "1px solid rgba(255, 255, 255, 0.08)",
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
                    {msg.citations.map((cite, cIdx) => (
                      <span
                        key={cIdx}
                        style={{
                          fontSize: "11px",
                          fontWeight: 500,
                          backgroundColor: "rgba(165, 148, 249, 0.12)",
                          color: "var(--accent-lavender)",
                          padding: "2px 8px",
                          borderRadius: "9999px",
                          border: "1px solid rgba(165, 148, 249, 0.25)",
                        }}
                      >
                        {cite}
                      </span>
                    ))}
                  </div>
                )}
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
                alignItems: "center",
                gap: "10px",
              }}
            >
              <PulsatingDots />
              <TextShimmer>Thinking...</TextShimmer>
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
