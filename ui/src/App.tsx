import React, { useState, useEffect } from "react";
import {
  MtajirStore,
  ChangelogEntry,
  TelemetrySummary,
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUpdated, setIsUpdated] = useState<boolean>(false);
  const [activeStoreTab, setActiveStoreTab] = useState<StoreTabType>("products");

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
    } catch (err) {
      console.error("[Init Error]", err);
    }
  };

  useEffect(() => {
    loadStore();
  }, []);

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
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) throw new Error("Agent turn request failed");
      const data = await res.json();

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
        stagedMutation: staged,
        navigationRoute: data.navigationRoute,
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
      const res = await fetch("/api/staging/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, feedback }),
      });

      if (!res.ok) throw new Error("Failed to modify staging session");
      const data = await res.json();

      // Mark old proposal as rejected
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

      const staged: StagingSession | undefined = data.stagingSession || data.stagedMutation;
      const updatedMsg: ChatMessage = {
        id: `asst_mod_${Date.now()}`,
        role: "assistant",
        content:
          data.answerText ||
          (staged
            ? "Updated staged proposal based on your feedback:"
            : data.message || data.reply || "Proposal updated based on your feedback."),
        citations: data.citations || [],
        stagedMutation: staged,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, updatedMsg]);
      if (data.currentStore) setStore(data.currentStore);
      if (data.changelog) setChangelog(data.changelog);

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

  // Reset store to Seed v1
  const handleReset = async () => {
    if (!window.confirm("Reset store state back to initial Seed v1?")) return;
    setIsLoading(true);
    try {
      const res = await fetch("/api/store/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

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
