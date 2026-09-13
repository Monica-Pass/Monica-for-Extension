import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { subscribeForegroundClock } from "./foreground-clock";

afterEach(() => vi.useRealTimers());

it("shares one clock, pauses while hidden, resumes immediately and disposes after the last subscriber", () => {
  vi.useFakeTimers();
  const dom = new JSDOM('', { pretendToBeVisual: true });
  let hidden = false;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  const first = vi.fn();
  const second = vi.fn();
  const start = vi.spyOn(dom.window, 'setInterval');
  const stopFirst = subscribeForegroundClock(first, dom.window.document);
  const stopSecond = subscribeForegroundClock(second, dom.window.document);
  expect(start).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2100);
  expect(first).toHaveBeenCalledTimes(3);
  expect(second).toHaveBeenCalledTimes(3);
  hidden = true;
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  expect(second).toHaveBeenLastCalledWith(null);
  vi.advanceTimersByTime(10000);
  expect(second).toHaveBeenCalledTimes(4);
  hidden = false;
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  expect(second).toHaveBeenLastCalledWith(Date.now());
  stopFirst();
  stopSecond();
  vi.advanceTimersByTime(10000);
  expect(second).toHaveBeenCalledTimes(5);
  dom.window.close();
});
