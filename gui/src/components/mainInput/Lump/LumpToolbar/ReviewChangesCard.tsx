import { getUriPathBasename } from "core/util/uri";
import { ReactNode } from "react";
import FileIcon from "../../../FileIcon";

/**
 * Split a RAW path (Windows or POSIX, e.g. "F:\item" or "src/lib/a.ts") into
 * its directory prefix and last segment. Unlike getUriPathBasename (which
 * URI-parses and is lossy on bare Windows paths), this never mangles the
 * string — so approval cards can show the path the agent will actually touch.
 */
function splitRawPath(p: string): { dir: string; base: string } {
  if (p.includes("://")) {
    // URI form: fall back to the basename helper (raw dir is meaningless).
    return { dir: "", base: getUriPathBasename(p) };
  }
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0
    ? { dir: p.slice(0, idx), base: p.slice(idx + 1) }
    : { dir: "", base: p };
}

export interface ReviewChangeItem {
  /** Stable key for the row */
  id: string;
  /** Leading label, e.g. "1 change to" or the tool display title */
  label: string;
  /** Optional file shown as a chip (Kiro's <button class="file-label">) */
  filename?: string;
  /** Optional one-line scope note under the row (e.g. what approving grants) */
  description?: string;
  acceptTestId?: string;
  rejectTestId?: string;
  acceptTitle?: string;
  rejectTitle?: string;
  onAccept?: () => void;
  onReject?: () => void;
  /** Overrides the default per-item check/close buttons (e.g. when reusing
   *  AcceptRejectDiffButtons for file-apply states). */
  actions?: ReactNode;
}

export interface ReviewChangesFooter {
  viewChangesLabel?: string;
  onViewChanges?: () => void;
  cancelLabel?: string;
  onCancel?: () => void;
}

export interface ReviewChangesCardProps {
  title: string;
  items: ReviewChangeItem[];
  bulkAcceptLabel?: string;
  bulkRejectLabel?: string;
  onBulkAccept?: () => void;
  onBulkReject?: () => void;
  footer?: ReviewChangesFooter;
}

/**
 * Kiro-style "Review changes" card used whenever the agent needs the user to
 * authorize something before it continues. The markup / class names mirror
 * Kiro's real DOM (agent-interaction-panel-*).
 *
 * Icons use the codicon font (loaded globally via @vscode/codicons), which
 * matches Kiro's <i class="codicon codicon-..."> usage. Note: codicon-kiro is
 * a Kiro-private glyph not present in the public font, so the header falls back
 * to a CSS ring (see .agent-interaction-panel-icon in kiro-theme.css).
 */
export function ReviewChangesCard({
  title,
  items,
  bulkAcceptLabel = "Accept",
  bulkRejectLabel = "Reject",
  onBulkAccept,
  onBulkReject,
  footer,
}: ReviewChangesCardProps) {
  return (
    <div
      className="agent-interaction-panel"
      data-variant="call-to-action"
      data-testid="kiro-review-card"
    >
      <div className="agent-interaction-panel-content-container">
        <div className="agent-interaction-panel-header">
          <span className="agent-interaction-panel-icon" />
          <span className="agent-interaction-panel-title">{title}</span>
        </div>

        <div className="agent-interaction-panel-content">
          <div className="kiro-supervised-file-list">
            {items.map((item) => (
              <div className="agent-outcome" key={item.id}>
                <div className="agent-outcome-summary">
                  <div className="kiro-supervised-approval-item">
                    <span>{item.label}</span>
                    {item.filename && getUriPathBasename(item.filename) && (
                      <button
                        type="button"
                        className="file-label"
                        title={item.filename}
                      >
                        <FileIcon
                          filename={item.filename}
                          height="14px"
                          width="14px"
                        />
                        <span className="file-label-name">
                          {(() => {
                            const { dir, base } = splitRawPath(item.filename);
                            // Render the separator back so a Windows path
                            // reads "F:\item", not "F:tem".
                            const sep = item.filename.includes("\\")
                              ? "\\"
                              : "/";
                            return (
                              <>
                                {dir && (
                                  <span
                                    style={{
                                      opacity: 0.65,
                                      marginRight: 2,
                                      maxWidth: 180,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {dir + sep}
                                  </span>
                                )}
                                {base}
                              </>
                            );
                          })()}
                        </span>
                      </button>
                    )}
                  </div>

                  {item.description && (
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.6,
                        marginTop: 2,
                        lineHeight: 1.4,
                      }}
                    >
                      {item.description}
                    </div>
                  )}

                  {item.actions ? (
                    <div className="action-bar agent-outcome-actions">
                      {item.actions}
                    </div>
                  ) : (
                    <ul
                      className="action-bar agent-outcome-actions"
                      role="toolbar"
                    >
                      <li className="action-item menu-entry">
                        <button
                          type="button"
                          className="kiro-button kiro-icon-button"
                          data-size="small"
                          data-variant="tertiary"
                          aria-label="Accept"
                          title={item.acceptTitle ?? "Accept"}
                          data-testid={item.acceptTestId}
                          onClick={item.onAccept}
                        >
                          <i
                            className="kiro-icon codicon codicon-check"
                            data-size="small"
                          />
                        </button>
                      </li>
                      <li className="action-item menu-entry">
                        <button
                          type="button"
                          className="kiro-button kiro-icon-button"
                          data-size="small"
                          data-variant="tertiary"
                          aria-label="Reject"
                          title={item.rejectTitle ?? "Reject"}
                          data-testid={item.rejectTestId}
                          onClick={item.onReject}
                        >
                          <i
                            className="kiro-icon codicon codicon-close"
                            data-size="small"
                          />
                        </button>
                      </li>
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>

          {(onBulkAccept || onBulkReject) && (
            <div className="kiro-supervised-bulk-actions">
              {onBulkAccept && (
                <button
                  type="button"
                  className="kiro-button"
                  data-severity="positive"
                  data-size="small"
                  onClick={onBulkAccept}
                >
                  {bulkAcceptLabel}
                </button>
              )}
              {onBulkReject && (
                <button
                  type="button"
                  className="kiro-button"
                  data-severity="negative"
                  data-size="small"
                  data-variant="outline"
                  onClick={onBulkReject}
                >
                  {bulkRejectLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {footer && (footer.onViewChanges || footer.onCancel) && (
        <div className="agent-interaction-panel-bottom-bar">
          <div />
          <div className="agent-interaction-panel-actions">
            {footer.onViewChanges && (
              <button
                type="button"
                className="kiro-button"
                data-size="small"
                data-variant="secondary"
                onClick={footer.onViewChanges}
              >
                <i
                  className="kiro-icon codicon codicon-eye"
                  data-size="small"
                />
                {footer.viewChangesLabel ?? "View changes"}
              </button>
            )}
            {footer.onCancel && (
              <button
                type="button"
                className="kiro-button"
                data-severity="negative"
                data-size="small"
                data-variant="outline"
                onClick={footer.onCancel}
              >
                {footer.cancelLabel ?? "Cancel"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
