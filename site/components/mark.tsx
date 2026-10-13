"use client";

import { useEffect, useRef } from "react";
import { markCuts, markCutWidth, markPen, markStrands, markViewBox } from "./mark-path";

// The ntwine mark, drawn as the three threads it is: on load each thread's dash is parked at its full
// length and the transition in global.css unrolls all three together. Each thread's under-crossings are
// a mask, so the weave holds while they draw. Reduced motion skips the draw.
export function Mark({ className }: { className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!svg.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const strands = [...svg.current.querySelectorAll<SVGPathElement>(".mark-strand")];
    for (const el of strands) {
      const len = el.getTotalLength();
      el.style.transition = "none";
      el.style.strokeDasharray = String(len);
      el.style.strokeDashoffset = String(len);
    }
    svg.current.getBoundingClientRect();
    for (const el of strands) {
      el.style.transition = "";
      el.style.strokeDashoffset = "0";
    }
  }, []);
  return (
    <svg ref={svg} viewBox={markViewBox} xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <defs>
        <radialGradient id="mark-ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="250">
          <stop offset="0" stopColor="#87f1e0" />
          <stop offset="0.62" stopColor="#36d8c3" />
          <stop offset="1" stopColor="#11b29f" />
        </radialGradient>
        {markCuts.map((cut, i) =>
          cut ? (
            <mask key={i} id={`mark-cut-${i}`} maskUnits="userSpaceOnUse" x="-64" y="-64" width="640" height="640">
              <rect x="-64" y="-64" width="640" height="640" fill="#fff" />
              <path d={cut} fill="none" stroke="#000" strokeWidth={markCutWidth} strokeLinecap="butt" />
            </mask>
          ) : null,
        )}
      </defs>
      {markStrands.map((d, i) => (
        <path
          key={i}
          className="mark-strand"
          d={d}
          mask={markCuts[i] ? `url(#mark-cut-${i})` : undefined}
          fill="none"
          stroke="url(#mark-ink)"
          strokeWidth={markPen}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
