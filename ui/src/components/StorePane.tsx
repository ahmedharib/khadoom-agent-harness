import React from "react";
import { MtajirStore, ChangelogEntry } from "../types.js";
import {
  Package,
  CreditCard,
  Truck,
  Palette,
  History,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";

export type StoreTabType = "products" | "payments" | "shipping" | "theme" | "changelog";

interface StorePaneProps {
  store: MtajirStore | null;
  changelog: ChangelogEntry[];
  onRollbackToVersion: (version: number) => Promise<void>;
  isUpdated: boolean;
  isLoading: boolean;
  activeTab: StoreTabType;
  onTabChange: (tab: StoreTabType) => void;
}

export const StorePane: React.FC<StorePaneProps> = ({
  store,
  changelog,
  onRollbackToVersion,
  isUpdated,
  isLoading,
  activeTab,
  onTabChange,
}) => {
  const setActiveTab = onTabChange;

  if (!store) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
          backgroundColor: "var(--bg-obsidian)",
          height: "calc(100vh - 64px)",
        }}
      >
        Loading live store state...
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 64px)",
        backgroundColor: "var(--bg-obsidian)",
        overflow: "hidden",
      }}
    >
      {/* Tab Navigation Header (5 equal-width segmented tabs) */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            backgroundColor: "var(--surface-charcoal)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "9999px",
            padding: "3px",
            gap: "4px",
          }}
        >
          <button
            onClick={() => setActiveTab("products")}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: "9999px",
              border: "none",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              backgroundColor:
                activeTab === "products" ? "var(--surface-active)" : "transparent",
              color:
                activeTab === "products"
                  ? "var(--text-white)"
                  : "var(--text-secondary)",
              transition: "all 0.15s ease",
            }}
          >
            <Package size={13} />
            <span>Products ({store.products.length})</span>
          </button>

          <button
            onClick={() => setActiveTab("payments")}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: "9999px",
              border: "none",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              backgroundColor:
                activeTab === "payments" ? "var(--surface-active)" : "transparent",
              color:
                activeTab === "payments"
                  ? "var(--text-white)"
                  : "var(--text-secondary)",
              transition: "all 0.15s ease",
            }}
          >
            <CreditCard size={13} />
            <span>Payments</span>
          </button>

          <button
            onClick={() => setActiveTab("shipping")}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: "9999px",
              border: "none",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              backgroundColor:
                activeTab === "shipping" ? "var(--surface-active)" : "transparent",
              color:
                activeTab === "shipping"
                  ? "var(--text-white)"
                  : "var(--text-secondary)",
              transition: "all 0.15s ease",
            }}
          >
            <Truck size={13} />
            <span>Shipping</span>
          </button>

          <button
            onClick={() => setActiveTab("theme")}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: "9999px",
              border: "none",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              backgroundColor:
                activeTab === "theme" ? "var(--surface-active)" : "transparent",
              color:
                activeTab === "theme"
                  ? "var(--text-white)"
                  : "var(--text-secondary)",
              transition: "all 0.15s ease",
            }}
          >
            <Palette size={13} />
            <span>Theme & Banner</span>
          </button>

          <button
            onClick={() => setActiveTab("changelog")}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: "9999px",
              border: "none",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              backgroundColor:
                activeTab === "changelog" ? "var(--surface-active)" : "transparent",
              color:
                activeTab === "changelog"
                  ? "var(--text-white)"
                  : "var(--text-secondary)",
              transition: "all 0.15s ease",
            }}
          >
            <History size={13} />
            <span>Changelog ({changelog.length})</span>
          </button>
        </div>
      </div>

      {/* Tab Content Area */}
      <div
        className={isUpdated ? "flash-updated" : ""}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
        }}
      >
        {/* Banner Preview if Enabled */}
        {store.theme.banner.enabled && (
          <div
            style={{
              backgroundColor: store.theme.banner.backgroundColor || "var(--status-amber-bg)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: "12px",
              padding: "12px 18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-white)",
            }}
          >
            <span>📢 {store.theme.banner.text}</span>
            <span
              style={{
                fontSize: "10.5px",
                textTransform: "uppercase",
                backgroundColor: "rgba(0, 0, 0, 0.3)",
                padding: "2px 8px",
                borderRadius: "9999px",
              }}
            >
              Active Storefront Banner
            </span>
          </div>
        )}

        {/* 1. PRODUCTS TAB */}
        {activeTab === "products" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
                Store Catalog ({store.products.length} Products)
              </h4>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                Currency: <strong style={{ color: "var(--text-white)" }}>{store.currency}</strong>
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "14px",
              }}
            >
              {store.products.map((p) => (
                <div
                  key={p.id}
                  style={{
                    backgroundColor: "var(--surface-charcoal)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "14px",
                    padding: "16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: "14px",
                          fontWeight: 700,
                          color: "var(--text-white)",
                        }}
                      >
                        {p.title}
                      </div>
                      <div
                        style={{
                          fontSize: "11.5px",
                          color: "var(--text-secondary)",
                          marginTop: "2px",
                        }}
                      >
                        SKU: {p.sku}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        padding: "2px 7px",
                        borderRadius: "9999px",
                        backgroundColor:
                          p.status === "active"
                            ? "rgba(110, 231, 183, 0.15)"
                            : "rgba(255, 255, 255, 0.05)",
                        color:
                          p.status === "active"
                            ? "var(--status-emerald)"
                            : "var(--text-muted)",
                      }}
                    >
                      {p.status}
                    </span>
                  </div>

                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                      lineHeight: "1.4",
                    }}
                  >
                    {p.description}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      marginTop: "auto",
                      paddingTop: "8px",
                      borderTop: "1px solid rgba(255, 255, 255, 0.05)",
                    }}
                  >
                    <div>
                      <span
                        style={{
                          fontSize: "18px",
                          fontWeight: 700,
                          color: "var(--text-white)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {p.price} {store.currency}
                      </span>
                      {p.compareAtPrice && (
                        <span
                          style={{
                            fontSize: "12px",
                            color: "var(--text-muted)",
                            textDecoration: "line-through",
                            marginLeft: "6px",
                          }}
                        >
                          {p.compareAtPrice} {store.currency}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: "11.5px",
                        color:
                          p.inventory > 10
                            ? "var(--text-secondary)"
                            : "var(--status-amber)",
                        fontWeight: 600,
                      }}
                    >
                      Stock: {p.inventory}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2. PAYMENTS TAB */}
        {activeTab === "payments" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
              Payment Gateways & Methods
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {store.paymentProviders.map((provider) => (
                <div
                  key={provider.id}
                  style={{
                    backgroundColor: "var(--surface-charcoal)",
                    border: `1px solid ${
                      provider.enabled ? "var(--border-secondary)" : "var(--border-subtle)"
                    }`,
                    borderRadius: "14px",
                    padding: "16px 20px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                    <div
                      style={{
                        width: "36px",
                        height: "36px",
                        borderRadius: "10px",
                        backgroundColor: provider.enabled
                          ? "rgba(110, 231, 183, 0.12)"
                          : "rgba(255, 255, 255, 0.03)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <CreditCard
                        size={18}
                        color={
                          provider.enabled
                            ? "var(--status-emerald)"
                            : "var(--text-muted)"
                        }
                      />
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: "14px",
                          fontWeight: 700,
                          color: "var(--text-white)",
                        }}
                      >
                        {provider.name}
                      </div>
                      <div
                        style={{
                          fontSize: "11.5px",
                          color: "var(--text-secondary)",
                        }}
                      >
                        Gateway ID: <code style={{ fontFamily: "monospace" }}>{provider.id}</code> •{" "}
                        {provider.testMode ? "Sandbox / Test Mode" : "Live Mode"}
                      </div>
                    </div>
                  </div>

                  <span
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 700,
                      padding: "4px 12px",
                      borderRadius: "9999px",
                      display: "flex",
                      alignItems: "center",
                      gap: "5px",
                      backgroundColor: provider.enabled
                        ? "rgba(110, 231, 183, 0.15)"
                        : "rgba(255, 255, 255, 0.05)",
                      color: provider.enabled
                        ? "var(--status-emerald)"
                        : "var(--text-muted)",
                    }}
                  >
                    {provider.enabled ? (
                      <>
                        <CheckCircle2 size={13} /> Enabled
                      </>
                    ) : (
                      <>
                        <XCircle size={13} /> Disabled
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 3. SHIPPING TAB */}
        {activeTab === "shipping" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
              Shipping Zones & Rates
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {store.shippingZones.map((zone) => (
                <div
                  key={zone.id}
                  style={{
                    backgroundColor: "var(--surface-charcoal)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "14px",
                    padding: "18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: "14.5px",
                          fontWeight: 700,
                          color: "var(--text-white)",
                        }}
                      >
                        {zone.name}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          marginTop: "2px",
                        }}
                      >
                        Countries: {zone.countries.join(", ")}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "var(--text-secondary)",
                        backgroundColor: "rgba(255, 255, 255, 0.04)",
                        padding: "3px 10px",
                        borderRadius: "9999px",
                      }}
                    >
                      {zone.rates.length} {zone.rates.length === 1 ? "Rate" : "Rates"}
                    </span>
                  </div>

                  <div
                    style={{
                      backgroundColor: "var(--surface-hover)",
                      borderRadius: "10px",
                      overflow: "hidden",
                    }}
                  >
                    {zone.rates.map((rate, rIdx) => (
                      <div
                        key={rate.id}
                        style={{
                          padding: "10px 14px",
                          borderBottom:
                            rIdx === zone.rates.length - 1
                              ? "none"
                              : "1px solid var(--border-subtle)",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: "12.5px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <strong style={{ color: "var(--text-white)" }}>
                            {rate.name}
                          </strong>
                          {rate.freeAboveAmount !== undefined && (
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "var(--status-emerald)",
                                backgroundColor: "rgba(110, 231, 183, 0.1)",
                                padding: "2px 8px",
                                borderRadius: "9999px",
                              }}
                            >
                              Free above {rate.freeAboveAmount} {store.currency}
                            </span>
                          )}
                        </div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: "var(--text-white)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {rate.price === 0
                            ? "Free"
                            : `${rate.price} ${store.currency}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 4. THEME & BANNER TAB */}
        {activeTab === "theme" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
              Theme Styling & Storefront Branding
            </h4>
            <div
              style={{
                backgroundColor: "var(--surface-charcoal)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "14px",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                  }}
                >
                  Store Name & Description
                </label>
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: 700,
                    color: "var(--text-white)",
                    marginTop: "4px",
                  }}
                >
                  {store.name}
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                    marginTop: "2px",
                  }}
                >
                  {store.description}
                </div>
              </div>

              <div style={{ display: "flex", gap: "24px" }}>
                <div>
                  <label
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      textTransform: "uppercase",
                    }}
                  >
                    Primary Theme Color
                  </label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginTop: "6px",
                    }}
                  >
                    <span
                      style={{
                        width: "24px",
                        height: "24px",
                        borderRadius: "6px",
                        backgroundColor: store.theme.colors.primary,
                        border: "1px solid rgba(255, 255, 255, 0.2)",
                        display: "inline-block",
                      }}
                    />
                    <code
                      style={{
                        fontSize: "13px",
                        color: "var(--text-white)",
                        fontFamily: "monospace",
                      }}
                    >
                      {store.theme.colors.primary}
                    </code>
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      textTransform: "uppercase",
                    }}
                  >
                    Secondary Color
                  </label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginTop: "6px",
                    }}
                  >
                    <span
                      style={{
                        width: "24px",
                        height: "24px",
                        borderRadius: "6px",
                        backgroundColor: store.theme.colors.secondary,
                        border: "1px solid rgba(255, 255, 255, 0.2)",
                        display: "inline-block",
                      }}
                    />
                    <code
                      style={{
                        fontSize: "13px",
                        color: "var(--text-white)",
                        fontFamily: "monospace",
                      }}
                    >
                      {store.theme.colors.secondary}
                    </code>
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      textTransform: "uppercase",
                    }}
                  >
                    Banner Status
                  </label>
                  <div style={{ marginTop: "6px" }}>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "3px 10px",
                        borderRadius: "9999px",
                        backgroundColor: store.theme.banner.enabled
                          ? "rgba(110, 231, 183, 0.15)"
                          : "rgba(255, 255, 255, 0.05)",
                        color: store.theme.banner.enabled
                          ? "var(--status-emerald)"
                          : "var(--text-muted)",
                      }}
                    >
                      {store.theme.banner.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 5. CHANGELOG & ROLLBACK TAB */}
        {activeTab === "changelog" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
              Version Changelog & Instant Rollback
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {changelog
                .slice()
                .reverse()
                .map((entry) => {
                  const isCurrent = entry.version === store.version;
                  return (
                    <div
                      key={entry.version}
                      style={{
                        backgroundColor: "var(--surface-charcoal)",
                        border: `1px solid ${
                          isCurrent ? "var(--accent-lavender)" : "var(--border-subtle)"
                        }`,
                        borderRadius: "14px",
                        padding: "16px 20px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: 700,
                              color: isCurrent
                                ? "var(--accent-lavender)"
                                : "var(--text-white)",
                            }}
                          >
                            v{entry.version}
                          </span>
                          {isCurrent && (
                            <span
                              style={{
                                fontSize: "10px",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                backgroundColor: "rgba(165, 148, 249, 0.15)",
                                color: "var(--accent-lavender)",
                                padding: "2px 7px",
                                borderRadius: "9999px",
                              }}
                            >
                              Current
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: "11.5px",
                              color: "var(--text-muted)",
                            }}
                          >
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: "13px",
                            color: "var(--text-white)",
                            marginTop: "4px",
                          }}
                        >
                          {entry.explanation}
                        </div>
                        <div
                          style={{
                            fontSize: "11.5px",
                            color: "var(--text-secondary)",
                            marginTop: "2px",
                          }}
                        >
                          {entry.patches.length} JSON Patches applied
                        </div>
                      </div>

                      {!isCurrent && (
                        <button
                          onClick={() => onRollbackToVersion(entry.version)}
                          disabled={isLoading}
                          style={{
                            backgroundColor: "transparent",
                            color: "var(--text-white)",
                            border: "1px solid var(--border-secondary)",
                            borderRadius: "9999px",
                            padding: "6px 14px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: isLoading ? "not-allowed" : "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "5px",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(255, 255, 255, 0.05)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor = "transparent")
                          }
                        >
                          <RotateCcw size={12} />
                          <span>Restore v{entry.version}</span>
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
