import React from 'react';

export interface GaugeZone {
  /** Zone ends at this value (inclusive), scale 0–100. */
  upTo: number;
  /** Tailwind-compatible color for this zone's arc + glow (hex or CSS color). */
  color: string;
  label?: string;
}

interface GaugeProps {
  /** 0–100. Values outside are clamped. */
  value: number;
  zones: GaugeZone[];
  /** Big number under the needle, e.g. "62". Defaults to `value`. */
  readout?: string | number;
  /** Small caption under the readout, e.g. "חמדנות". */
  caption?: string;
  size?: number;
  className?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// A 0–100 dashboard dial in the shape of a car speedometer: a 220° sweep
// (car dials overshoot a flat semicircle so the needle has somewhere to go
// at both extremes), a colored danger/safe arc, chrome tick marks every 10
// units, and a glowing needle over a digital-style readout. Pure SVG — no
// charting library, and every angle is computed from `value` so the needle
// position and the arc are never hand-tuned separately.
const START_ANGLE = -110; // degrees, measured from the dial's 12-o'clock-less flat top
const END_ANGLE = 110;
const SWEEP = END_ANGLE - START_ANGLE;

function angleFor(pct: number): number {
  return START_ANGLE + (clamp(pct, 0, 100) / 100) * SWEEP;
}

function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p0 = polarToXY(cx, cy, r, a0);
  const p1 = polarToXY(cx, cy, r, a1);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} 1 ${p1.x} ${p1.y}`;
}

export const Gauge: React.FC<GaugeProps> = ({ value, zones, readout, caption, size = 220, className }) => {
  const v = clamp(value, 0, 100);
  const cx = size / 2;
  const cy = size / 2 + size * 0.06;
  const rOuter = size * 0.42;
  const rZone = size * 0.40;
  const rTick = size * 0.34;
  const rTickLabel = size * 0.26;
  const needleAngle = angleFor(v);
  const zoneColor = [...zones].reverse().find((z) => v <= z.upTo)?.color ?? zones[zones.length - 1]?.color ?? '#666';

  // Build colored zone arcs from cumulative `upTo` boundaries.
  let prevUpTo = 0;
  const zoneArcs = zones.map((z, i) => {
    const a0 = angleFor(prevUpTo);
    const a1 = angleFor(z.upTo);
    prevUpTo = z.upTo;
    return <path key={i} d={arcPath(cx, cy, rZone, a0, a1)} fill="none" stroke={z.color} strokeWidth={size * 0.05} strokeLinecap="butt" opacity={0.85} />;
  });

  const ticks = Array.from({ length: 11 }, (_, i) => i * 10);

  const needleTip = polarToXY(cx, cy, rOuter - size * 0.02, needleAngle);
  const needleBase1 = polarToXY(cx, cy, size * 0.045, needleAngle + 90);
  const needleBase2 = polarToXY(cx, cy, size * 0.045, needleAngle - 90);

  return (
    <svg
      viewBox={`0 0 ${size} ${size * 0.82}`}
      width="100%"
      className={className}
      role="img"
      aria-label={caption ? `${caption}: ${readout ?? v}` : `${v}`}
    >
      <defs>
        <radialGradient id={`gauge-bezel-${size}`} cx="50%" cy="35%" r="75%">
          <stop offset="0%" stopColor="var(--gauge-face-hi, #1c2129)" />
          <stop offset="100%" stopColor="var(--gauge-face-lo, #0a0d12)" />
        </radialGradient>
        <filter id={`gauge-glow-${size}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={size * 0.012} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Bezel */}
      <circle cx={cx} cy={cy} r={rOuter + size * 0.035} fill={`url(#gauge-bezel-${size})`} stroke="var(--gauge-rim, #3a4150)" strokeWidth={size * 0.012} />

      {/* Track (unfilled dial groove) */}
      <path d={arcPath(cx, cy, rZone, START_ANGLE, END_ANGLE)} fill="none" stroke="var(--gauge-track, #232933)" strokeWidth={size * 0.052} strokeLinecap="round" />

      {/* Colored zones */}
      <g strokeLinecap="butt">{zoneArcs}</g>

      {/* Tick marks + labels */}
      {ticks.map((t) => {
        const a = angleFor(t);
        const p0 = polarToXY(cx, cy, rTick, a);
        const p1 = polarToXY(cx, cy, rTick - size * 0.028, a);
        const lbl = polarToXY(cx, cy, rTickLabel, a);
        const major = t % 20 === 0;
        return (
          <g key={t}>
            <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="var(--gauge-tick, #8b96a8)" strokeWidth={major ? size * 0.008 : size * 0.005} />
            {major && (
              <text x={lbl.x} y={lbl.y} fontSize={size * 0.045} fill="var(--gauge-tick-label, #6b7686)" textAnchor="middle" dominantBaseline="middle" fontFamily="var(--gauge-font, ui-monospace, monospace)">
                {t}
              </text>
            )}
          </g>
        );
      })}

      {/* Needle */}
      <g filter={`url(#gauge-glow-${size})`}>
        <polygon
          points={`${needleTip.x},${needleTip.y} ${needleBase1.x},${needleBase1.y} ${needleBase2.x},${needleBase2.y}`}
          fill={zoneColor}
        />
      </g>
      <circle cx={cx} cy={cy} r={size * 0.05} fill="var(--gauge-hub, #12151b)" stroke={zoneColor} strokeWidth={size * 0.01} />

      {/* Digital readout */}
      <text
        x={cx}
        y={cy + size * 0.20}
        fontSize={size * 0.16}
        fontWeight={700}
        fill={zoneColor}
        textAnchor="middle"
        fontFamily="var(--gauge-font, ui-monospace, monospace)"
        style={{ filter: `drop-shadow(0 0 ${size * 0.02}px ${zoneColor})` }}
      >
        {readout ?? v}
      </text>
      {caption && (
        <text x={cx} y={cy + size * 0.30} fontSize={size * 0.052} fill="var(--gauge-caption, #8b96a8)" textAnchor="middle" letterSpacing={1} fontFamily="var(--gauge-font, ui-monospace, monospace)">
          {caption}
        </text>
      )}
    </svg>
  );
};

export default Gauge;
