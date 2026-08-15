// @vitest-environment jsdom
// The reviewer's acceptance ritual, CI-enforced: start a task, wait ~10s,
// force a remount — elapsed must jump to wall-clock, NEVER reset to 0:00.
// LiveDuration derives from `since` (a task property), not a mount counter, so
// a remount re-derives the same wall-clock value.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LiveDuration } from '../apps/console/src/components/LiveDuration.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('LiveDuration — anchored, remount-safe elapsed', () => {
  it('null since renders 0s', () => {
    render(<LiveDuration since={null} />);
    expect(screen.getByText('0s')).toBeInTheDocument();
  });

  it('ticks to wall-clock from `since`, never below 0', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    // Mount 30s after start → 30s (not 0s).
    vi.setSystemTime(start + 30_000);
    render(<LiveDuration since={start} />);
    expect(screen.getByText('30s')).toBeInTheDocument();

    // 5s later the interval ticks → 35s.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('35s')).toBeInTheDocument();

    // Clamps negatives if the clock is ever before `since`.
    vi.setSystemTime(start - 10_000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('0s')).toBeInTheDocument();
  });

  it('FORCED REMOUNT does not reset the clock — jumps to wall-clock (acceptance ritual)', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(start); // deterministic mount at t+0s
    const { unmount } = render(<LiveDuration since={start} />);
    expect(screen.getByText('0s')).toBeInTheDocument();

    // "wait ~10s" — advance the fake clock; interval fires and re-renders to 10s.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('10s')).toBeInTheDocument();

    // Force a remount of the SAME anchor at t+15s.
    unmount();
    cleanup();
    vi.setSystemTime(start + 15_000);
    const { unmount: unmount2 } = render(<LiveDuration since={start} />);
    // MUST be wall-clock (15s), never reset to 0:00.
    expect(screen.getByText('15s')).toBeInTheDocument();
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
    unmount2();
  });
});