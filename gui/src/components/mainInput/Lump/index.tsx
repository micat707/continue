import { LumpToolbar } from "./LumpToolbar/LumpToolbar";

/**
 * Simplified toolbar component that only shows the toolbar without expansion
 */
export function Lump() {
  return (
    /* No margin / side borders / horizontal padding of its own: the Lump must
       share the EXACT horizontal footprint of the GradientBorder input frame
       below (both live in the same `px-2` wrapper in ContinueInputBox), so the
       review card's left/right edges line up with the input box's edges at any
       width. Visible border/background come from the panel itself. */
    <div className="kiro-lump">
      <div className="py-0.5">
        <LumpToolbar />
      </div>
    </div>
  );
}
