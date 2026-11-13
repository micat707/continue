import { SVGProps } from "react";

/**
 * SVG icons for the Kiro-style agent-outcome card.
 *
 * Most glyphs are ORIGINAL hand-drawn vectors inspired by Kiro's look (e.g. the
 * circled pencil "accepted" badge). `CompareChangesIcon` ("git-compare") and
 * `DiscardIcon` ("back-2") are adapted from the open-source MingCute Icon set
 * (Apache License 2.0, https://www.mingcute.com) and are used under that
 * license.
 *
 * None of these reuse Kiro's proprietary `kiricon` font binary, so they are
 * safe to bundle/redistribute. All glyphs use `currentColor`, so the existing
 * `.agent-icon-accepted` (green) / `.agent-icon-pending` (amber) color classes
 * keep working.
 */

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

const base = (className?: string): SVGProps<SVGSVGElement> => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: ["codicon", "outcome-icon", className].filter(Boolean).join(" "),
});

export function EditIcon({ className, ...rest }: IconProps) {
  return (
    <svg {...base(className)} {...rest}>
      {/* circled pencil — mirrors Kiro's "accepted edit" badge */}
      <circle cx="12" cy="12" r="9" />
      <path d="M8 16l1-3 6-6 2 2-6 6z" />
      <path d="M14 6l2 2" />
    </svg>
  );
}

export function RevertedIcon({ className, ...rest }: IconProps) {
  return (
    <svg {...base(className)} {...rest}>
      {/* circled check — mirrors Kiro's "(reverted)" completed badge */}
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.2l2.6 2.6L16 9.6" />
    </svg>
  );
}

export function CompareChangesIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={["codicon", "outcome-icon", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {/* MingCute Icon "git-compare-fill" — Apache License 2.0 (https://www.mingcute.com).
          Two solid nodes joined by a curved loop arrow; used under the Apache-2.0
          license, not derived from Kiro's proprietary kiricon. */}
      <path d="M6 3a3 3 0 0 1 1.172 5.762L7 8.83V16a1 1 0 0 0 .883.994L8 17h2.207l-.414-.414a1 1 0 0 1 1.32-1.498l.094.084 2.121 2.12a1 1 0 0 1 .084 1.32l-.084.095-2.121 2.121a1 1 0 0 1-1.497-1.32l.083-.094.414-.414H8a3 3 0 0 1-2.995-2.824L5 16V8.83A3.001 3.001 0 0 1 6 3m6.793.172a1 1 0 0 1 1.497 1.32l-.083.094-.414.414H16a3 3 0 0 1 2.995 2.824L19 8v7.17A3.001 3.001 0 0 1 18 21a3 3 0 0 1-1.172-5.762L17 15.17V8a1 1 0 0 0-.883-.993L16 7h-2.207l.414.414a1 1 0 0 1-1.32 1.498l-.094-.084-2.121-2.12a1 1 0 0 1-.084-1.321l.084-.094 2.12-2.121Z" />
    </svg>
  );
}

export function DiscardIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={["codicon", "outcome-icon", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {/* MingCute Icon "back-2" — Apache License 2.0 (https://www.mingcute.com).
          Curved hook arrow pointing left ("revert / undo"); used under the
          Apache-2.0 license, not derived from Kiro's proprietary kiricon. */}
      <path d="M6.046 11.677A7.5 7.5 0 0 1 20 15.5a1 1 0 1 0 2 0A9.5 9.5 0 0 0 4.78 9.963l-.537-3.045a1 1 0 1 0-1.97.347l1.042 5.909a1 1 0 0 0 .412.645 1.1 1.1 0 0 0 .975.125l5.68-1.001a1 1 0 1 0-.347-1.97l-3.989.704Z" />
    </svg>
  );
}

export function ChevronDownIcon({ className, ...rest }: IconProps) {
  return (
    <svg {...base(className)} {...rest}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function FileIcon({ className, ...rest }: IconProps) {
  return (
    <svg {...base(className)} {...rest}>
      {/* document with folded corner */}
      <path d="M7 3h7l4 4v13H7z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

export function EyeIcon({ className, ...rest }: IconProps) {
  return (
    <svg {...base(className)} {...rest}>
      {/* eye — mirrors Kiro's "Read File" outcome status glyph */}
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
