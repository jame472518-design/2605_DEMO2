import type { FaceBox } from "../lib/faceTracker";

/**
 * FaceOverlay - SVG layer that draws a bold green tracking box around each
 * detected face. Sits above the camera <img>/<video> via absolute positioning.
 *
 * Visual recipe:
 *   - Full rectangle outline in green (clearly visible all around)
 *   - 4 thicker corner brackets overlaid for the tactical look
 *   - SVG drop-shadow filter gives the box a soft green glow so it pops
 *     against busy backgrounds
 *
 * Coordinates: viewBox is 0..100 (= percent), strokes use vectorEffect
 * non-scaling-stroke so they render at a constant screen-pixel weight
 * regardless of how the camera frame is scaled to the surface.
 */

type Props = {
  faces: FaceBox[];
  /** Optional 0..1 timer progress to render a thin bar above each box. */
  presenceProgress?: number;
};

const GREEN = "#22c55e"; // sage / green-500

export function FaceOverlay({ faces, presenceProgress }: Props) {
  if (faces.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-20"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ filter: `drop-shadow(0 0 4px ${GREEN}) drop-shadow(0 0 8px ${GREEN}aa)` }}
    >
      {faces.map((f, i) => {
        // 0..1 → 0..100 viewBox units (= percent).
        const x = f.x * 100;
        const y = f.y * 100;
        const w = f.w * 100;
        const h = f.h * 100;
        const cornerLen = Math.min(w, h) * 0.28;
        return (
          <g key={i}>
            {/* Full rectangle — bold green outline so the box is obvious. */}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              stroke={GREEN}
              strokeWidth="2.5"
              strokeOpacity="0.85"
              fill="none"
              vectorEffect="non-scaling-stroke"
              rx="0.5"
              ry="0.5"
            />
            {/* 4 thicker corner brackets layered on top for the tactical look. */}
            <path
              d={`M ${x} ${y + cornerLen} L ${x} ${y} L ${x + cornerLen} ${y}`}
              stroke={GREEN}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x + w - cornerLen} ${y} L ${x + w} ${y} L ${x + w} ${y + cornerLen}`}
              stroke={GREEN}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x + w} ${y + h - cornerLen} L ${x + w} ${y + h} L ${x + w - cornerLen} ${y + h}`}
              stroke={GREEN}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x + cornerLen} ${y + h} L ${x} ${y + h} L ${x} ${y + h - cornerLen}`}
              stroke={GREEN}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            {/* 5s timer fill bar above the box. */}
            {typeof presenceProgress === "number" && presenceProgress > 0 && (
              <rect
                x={x}
                y={y - 2.5}
                width={w * presenceProgress}
                height="1.2"
                fill={GREEN}
                opacity={0.95}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
