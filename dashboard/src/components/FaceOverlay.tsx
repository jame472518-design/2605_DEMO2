import type { FaceBox } from "../lib/faceTracker";

/**
 * FaceOverlay - SVG layer that draws green tactical brackets around each
 * detected face. Sits above the camera <img> via absolute positioning.
 *
 * Boxes use percent coordinates so they scale with whatever object-cover /
 * object-contain mode the host image uses. Container must be `relative`.
 */

type Props = {
  faces: FaceBox[];
  /** Optional "5s timer" progress 0..1; if > 0, draws a thin ring around
   *  each face to signal the auto-detect timer is accumulating. */
  presenceProgress?: number;
};

export function FaceOverlay({ faces, presenceProgress }: Props) {
  if (faces.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-20"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {faces.map((f, i) => {
        // Convert 0..1 to 0..100 (viewBox units = percent)
        const x = f.x * 100;
        const y = f.y * 100;
        const w = f.w * 100;
        const h = f.h * 100;
        const cornerLen = Math.min(w, h) * 0.18;
        const c = "#22c55e"; // sage / green-500
        return (
          <g key={i}>
            {/* 4 corner brackets (tactical look, not a solid rectangle) */}
            <path
              d={`M ${x} ${y + cornerLen} L ${x} ${y} L ${x + cornerLen} ${y}`}
              stroke={c}
              strokeWidth="0.5"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x + w - cornerLen} ${y} L ${x + w} ${y} L ${x + w} ${y + cornerLen}`}
              stroke={c}
              strokeWidth="0.5"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x + w} ${y + h - cornerLen} L ${x + w} ${y + h} L ${x + w - cornerLen} ${y + h}`}
              stroke={c}
              strokeWidth="0.5"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x + cornerLen} ${y + h} L ${x} ${y + h} L ${x} ${y + h - cornerLen}`}
              stroke={c}
              strokeWidth="0.5"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            {/* Faint full rect for visual coherence at distance */}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              stroke={c}
              strokeOpacity="0.25"
              strokeWidth="0.3"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            {/* Score / progress badge top-left of box (small) */}
            {typeof presenceProgress === "number" && presenceProgress > 0 && (
              <rect
                x={x}
                y={y - 2}
                width={w * presenceProgress}
                height="0.7"
                fill={c}
                opacity={0.85}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
