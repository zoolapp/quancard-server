import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F9: the web client locks after 60 s in the background (timer while hidden,
 * re-checked on return) and lock revokes the reveal grace. Minimal DOM stubs;
 * the lifecycle code only uses events, visibilityState and a dataset.
 */

type Doc = EventTarget & { visibilityState: string; documentElement: { dataset: Record<string, string> }; hasFocus: () => boolean };

let doc: Doc;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible", documentElement: { dataset: {} as Record<string, string> }, hasFocus: () => true });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function readySession() {
  const session = await import("../src/session.js");
  session.installLifecycleGuards();
  session.phase.value = "ready";
  session.revealGrace.until = Date.now() + 5 * 60_000;
  return session;
}

function setVisibility(state: "hidden" | "visible") {
  doc.visibilityState = state;
  doc.dispatchEvent(new Event("visibilitychange"));
}

describe("background lock", () => {
  it("locks after 60 seconds hidden even if the tab never becomes visible again", async () => {
    const session = await readySession();
    setVisibility("hidden");
    expect(doc.documentElement.dataset.privacy).toBe("on");
    vi.advanceTimersByTime(59_000);
    expect(session.phase.value).toBe("ready");
    vi.advanceTimersByTime(2_000);
    expect(session.phase.value).toBe("unlock");
    expect(session.revealGrace.until).toBe(0);
  });

  it("returning within 60 seconds keeps the session and removes the privacy cover", async () => {
    const session = await readySession();
    setVisibility("hidden");
    vi.advanceTimersByTime(30_000);
    setVisibility("visible");
    vi.advanceTimersByTime(60_000);
    expect(session.phase.value).toBe("ready");
    expect(doc.documentElement.dataset.privacy).toBeUndefined();
  });

  it("locks on return when timers were throttled past the limit", async () => {
    const session = await readySession();
    setVisibility("hidden");
    // Simulate a frozen tab: the clock moves but the timer has not fired.
    vi.setSystemTime(Date.now() + 120_000);
    setVisibility("visible");
    expect(session.phase.value).toBe("unlock");
  });
});
