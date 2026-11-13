import React, { useEffect, useRef, useState } from "react";

export interface TurnItem {
  /** The user message id (turn anchor). */
  id: string;
  /** Question preview text. */
  q: string;
  /** Id of the first assistant/answer message in this turn, for scroll-to. */
  answerId: string;
  /** Plain text of the whole answer (all assistant/tool messages of the
      turn) — used for keyword search in the navigator. */
  answer: string;
}

/** Extract a short context window around the first keyword hit. */
function hitSnippet(text: string, kw: string): string {
  const idx = text.toLowerCase().indexOf(kw);
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + kw.length + 30);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** Split text into nodes, wrapping every keyword hit in <mark>. */
function highlight(text: string, kw: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(kw, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + kw.length)}</mark>);
    i = idx + kw.length;
  }
  return parts;
}

/**
 * Slide-out Q&A navigator for long multi-turn conversations.
 *
 * A full-height bar pinned to the right edge. Hidden by default (slid fully
 * off-screen, non-interactive); on hover-capable (desktop) devices it reveals
 * when the pointer enters the thin right-edge trigger strip and auto-hides
 * when the pointer leaves the bar. On touch devices the edge-hover is disabled
 * and the bar toggles on tap (with a backdrop to dismiss). Clicking an entry
 * scrolls the chat to that turn's answer.
 *
 * This is an isolated, easily-revertible feature: it renders nothing but a
 * fixed overlay and reads only the `turns` prop passed from Chat.
 */
export function TurnNavigator({ turns }: { turns: TurnItem[] }) {
  const [open, setOpen] = useState(false);
  // Keyword filter across question + answer text.
  const [query, setQuery] = useState("");
  const kw = query.trim().toLowerCase();
  const visible = kw
    ? turns
        .map((t, i) => ({ t, i }))
        .filter(
          ({ t }) =>
            t.q.toLowerCase().includes(kw) ||
            t.answer.toLowerCase().includes(kw),
        )
    : turns.map((t, i) => ({ t, i }));
  // Edge-hover reveal is a desktop interaction only; touch uses tap-toggle.
  const [hoverable] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(hover: hover)").matches,
  );
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const hideSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  };
  const toggle = () => setOpen((v) => !v);

  const jump = (answerId: string) => {
    const el = document.getElementById(`msg-${answerId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // On non-hover (touch) devices there is no "hover to keep open", so close
    // after selection; on hover devices the panel stays for further jumps.
    if (!hoverable) {
      setOpen(false);
    }
  };

  // Desktop (hover-capable): reveal purely by detecting the pointer entering a
  // thin zone at the very right edge — no visible trigger strip is drawn. The
  // panel itself hides the bar on mouse-leave, so we only need to *open* here.
  useEffect(() => {
    if (!hoverable) return;
    const EDGE = 14;
    const onMove = (e: MouseEvent) => {
      if (e.clientX >= window.innerWidth - EDGE) {
        show();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [hoverable]);

  // Align the bar's BOTTOM edge with the VISIBLE input box's bottom border
  // (the GradientBorder frame inside .kiro-chat-input), not the container —
  // the container carries a few px of internal whitespace below the box,
  // which left the bar hanging ~4-5px too low. Tracked with a ResizeObserver
  // so input-height changes and window resizes keep it aligned.
  const [bottomOffset, setBottomOffset] = useState(0);
  useEffect(() => {
    const input = document.querySelector(".kiro-chat-input .kiro-input-frame");
    if (!input) return;
    const update = () => {
      const rect = input.getBoundingClientRect();
      setBottomOffset(Math.max(0, window.innerHeight - rect.bottom));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(input);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <>
      {open && (
        <div
          className="kiro-turn-nav__backdrop"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={`kiro-turn-nav${open ? "is-open" : ""}`}
        style={{ bottom: bottomOffset }}
      >
        <div
          className="kiro-turn-nav__handle"
          onMouseEnter={hoverable ? show : undefined}
          onMouseLeave={hoverable ? hideSoon : undefined}
          onClick={toggle}
          role="button"
          aria-label="问答导航"
          title="问答导航"
        >
          <span className="kiro-turn-nav__handle-text">问答导航</span>
        </div>
        <div
          className={`kiro-turn-nav__panel${open ? "is-open" : ""}`}
          onMouseEnter={hoverable ? show : undefined}
          onMouseLeave={hoverable ? hideSoon : undefined}
        >
          <div className="kiro-turn-nav__title">
            <span>
              对话轮次
              {kw
                ? ` · 匹配 ${visible.length}/${turns.length}`
                : `（${turns.length}）`}
            </span>
          </div>
          <div className="kiro-turn-nav__search">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索提问 / 回复关键字…"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="kiro-turn-nav__search-clear"
                onClick={() => setQuery("")}
                aria-label="清除搜索"
              >
                ×
              </button>
            )}
          </div>
          <div className="kiro-turn-nav__list">
            {visible.length === 0 && (
              <div className="kiro-turn-nav__empty">无匹配轮次</div>
            )}
            {visible.map(({ t, i }) => {
              const inQ = kw !== "" && t.q.toLowerCase().includes(kw);
              const inA = kw !== "" && t.answer.toLowerCase().includes(kw);
              return (
                <button
                  key={t.id}
                  type="button"
                  className="kiro-turn-nav__item"
                  onClick={() => jump(t.answerId)}
                  disabled={!t.answerId}
                >
                  <span className="kiro-turn-nav__idx">{i + 1}</span>
                  <span className="kiro-turn-nav__body">
                    <span className="kiro-turn-nav__qrow">
                      <span className="kiro-turn-nav__q">
                        {t.q || "（空提问）"}
                      </span>
                      {inQ && (
                        <span
                          className="kiro-turn-nav__badge kiro-turn-nav__badge--q"
                          title="关键字命中于提问"
                        >
                          问
                        </span>
                      )}
                      {inA && (
                        <span
                          className="kiro-turn-nav__badge kiro-turn-nav__badge--a"
                          title="关键字命中于回复"
                        >
                          答
                        </span>
                      )}
                    </span>
                    {inA && (
                      <span
                        className="kiro-turn-nav__snippet"
                        title="回复中的命中上下文"
                      >
                        {highlight(hitSnippet(t.answer, kw), kw)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
