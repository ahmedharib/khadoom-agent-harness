import React, { useState, useEffect } from "react";
import {
  MtajirStore,
  ChangelogEntry,
  TelemetrySummary,
  ModelConfigInfo,
  RouterState,
  ModelPairId,
  RerankerMode,
  AgentStep,
  ChatMessage,
  StagingSession,
} from "./types.js";
import { Header } from "./components/Header.js";
import { ChatPane } from "./components/ChatPane.js";
import { StorePane, StoreTabType } from "./components/StorePane.js";

function inferStoreTabFromSession(
  session?: StagingSession,
  navigationRoute?: string
): StoreTabType | null {
  if (navigationRoute) {
    const r = navigationRoute.toLowerCase();
    if (r.includes("payment") || r.includes("money")) return "payments";
    if (r.includes("shipping") || r.includes("delivery")) return "shipping";
    if (r.includes("theme") || r.includes("design") || r.includes("brand")) return "theme";
    if (r.includes("product") || r.includes("catalog")) return "products";
  }

  const firstCategory = session?.semanticChanges?.[0]?.category;
  if (firstCategory === "payments") return "payments";
  if (firstCategory === "shipping") return "shipping";
  if (firstCategory === "branding") return "theme";
  if (firstCategory === "catalog") return "products";
  return null;
}

