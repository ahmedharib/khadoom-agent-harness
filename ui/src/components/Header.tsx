import React, { useState, useRef, useEffect } from "react";
import {
  MtajirStore,
  TelemetrySummary,
  ModelConfigInfo,
  RouterState,
  ModelPairId,
  RerankerMode,
} from "../types.js";
import {
  RotateCcw,
  Activity,
  ArrowLeft,
  ChevronDown,
  Cpu,
  Check,
  RefreshCw,
  Database,
  Layers,
} from "lucide-react";
import { KhadoomIcon } from "./KhadoomIcon.js";

interface HeaderProps {
  store: MtajirStore | null;
  telemetry: TelemetrySummary | null;
  modelConfig: ModelConfigInfo | null;
  routerState: RouterState | null;
  onSelectRouter: (selection: {
    modelPair?: ModelPairId;
    reranker?: RerankerMode;
  }) => Promise<void>;
  onRefreshRouter: () => Promise<void>;
  onReset: () => void;
  onRollback: () => void;
  isLoading: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  store,
  telemetry,
  modelConfig,
  routerState,
  onSelectRouter,
  onRefreshRouter,
  onReset,
  onRollback,
  isLoading,
}) => {
  const [routerOpen, setRouterOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const routerMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (routerMenuRef.current && !routerMenuRef.current.contains(e.target as Node)) {
        setRouterOpen(false);
      }
    };
    if (routerOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [routerOpen]);

  const activePair = routerState?.modelPairs.find((p) => p.id === routerState.selectedPair);
  const activeReranker = routerState?.rerankers.find((r) => r.id === routerState.selectedReranker);
  const activePairShort =
    routerState?.selectedPair === "local" ? "Local (Qwen 3)" : "Commercial (OpenAI)";
  const activeRerankShort =
    routerState?.selectedReranker === "local"
      ? "BGE-M3"
      : routerState?.selectedReranker === "commercial"
      ? "Cohere"
      : "RRF";
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

        {/* 3. Model Pair & Reranker Router Selector Pill */}
        {routerState && (
          <div ref={routerMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setRouterOpen((prev) => !prev)}
              disabled={isLoading}
              title={
                activePair
                  ? `${activePair.label} (${activePair.subtitle}) | Reranker: ${activeReranker?.label}`
                  : "Configure Model Pair & Reranker"
              }
              style={{
                ...actionButtonStyle,
                borderColor: routerOpen ? "var(--accent-lavender)" : "var(--border-secondary)",
                backgroundColor: routerOpen
                  ? "rgba(165, 148, 249, 0.14)"
                  : "rgba(255, 255, 255, 0.03)",
              }}
            >
              <Cpu size={13} color="var(--accent-lavender)" />
              <span>
                {activePairShort} · {activeRerankShort}
              </span>
              <ChevronDown size={12} color="var(--text-secondary)" />
            </button>

            {routerOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "40px",
                  right: 0,
                  width: "340px",
                  backgroundColor: "var(--surface-charcoal)",
                  border: "1px solid var(--border-indigo)",
                  borderRadius: "14px",
                  padding: "14px",
                  boxShadow: "0 18px 40px rgba(0, 0, 0, 0.55)",
                  zIndex: 100,
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {/* Popover Header: VectorDB + Refresh */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingBottom: "8px",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Database
                      size={12}
                      color={
                        routerState.vectorDb.mode === "qdrant"
                          ? "var(--status-emerald)"
                          : "var(--status-amber)"
                      }
                    />
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      VectorDB:{" "}
                      <strong style={{ color: "var(--text-white)" }}>
                        {routerState.vectorDb.mode === "qdrant" ? "Qdrant" : "File JSON"}
                      </strong>
                      {" · "}
                      {routerState.vectorDb.activeCollection}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      setIsRefreshing(true);
                      await onRefreshRouter();
                      setIsRefreshing(false);
                    }}
                    title="Re-probe Qdrant, Colab & Reranker endpoints"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      fontSize: "11px",
                      color: "var(--accent-lavender)",
                      backgroundColor: "transparent",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "9999px",
                      padding: "3px 8px",
                      cursor: "pointer",
                    }}
                  >
                    <RefreshCw size={11} />
                    <span>{isRefreshing ? "..." : "Refresh"}</span>
                  </button>
                </div>

                {/* Section 1: Model + Embeddings Pair */}
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span
                    style={{
                      fontSize: "10.5px",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-muted)",
                    }}
                  >
                    Model + Embeddings Pair
                  </span>
                  {routerState.modelPairs.map((pair) => {
                    const isSelected = routerState.selectedPair === pair.id;
                    return (
                      <button
                        key={pair.id}
                        type="button"
                        disabled={!pair.active || isLoading}
                        onClick={async () => {
                          if (!pair.active) return;
                          await onSelectRouter({ modelPair: pair.id });
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "10px",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 10px",
                          borderRadius: "10px",
                          border: isSelected
                            ? "1px solid var(--accent-lavender)"
                            : "1px solid var(--border-subtle)",
                          backgroundColor: !pair.active
                            ? "rgba(255, 255, 255, 0.01)"
                            : isSelected
                            ? "rgba(165, 148, 249, 0.14)"
                            : "rgba(255, 255, 255, 0.03)",
                          opacity: pair.active ? 1 : 0.42,
                          filter: pair.active ? "none" : "grayscale(100%)",
                          cursor: pair.active ? "pointer" : "not-allowed",
                          fontFamily: "inherit",
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              color: pair.active ? "var(--text-white)" : "var(--text-muted)",
                            }}
                          >
                            {pair.label}
                          </span>
                          <span style={{ fontSize: "10.5px", color: "var(--text-secondary)" }}>
                            {pair.active ? pair.subtitle : pair.reason || "Inactive"}
                          </span>
                        </div>
                        {isSelected && pair.active ? (
                          <Check size={14} color="var(--accent-lavender)" />
                        ) : !pair.active ? (
                          <span
                            style={{
                              fontSize: "9.5px",
                              fontWeight: 600,
                              color: "var(--text-muted)",
                              border: "1px solid var(--border-subtle)",
                              padding: "1px 6px",
                              borderRadius: "9999px",
                            }}
                          >
                            Inactive
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                {/* Section 2: Cross-Pair Reranker */}
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <Layers size={11} color="var(--text-muted)" />
                    <span
                      style={{
                        fontSize: "10.5px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--text-muted)",
                      }}
                    >
                      Reranker (Works with Either Pair)
                    </span>
                  </div>
                  {routerState.rerankers.map((rr) => {
                    const isSelected = routerState.selectedReranker === rr.id;
                    return (
                      <button
                        key={rr.id}
                        type="button"
                        disabled={!rr.active || isLoading}
                        onClick={async () => {
                          if (!rr.active) return;
                          await onSelectRouter({ reranker: rr.id });
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "10px",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 10px",
                          borderRadius: "10px",
                          border: isSelected
                            ? "1px solid var(--accent-lavender)"
                            : "1px solid var(--border-subtle)",
                          backgroundColor: !rr.active
                            ? "rgba(255, 255, 255, 0.01)"
                            : isSelected
                            ? "rgba(165, 148, 249, 0.14)"
                            : "rgba(255, 255, 255, 0.03)",
                          opacity: rr.active ? 1 : 0.42,
                          filter: rr.active ? "none" : "grayscale(100%)",
                          cursor: rr.active ? "pointer" : "not-allowed",
                          fontFamily: "inherit",
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              color: rr.active ? "var(--text-white)" : "var(--text-muted)",
                            }}
                          >
                            {rr.label}
                          </span>
                          <span style={{ fontSize: "10.5px", color: "var(--text-secondary)" }}>
                            {rr.active ? rr.subtitle : rr.reason || "Inactive"}
                          </span>
                        </div>
                        {isSelected && rr.active ? (
                          <Check size={14} color="var(--accent-lavender)" />
                        ) : !rr.active ? (
                          <span
                            style={{
                              fontSize: "9.5px",
                              fontWeight: 600,
                              color: "var(--text-muted)",
                              border: "1px solid var(--border-subtle)",
                              padding: "1px 6px",
                              borderRadius: "9999px",
                            }}
                          >
                            Inactive
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 4. Telemetry Token, Speed, Model & Cost Pill (Unified pill) */}
        {telemetry && (
          <div
            title={`Backend: ${modelConfig ? `${modelConfig.model} (${modelConfig.isCustomEndpoint ? `Custom Endpoint: ${modelConfig.baseURL}` : "OpenAI API"})` : "Unknown"} | Queries: ${telemetry.totalQueries} | Avg: ${telemetry.averageLatencyMs}ms | P95: ${telemetry.p95LatencyMs ?? telemetry.averageLatencyMs}ms | Speed: ${telemetry.avgTokensPerSecond ?? 0} tok/s | Retries: ${telemetry.totalRetries ?? 0}`}
            style={infoPillStyle}
          >
            <Activity size={13} color="var(--accent-lavender)" />
            <span>
              {modelConfig ? `${modelConfig.model.split("/").pop()} • ` : ""}
              ${telemetry.totalCostUsd.toFixed(4)} USD
              {telemetry.avgTokensPerSecond ? ` • ${telemetry.avgTokensPerSecond} tok/s` : ""}
            </span>
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
