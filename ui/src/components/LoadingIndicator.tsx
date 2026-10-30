import React from "react";

interface TextShimmerProps {
  children: React.ReactNode;
  duration?: string;
  style?: React.CSSProperties;
}

/**
 * Loading UI (@loading-ui/text-shimmer)
 * Sweeps a smooth luminance highlight across AI assistant status text.
 */
export const TextShimmer: React.FC<TextShimmerProps> = ({
  children,
  duration = "2.1s",
  style,
}) => {
  return (
    <span
      className="loading-ui-text-shimmer"
      style={
        {
          "--shimmer-duration": duration,
          fontWeight: 500,
          fontSize: "13px",
          letterSpacing: "0.01em",
          ...style,
        } as React.CSSProperties
      }
    >
      {children}
    </span>
  );
};

interface PulsatingDotsProps {
  style?: React.CSSProperties;
}

/**
 * Loading UI (@loading-ui/pulsating-dots)
 * Sequential scale-and-opacity dot indicator tailored for conversational waits.
 */
export const PulsatingDots: React.FC<PulsatingDotsProps> = ({ style }) => {
  return (
    <span
      role="status"
      aria-label="Loading response"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        ...style,
      }}
    >
      <span
        className="loading-ui-pulsating-dot"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="loading-ui-pulsating-dot"
        style={{ animationDelay: "180ms" }}
      />
      <span
        className="loading-ui-pulsating-dot"
        style={{ animationDelay: "360ms" }}
      />
    </span>
  );
};
