// @vitest-environment jsdom
// The reviewer's acceptance ritual, CI-enforced: start a task, wait ~10s,
// force a remount — elapsed must jump to wall-clock, NEVER reset to 0:00.
// LiveDuration derives from `since` (a task property), not a mount counter, so
// a remount re-derives the same wall-clock value.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LiveDuration, formatElapsed } from '../apps/console/src/components/LiveDuration.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('formatElapsed — pure m:ss rendering', () => {
  it('renders m:ss with a zero-padded second field', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9)).toBe('0:09');
    expect(formatElapsed(59)).toBe('0:59');
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(90)).toBe('1:30');
    expect(formatElapsed(600)).toBe('10:00');
  });

  it('clamps negative counts to 0:00', () => {
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('LiveDuration — anchored, remount-safe elapsed', () => {
  it('null since renders 0:00', () => {
    render(<LiveDuration since={null} />);
    expect(screen.getByText('0:00')).toBeInTheDocument();
  });

  it('ticks to wall-clock from `since`, never below 0', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    // Mount 30s after start → 0:30 (not 0:00).
    vi.setSystemTime(start + 30_000);
    render(<LiveDuration since={start} />);
    expect(screen.getByText('0:30')).toBeInTheDocument();

    // 5s later the interval ticks → 0:35.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('0:35')).toBeInTheDocument();

    // Clamps negatives if the clock is ever before `since`.
    vi.setSystemTime(start - 10_000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('0:00')).toBeInTheDocument();
  });

  it('rolls over the minute boundary on tick', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(start + 59_000);
    render(<LiveDuration since={start} />);
    expect(screen.getByText('0:59')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('1:00')).toBeInTheDocument();
  });

  it('FORCED REMOUNT does not reset the clock — jumps to wall-clock (acceptance ritual)', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(start); // deterministic mount at t+0s
    const { unmount } = render(<LiveDuration since={start} />);
    expect(screen.getByText('0:00')).toBeInTheDocument();

    // "wait ~10s" — advance the fake clock; interval fires and re-renders to 0:10.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('0:10')).toBeInTheDocument();

    // Force a remount of the SAME anchor at t+15s.
    unmount();
    cleanup();
    vi.setSystemTime(start + 15_000);
    const { unmount: unmount2 } = render(<LiveDuration since={start} />);
    // MUST be wall-clock (0:1x), never reset to 0:00.
    expect(screen.getByText('0:15')).toBeInTheDocument();
    expect(screen.queryByText('0:00')).not.toBeInTheDocument();
    unmount2();
  });
});
