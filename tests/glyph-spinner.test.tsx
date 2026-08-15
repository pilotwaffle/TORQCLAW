// @vitest-environment jsdom
// GlyphSpinner — the kernel spinner primitive, locally ported (see the
// component's header comment for the port rationale).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GlyphSpinner } from '../apps/console/src/components/GlyphSpinner.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('GlyphSpinner', () => {
  it('renders a role=status cell with the default aria label', () => {
    render(<GlyphSpinner />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'Working');
    expect(el.textContent).toBe('⠋'); // first braille frame
  });

  it('advances frames on its interval and wraps around', () => {
    render(<GlyphSpinner />);
    const el = screen.getByRole('status');
    act(() => {
      vi.advanceTimersByTime(80); // one frame interval
    });
    expect(el.textContent).toBe('⠙');
    act(() => {
      vi.advanceTimersByTime(80 * 9); // 9 more -> wrapped to frame 0
    });
    expect(el.textContent).toBe('⠋');
  });

  it('honors a custom aria label', () => {
    render(<GlyphSpinner ariaLabel="task running" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'task running');
  });
});
