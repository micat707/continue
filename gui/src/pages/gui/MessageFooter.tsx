interface MessageFooterProps {
  credits?: number;
  elapsedMs?: number;
  modelName?: string;
}

// Kiro-style footer shown once at the end of an assistant turn.
export function MessageFooter({
  credits,
  elapsedMs,
  modelName,
}: MessageFooterProps) {
  if (credits == null && elapsedMs == null && !modelName) {
    return null;
  }

  return (
    <div className="kiro-message-footer">
      {credits != null && (
        <span className="kiro-message-footer-item">
          Est. Credits Used: {credits.toFixed(2)}
        </span>
      )}
      {elapsedMs != null && (
        <span className="kiro-message-footer-item">
          Elapsed time: {Math.max(1, Math.round(elapsedMs / 1000))}s
        </span>
      )}
      {modelName && (
        <span className="kiro-message-footer-model">Model: {modelName}</span>
      )}
    </div>
  );
}
