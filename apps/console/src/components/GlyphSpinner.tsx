'use client';

import { useEffect, useState } from 'react';

/**
 * One-char braille glyph spinner. Local port of the vendored hermes-agent
 * kernel primitive (engines/hermes_kernel/vendor/hermes-agent/apps/desktop/
 * src/components/ui/glyph-spinner.tsx), which drives its frames from the
 * `unicode-animations` package. The console deliberately has no such
 * dependency, so the canonical braille frames are inlined here — the visual
 * behavior (one monospace cell, braille cadence, role=status) matches the
 * kernel's, the same way LiveDuration is already ported locally.
 */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

export function GlyphSpinner({
  ariaLabel = 'Working',
  className = 'text-faint',
}: {
  ariaLabel?: string;
  className?: string;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    const id = setInterval(
      () => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length),
      FRAME_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <span
      aria-label={ariaLabel}
      role="status"
      className={`inline-flex items-center justify-center font-mono leading-none tabular-nums ${className}`}
    >
      {BRAILLE_FRAMES[frame]}
    </span>
  );
}
