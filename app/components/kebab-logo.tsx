interface KebabLogoProps {
  size?: number;
  className?: string;
}

/**
 * Kebab skewer logo — a diagonal rod threaded with three pieces
 * (circle, rotated square, circle). Uses `currentColor` so it adapts
 * to whatever text color the surrounding element carries.
 */
export function KebabLogo({ size = 24, className = "" }: KebabLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <line
        x1="3.2"
        y1="20.8"
        x2="20.8"
        y2="3.2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="6.8" cy="17.2" r="2.6" fill="currentColor" />
      <rect
        x="9.4"
        y="9.4"
        width="5.2"
        height="5.2"
        rx="0.6"
        transform="rotate(45 12 12)"
        fill="currentColor"
      />
      <circle cx="17.2" cy="6.8" r="2.6" fill="currentColor" />
    </svg>
  );
}
