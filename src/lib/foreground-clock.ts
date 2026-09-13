type Tick = (now: number | null) => void;
const clocks = new WeakMap<Document, { subscribe: (tick: Tick) => () => void }>();

/** One timer per visible extension document; no work while hidden or unused. */
export function subscribeForegroundClock(tick: Tick, owner = document): () => void {
  let clock = clocks.get(owner);
  if (!clock) {
    const view = owner.defaultView!;
    const subscribers = new Set<Tick>();
    let timer: number | undefined;
    const stopTimer = () => { if (timer !== undefined) view.clearInterval(timer); timer = undefined; };
    const publish = () => { const now = owner.hidden ? null : Date.now(); for (const listener of subscribers) listener(now); };
    const visibilityChanged = () => {
      stopTimer();
      if (!owner.hidden && subscribers.size) timer = view.setInterval(publish, 1000);
      publish();
    };
    clock = {
      subscribe(listener) {
        subscribers.add(listener);
        if (subscribers.size === 1) {
          owner.addEventListener("visibilitychange", visibilityChanged);
          visibilityChanged();
        } else listener(owner.hidden ? null : Date.now());
        return () => {
          subscribers.delete(listener);
          if (!subscribers.size) {
            stopTimer();
            owner.removeEventListener("visibilitychange", visibilityChanged);
          }
        };
      }
    };
    clocks.set(owner, clock);
  }
  return clock.subscribe(tick);
}
