import React from "react";
import { MtajirStore, TelemetrySummary } from "../types.js";
import { RotateCcw, Activity, ArrowLeft } from "lucide-react";
import { KhadoomIcon } from "./KhadoomIcon.js";

interface HeaderProps {
  store: MtajirStore | null;
  telemetry: TelemetrySummary | null;
  onReset: () => void;
  onRollback: () => void;
  isLoading: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  store,
  telemetry,
  onReset,
  onRollback,
  isLoading,
}) => {
  // Shared unified pill button style
  const unifiedPillStyle: React.CSSProperties = {
    height: "32px",
    padding: "0 14px",
    borderRadius: "9999px",
    fontSize: "12px",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    boxSizing: "border-box",
    transition: "all 0.15s ease",
  };

  const actionButtonStyle: React.CSSProperties = {
    ...unifiedPillStyle,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    border: "1px solid var(--border-secondary)",
    color: "var(--text-white)",
    cursor: isLoading ? "not-allowed" : "pointer",
  };

  const infoPillStyle: React.CSSProperties = {
    ...unifiedPillStyle,
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    border: "1px solid var(--border-subtle)",
    color: "var(--text-secondary)",
  };

  return (
    <header
      style={{
        height: "64px",
        backgroundColor: "var(--surface-charcoal)",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        userSelect: "none",
        zIndex: 50,
      }}
    >
      {/* Brand Lockup: Name only, icon removed */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <span
          style={{
            fontSize: "22px",
            fontWeight: 800,
            fontStyle: "italic",
            letterSpacing: "-0.03em",
            color: "var(--text-white)",
          }}
        >
          mtajir
        </span>

        <div
          style={{
            height: "20px",
            width: "1px",
            backgroundColor: "var(--border-subtle)",
          }}
        />

        {/* AI Co-Pilot Badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            backgroundColor: "var(--surface-ai)",
            border: "1px solid var(--border-ai)",
            borderRadius: "9999px",
            padding: "4px 12px",
          }}
        >
          <KhadoomIcon size={15} color="var(--accent-lavender)" />
          <span
            style={{
              fontSize: "12.5px",
              fontWeight: 600,
              color: "var(--accent-lavender)",
              letterSpacing: "0.01em",
            }}
          >
            Khadoom Co-Pilot
          </span>
        </div>
      </div>

      {/* Top Right Controls: Unified pill geometry */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {/* 1. Rollback Button (Placed to the left of the store name pill) */}
        {store && store.version > 1 && (
          <button
            onClick={onRollback}
            disabled={isLoading}
            title={`Roll back store state to v${store.version - 1}`}
            style={actionButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.08)";
              e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.25)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.03)";
              e.currentTarget.style.borderColor = "var(--border-secondary)";
            }}
          >
            <ArrowLeft size={13} color="var(--accent-lavender)" />
            <span>Rollback (v{store.version - 1})</span>
          </button>
        )}

        {/* 2. Store Name & Version Pill (Flashing green ball removed) */}
        {store && (
          <div style={infoPillStyle}>
            <span style={{ fontWeight: 600, color: "var(--text-white)" }}>
              {store.name}
            </span>
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--accent-lavender)",
                backgroundColor: "var(--surface-active)",
                padding: "2px 7px",
                borderRadius: "9999px",
              }}
            >
              v{store.version}
            </span>
          </div>
        )}

        {/* 3. Telemetry Token & Cost Pill (Unified pill) */}
        {telemetry && (
          <div
            title={`Total Queries: ${telemetry.totalQueries} | Prompt & Completion Tokens`}
            style={infoPillStyle}
          >
            <Activity size={13} color="var(--accent-lavender)" />
            <span>${telemetry.totalCostUsd.toFixed(4)} USD</span>
          </div>
        )}

        {/* 4. Reset Demo Button (Unified pill) */}
        <button
          onClick={onReset}
          disabled={isLoading}
          title="Reset store back to clean initial demo seed (v1)"
          style={actionButtonStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.08)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.25)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.03)";
            e.currentTarget.style.borderColor = "var(--border-secondary)";
          }}
        >
          <RotateCcw size={13} color="var(--text-secondary)" />
          <span>Reset Demo</span>
        </button>
      </div>
    </header>
  );
};