export const App: React.FC = () => {
  const [store, setStore] = useState<MtajirStore | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySummary | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfigInfo | null>(null);
  const [routerState, setRouterState] = useState<RouterState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUpdated, setIsUpdated] = useState<boolean>(false);
  const [activeStoreTab, setActiveStoreTab] = useState<StoreTabType>("products");
  const [conversationId, setConversationId] = useState<string>(() => `ui_${Date.now()}`);

  // Trigger brief visual pulse on store update
  const flashUpdate = () => {
    setIsUpdated(true);
    setTimeout(() => setIsUpdated(false), 2000);
  };

  // Initial load
  const loadStore = async () => {
    try {
      const res = await fetch("/api/store");
      if (!res.ok) throw new Error("Failed to load store data");
      const data = await res.json();
      setStore(data.store);
      setChangelog(data.changelog || []);
      setTelemetry(data.telemetry || null);
      if (data.modelConfig) setModelConfig(data.modelConfig);
      if (data.routerState) setRouterState(data.routerState);
    } catch (err) {
      console.error("[Init Error]", err);
    }
  };

  useEffect(() => {
    loadStore();
  }, []);

  const runAgentTurn = async (endpoint: string, payload: Record<string, unknown>) => {
    setLiveSteps([]);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ ...payload, stream: true }),
      });

      if (!res.ok) throw new Error("Agent turn request failed");

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") || !res.body) {
        return await res.json();
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalData: any = null;

      const handleBlock = (block: string) => {
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        const parsed = JSON.parse(dataLines.join("\n"));
        if (eventName === "step") {
          setLiveSteps((prev) =>
            prev.some((s) => s.id === parsed.id)
              ? prev.map((s) => (s.id === parsed.id ? parsed : s))
              : [...prev, parsed]
          );
        } else if (eventName === "done") {
          finalData = parsed;
        } else if (eventName === "error") {
          throw new Error(parsed.error || "Agent turn request failed");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          if (block.trim()) handleBlock(block);
        }
      }
      if (buffer.trim()) handleBlock(buffer);
      if (!finalData) throw new Error("Stream ended without a final response");
      return finalData;
    } finally {
      setLiveSteps([]);
    }
  };

  // Send message to Khadoom
  const handleSendMessage = async (prompt: string) => {
    const userMsgId = `msg_${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const data = await runAgentTurn("/api/chat", { prompt, conversationId });

      const staged: StagingSession | undefined = data.stagingSession || data.stagedMutation;
      const bubbleContent =
        data.answerText ||
        (staged
          ? "I've staged the requested changes below. Review the preview and accept to publish:"
          : data.message || data.reply || "Done.");

      const assistantMsg: ChatMessage = {
        id: `asst_${Date.now()}`,
        role: "assistant",
        content: bubbleContent,
        citations: data.citations || [],
        citationDetails: data.citationDetails || [],
        stagedMutation: staged,
        navigationRoute: data.navigationRoute,
        steps: data.steps || [],
        telemetry: data.turnTelemetry,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
      if (data.currentStore) setStore(data.currentStore);
      if (data.changelog) setChangelog(data.changelog);
      if (data.telemetry) setTelemetry(data.telemetry);

      const targetTab = inferStoreTabFromSession(staged, data.navigationRoute);
      if (targetTab) setActiveStoreTab(targetTab);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        role: "assistant",
        content: `Error: ${err.message || "Something went wrong while contacting Khadoom."}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  // Accept & commit staged proposal
  const handleAcceptProposal = async (sessionId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/staging/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });

      if (!res.ok) throw new Error("Failed to accept staging session");
      const data = await res.json();

      if (data.store) setStore(data.store);
      if (data.changelog) setChangelog(data.changelog);

      let matchedSession: StagingSession | undefined;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.stagedMutation && m.stagedMutation.sessionId === sessionId) {
            matchedSession = m.stagedMutation;
            return {
              ...m,
              stagedMutation: {
                ...m.stagedMutation,
                status: "committed",
                stagedStore: data.store,
              },
            };
          }
          return m;
        })
      );

      const targetTab = inferStoreTabFromSession(matchedSession);
      if (targetTab) setActiveStoreTab(targetTab);

      flashUpdate();
    } catch (err: any) {
      console.error("[Accept Error]", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Reject proposal
  const handleRejectProposal = async (sessionId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/staging/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });

      if (!res.ok) throw new Error("Failed to reject staging session");

      setMessages((prev) =>
        prev.map((m) => {
          if (m.stagedMutation && m.stagedMutation.sessionId === sessionId) {
            return {
              ...m,
              stagedMutation: {
                ...m.stagedMutation,
                status: "rejected",
              },
            };
          }
          return m;
        })
      );
    } catch (err: any) {
      console.error("[Reject Error]", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Modify proposal with feedback
  const handleModifyProposal = async (sessionId: string, feedback: string) => {
    setIsLoading(true);
    try {
      const data = await runAgentTurn("/api/staging/modify", {
        sessionId,
        feedback,
        conversationId,
      });

      const staged: StagingSession | undefined = data.stagingSession || data.stagedMutation;

      // Only discard the previous proposal if a replacement proposal was actually staged
      if (staged) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.stagedMutation && m.stagedMutation.sessionId === sessionId) {
              return {
                ...m,
                stagedMutation: {
                  ...m.stagedMutation,
                  status: "rejected",
                },
              };
            }
            return m;
          })
        );
      }

      const updatedMsg: ChatMessage = {
        id: `asst_mod_${Date.now()}`,
        role: "assistant",
        content:
          data.answerText ||
          (staged
            ? "Updated staged proposal based on your feedback:"
            : data.message || data.reply || "Could not generate an updated proposal. Your previous staged proposal is still pending."),
        citations: data.citations || [],
        citationDetails: data.citationDetails || [],
        stagedMutation: staged,
        steps: data.steps || [],
        telemetry: data.turnTelemetry,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, updatedMsg]);
      if (data.currentStore) setStore(data.currentStore);
      if (data.changelog) setChangelog(data.changelog);
      if (data.telemetry) setTelemetry(data.telemetry);

      const targetTab = inferStoreTabFromSession(staged);
      if (targetTab) setActiveStoreTab(targetTab);
    } catch (err: any) {
      console.error("[Modify Error]", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Rollback to specific version
  const handleRollbackToVersion = async (targetVersion: number) => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/store/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: targetVersion }),
      });

      if (!res.ok) throw new Error("Rollback failed");
      const data = await res.json();

      if (data.store) setStore(data.store);
      if (data.changelog) setChangelog(data.changelog);

      const rollbackNotice: ChatMessage = {
        id: `asst_rb_${Date.now()}`,
        role: "assistant",
        content: `Store restored to version v${targetVersion}.`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, rollbackNotice]);

      flashUpdate();
    } catch (err: any) {
      console.error("[Rollback Error]", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Rollback 1 version
  const handleRollbackOne = async () => {
    if (!store || store.version <= 1) return;
    await handleRollbackToVersion(store.version - 1);
  };

  // Switch model+embeddings pair or reranker via backend Router
  const handleSelectRouter = async (selection: {
    modelPair?: ModelPairId;
    reranker?: RerankerMode;
  }) => {
    try {
      const res = await fetch("/api/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      const data = await res.json();
      if (data.routerState) setRouterState(data.routerState);
      if (data.modelConfig) setModelConfig(data.modelConfig);
    } catch (err) {
      console.error("[Router Select Error]", err);
    }
  };

  const handleRefreshRouter = async () => {
    try {
      const res = await fetch("/api/providers/refresh", { method: "POST" });
      const data = await res.json();
      if (data.routerState) setRouterState(data.routerState);
      if (data.modelConfig) setModelConfig(data.modelConfig);
    } catch (err) {
      console.error("[Router Refresh Error]", err);
    }
  };

  // Reset store to Seed v1
  const handleReset = async () => {
    if (!window.confirm("Reset store state back to initial Seed v1?")) return;
    setIsLoading(true);
    try {
      const res = await fetch("/api/store/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      setConversationId(`ui_${Date.now()}`);

      if (!res.ok) throw new Error("Reset failed");
      const data = await res.json();

      if (data.store) setStore(data.store);
      if (data.changelog) setChangelog(data.changelog);

      setMessages([
        {
          id: `asst_reset_${Date.now()}`,
          role: "assistant",
          content: "Store reset to initial Seed v1.",
          timestamp: new Date().toISOString(),
        },
      ]);

      flashUpdate();
    } catch (err: any) {
      console.error("[Reset Error]", err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        backgroundColor: "var(--bg-obsidian)",
      }}
    >
      {/* Top Brand Header */}
      <Header
        store={store}
        telemetry={telemetry}
        modelConfig={modelConfig}
        routerState={routerState}
        onSelectRouter={handleSelectRouter}
        onRefreshRouter={handleRefreshRouter}
        onReset={handleReset}
        onRollback={handleRollbackOne}
        isLoading={isLoading}
      />

      {/* Split Screen Workspace: Left = Chat, Right = Live Store Preview */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <ChatPane
          messages={messages}
          onSendMessage={handleSendMessage}
          onAcceptProposal={handleAcceptProposal}
          onRejectProposal={handleRejectProposal}
          onModifyProposal={handleModifyProposal}
          isLoading={isLoading}
          liveSteps={liveSteps}
        />

        <StorePane
          store={store}
          changelog={changelog}
          onRollbackToVersion={handleRollbackToVersion}
          isUpdated={isUpdated}
          isLoading={isLoading}
          activeTab={activeStoreTab}
          onTabChange={setActiveStoreTab}
        />
      </div>
    </div>
  );
};

export default App;
