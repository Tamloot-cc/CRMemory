// jsdom's styles know `WebkitAnimation` but jsdom has no AnimationEvent, so
// react-dom would listen for webkitAnimationEnd instead of animationend.
// Browsers have AnimationEvent; this gives jsdom one too. It must load before
// react-dom, which picks the event names once at import.
class AnimationEventShim extends Event implements AnimationEvent {
  readonly animationName: string;
  readonly elapsedTime: number;
  readonly pseudoElement: string;

  constructor(type: string, init: AnimationEventInit = {}) {
    super(type, init);
    this.animationName = init.animationName ?? '';
    this.elapsedTime = init.elapsedTime ?? 0;
    this.pseudoElement = init.pseudoElement ?? '';
  }
}

globalThis.AnimationEvent ??= AnimationEventShim;
