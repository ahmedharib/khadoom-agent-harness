import React from "react";

interface KhadoomIconProps {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}

export const KhadoomIcon: React.FC<KhadoomIconProps> = ({
  size = 18,
  color = "currentColor",
  style,
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block", ...style }}
    >
      {/* Top crown / taqiyah dome */}
      <path d="M8 4C8 2.1 9.7 1.1 12 1.1C14.3 1.1 16 2.1 16 4" />
      {/* Agal headband */}
      <rect x="5.4" y="4" width="13.2" height="3" rx="1.4" />
      {/* Ghutra outer scarf drapes */}
      <path d="M5.4 7C4.4 7.3 3.8 8.1 3.8 9.2V15.3C3.8 16.1 4.4 16.6 5.4 16.6H7.2" />
      <path d="M18.6 7C19.6 7.3 20.2 8.1 20.2 9.2V15.3C20.2 16.1 19.6 16.6 18.6 16.6H16.8" />
      {/* Face contour */}
      <path d="M6.9 7V13.3C6.9 15.1 8.8 16.1 12 16.1C15.2 16.1 17.1 15.1 17.1 13.3V7" />
      {/* Eyes */}
      <circle cx="9.7" cy="9.9" r="1.05" fill={color} stroke="none" />
      <circle cx="14.3" cy="9.9" r="1.05" fill={color} stroke="none" />
      {/* Mustache / goatee arch */}
      <path d="M8.9 15.8C8.9 13.6 10.1 12.7 12 12.7C13.9 12.7 15.1 13.6 15.1 15.8" />
      {/* Thobe / Bisht shoulders & bottom hem */}
      <path d="M5.8 16.6C4 16.9 2.9 18 2.9 19.6V22.9H21.1V19.6C21.1 18 20 16.9 18.2 16.6" />
      {/* Center placket */}
      <line x1="12" y1="16.1" x2="12" y2="22.9" />
    </svg>
  );
};
