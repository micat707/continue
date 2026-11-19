import { ReactNode, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppSelector } from "../../../redux/hooks";
import {
  selectApplyStatesForCurrentSession,
  selectToolCallsByStatus,
} from "../../../redux/selectors/selectToolCalls";

/**
 * Reserved slot for the composer's transient strip (streaming status bar,
 * "Review changes" card, end-of-session change summary).
 *
 * The strip itself is a FLOATING overlay (see .kiro-lump in kiro-theme.css):
 * the review card / session summary are out of flow and do not occupy layout
 * space, so only the in-flow streaming bar contributes here. While the turn
 * is BUSY the slot pins min-height to the HIGH-WATER measured content height
 * and keeps it even when the content empties (the bar unmounts while the
 * floating card shows), so the composer height is CONSTANT for the whole
 * turn — the conversation is never shoved up/down mid-turn, and the input
 * frame (with the floating card above it) never shifts when the bar/card
 * swap happens.
 *
 * When the conversation ends the reservation is dropped and the slot
 * collapses back to its natural height — the area returns to normal use.
 * A short CSS transition turns the expand/collapse into a smooth settle
 * instead of a jump.
 */
export function LumpSlot({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Live measured height of the strip content. `undefined` = no reservation
  // (natural height). The outer slot's min-height never feeds back into this
  // measurement: the inner wrapper is content-sized (floating children are
  // positioned against the outer `relative px-2` wrapper, not this one).
  const [reserved, setReserved] = useState<number | undefined>(undefined);
  const sessionId = useAppSelector((state) => state.session.id);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const busyApply = useAppSelector((state) =>
    selectApplyStatesForCurrentSession(state).some(
      (applyState) =>
        applyState.status === "streaming" || applyState.status === "done",
    ),
  );
  const callingToolCalls = useAppSelector((state) =>
    selectToolCallsByStatus(state, "calling"),
  );
  const generatedToolCalls = useAppSelector((state) =>
    selectToolCallsByStatus(state, "generated"),
  );
  const busy =
    isStreaming ||
    busyApply ||
    callingToolCalls.length > 0 ||
    generatedToolCalls.length > 0;

  // The ResizeObserver callback below is registered once; read `busy` through
  // a ref so the high-water logic always sees the current value.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Session switch: drop the reservation; the observer re-measures on the
  // next content render.
  useEffect(() => {
    setReserved(undefined);
  }, [sessionId]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const update = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      setReserved((prev) => {
        if (height > 0) {
          return height;
        }
        // Content emptied (e.g. the streaming bar unmounted while the floating
        // review card shows): keep the high-water reservation while the turn
        // is still busy so the composer height never changes mid-turn.
        return busyRef.current ? prev : undefined;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={clsx("kiro-lump-slot", busy && "kiro-lump-slot--reserved")}
      style={{ minHeight: busy ? reserved : undefined }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
