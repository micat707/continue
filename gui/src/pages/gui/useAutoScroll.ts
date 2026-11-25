import { useEffect, useMemo, useRef } from "react";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";

function getNumUserMsgs(history: ChatHistoryItemWithMessageId[]) {
  return history.filter((msg) => msg.message.role === "user").length;
}

/** Treat as "at the bottom" within this many px. */
const BOTTOM_TOLERANCE = 16;
/** Absorb our own pin-induced scroll events for this long, so a fast follow-up
 *  (streaming writes several chunks within the window) never flips follow off. */
const PROGRAMMATIC_WINDOW_MS = 250;
/** Gap between the newest content and the composer / floating approval card. */
const SAFE_GAP_PX = 20;
/** Default bottom band (above the composer) that is NEVER writable by the
 *  streaming content: the floating review-changes / tool-call / summary card
 *  lives in this zone. So by default the content stream stops SAFE_GAP_PX above
 *  the CARD's top edge and is never written behind the card. When an actual
 *  card is taller than this, the band grows to the measured height (and only
 *  grows — it never shrinks back below RESERVE_PX), so a taller card causes at
 *  most a tiny one-time settle, never the big "shove up" we used to get when
 *  the band was only created after the card mounted. */
const RESERVE_PX = 140;

// Diagnostic trace — filter the webview console with "[autoscroll]". Uses
// console.log (NOT debug) because DevTools hides console.debug unless the
// Verbose level is enabled.
const debug = (...args: unknown[]) => console.log("[autoscroll]", ...args);

// How many px of the composer (.kiro-chat-input) overlap the bottom edge of the
// scroll viewport. In the two-layer flex layout (Chat.tsx) the composer sits
// BELOW the scroll, so this measures ~0; a value > 0 would mean the composer is
// effectively overlaying the list (legacy layout) and hiding content. Logged
// with every pin so the real geometry is visible in the console.
const getComposerOverlap = (elem: HTMLElement): number => {
  const composer = elem.parentElement?.querySelector(
    ".kiro-chat-input",
  ) as HTMLElement | null;
  if (!composer) return -1;
  const covered =
    elem.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
  return covered > 0 ? Math.round(covered) : 0;
};

export const useAutoScroll = (
  ref: React.RefObject<HTMLDivElement>,
  history: ChatHistoryItemWithMessageId[],
  isStreaming?: boolean,
) => {
  const numUserMsgs = useMemo(() => getNumUserMsgs(history), [history.length]);
  // Keep the latest streaming flag reachable from the observer callbacks,
  // which are installed once and must not be torn down on every chunk.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    const elem = ref.current;
    if (!elem) return;

    // follow = true means "keep the newest content pinned to the bottom".
    // It is on while the user is at the bottom, and we refresh it after every
    // programmatic pin — during streaming pins happen on every chunk, so the
    // 250ms ignore-window keeps follow true continuously. A genuine user
    // scroll-up (outside any pin window) flips it off, and it only resumes when
    // they scroll back to the bottom.
    let follow = true;
    let programmaticUntil = 0;
    let lastScrollHeight = elem.scrollHeight;
    let lastClientHeight = elem.clientHeight;

    // Constant bottom band. The newest content ALWAYS stops at least SAFE_GAP_PX
    // above the composer, and (because the floating approval card occupies the
    // RESERVE_PX zone above the composer) it is effectively kept SAFE_GAP_PX
    // above the card's top edge too. The band is the max of the card's measured
    // height and RESERVE_PX, so a tall (multi-file) card grows the band instead
    // of being covered, but the band never drops below RESERVE_PX — content
    // never writes into the card zone, and a card never shoves the conversation
    // up because the zone was already reserved from the very start.
    const recomputeBand = () => {
      const stripEl = elem.parentElement?.querySelector(
        ".kiro-chat-input .kiro-lump",
      ) as HTMLElement | null;
      const measured = stripEl
        ? Math.ceil(stripEl.getBoundingClientRect().height) + 4
        : 0;
      const band = Math.max(measured, RESERVE_PX);
      elem.style.paddingBottom = `${band + SAFE_GAP_PX}px`;
    };
    recomputeBand();

    const onScroll = () => {
      const now = performance.now();
      const isAtBottom =
        elem.scrollHeight - elem.scrollTop - elem.clientHeight <
        BOTTOM_TOLERANCE;
      const wasFollow = follow;
      follow = now < programmaticUntil ? true : isAtBottom;
      if (follow !== wasFollow) {
        debug("follow →", follow, {
          st: elem.scrollTop,
          sh: elem.scrollHeight,
          ch: elem.clientHeight,
        });
      }
    };
    elem.addEventListener("scroll", onScroll);

    const maybeFollow = (reason: string) => {
      const streamingNow = !!isStreamingRef.current;
      const contentGrew = elem.scrollHeight > lastScrollHeight;
      const viewportShrank = elem.clientHeight < lastClientHeight;
      // During streaming, DOM text can grow inside a nested scroll container
      // (e.g. a tool Result box) without changing this element's scrollHeight.
      // Treat any mutation while streaming as growth so the newest line stays
      // visible above the stop bar.
      const grew = contentGrew || (streamingNow && reason === "mutate");
      if (grew || viewportShrank) {
        // Viewport SHRINK (composer grows: stream bar / review card) re-pins so
        // the bottom stays visible; viewport GROW (turn end, reservation
        // released) must NOT re-pin to the absolute bottom — the browser keeps
        // scrollTop (content stays put) and the freed space appears below, so
        // the conversation never "drops". Pinning to bottom on a grow would yank
        // it down by the freed amount.
        // While streaming, always keep the tail visible even if a stray
        // scroll event flipped `follow` off — that is exactly the case where
        // new text lands under the sticky stop/composer bar.
        if (follow || streamingNow) {
          // Explicit "instant" overrides any inherited scroll-behavior, and
          // guarantees the scroll event lands immediately (well inside the
          // programmatic window).
          elem.scrollTo({ top: elem.scrollHeight, behavior: "instant" });
          programmaticUntil = performance.now() + PROGRAMMATIC_WINDOW_MS;
          debug(reason, "pin", {
            sh: elem.scrollHeight,
            ch: elem.clientHeight,
            overlap: getComposerOverlap(elem),
          });
        } else {
          debug(reason, "SKIP — not following", {
            st: elem.scrollTop,
            sh: elem.scrollHeight,
            ch: elem.clientHeight,
          });
        }
      }
      lastScrollHeight = elem.scrollHeight;
      lastClientHeight = elem.clientHeight;
    };

    const observer = new ResizeObserver(() => maybeFollow("resize"));
    observer.observe(elem);
    Array.from(elem.children).forEach((child) => observer.observe(child));

    // Two triggers for content growth:
    // 1. MutationObserver — streaming writes DOM nodes/text directly; any such
    //    mutation means content may have grown, even when no observed box
    //    resized.
    // 2. composerObserver — IF the composer effectively overlays the list
    //    (legacy layout; the CSS comment claims it does even though the flex
    //    layout says otherwise), its growth does NOT resize the scroll element
    //    and only this observer catches the card appearing. In the two-layer
    //    layout it is redundant but harmless.
    const mutation = new MutationObserver(() => maybeFollow("mutate"));
    mutation.observe(elem, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const composerEl = elem.parentElement?.querySelector(".kiro-chat-input");
    const composerObserver = composerEl
      ? new ResizeObserver(() => {
          recomputeBand();
          maybeFollow("composer-resize");
        })
      : undefined;
    if (composerObserver && composerEl) {
      composerObserver.observe(composerEl);
    }

    // The floating strip (.kiro-lump) is OUT of the composer's flow, so its
    // size changes never resize the composer or the scroll element — only this
    // dedicated observer catches the approval card mounting/unmounting. When it
    // mounts/tallens, recomputeBand grows the band to the measured height so
    // the content stops above it instead of being covered; when it unmounts the
    // band settles back to RESERVE_PX (never to 0).
    const stripEl = composerEl?.querySelector(".kiro-lump");
    const stripObserver = stripEl
      ? new ResizeObserver(() => {
          recomputeBand();
          maybeFollow("strip-resize");
        })
      : undefined;
    if (stripObserver && stripEl) {
      stripObserver.observe(stripEl);
    }

    return () => {
      observer.disconnect();
      mutation.disconnect();
      composerObserver?.disconnect();
      stripObserver?.disconnect();
      elem.removeEventListener("scroll", onScroll);
    };
  }, [ref, history.length]);

  // A new user message always snaps to the bottom: the user just sent it from
  // the composer and expects to see their question and the answer — even if
  // they had scrolled up while composing.
  useEffect(() => {
    const elem = ref.current;
    if (!elem) return;
    const raf = requestAnimationFrame(() => {
      elem.scrollTo({ top: elem.scrollHeight, behavior: "instant" });
    });
    return () => cancelAnimationFrame(raf);
  }, [numUserMsgs, ref]);
};
