// King-style agent message meta (.agent-message-meta): circular King head
// avatar + "King" role label above each assistant turn.
export function MessageHeader() {
  const name = "King";

  return (
    <div className="kiro-message-header">
      <span className="kiro-message-avatar" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" className="kiro-face">
          <g className="kiro-face-head-group">
            <circle
              className="kiro-face-head"
              cx="12"
              cy="12"
              r="12"
              fill="#fff"
            />
            <circle
              className="kiro-face-border"
              cx="12"
              cy="12"
              r="12.75"
              fill="none"
              stroke="#000"
              strokeWidth="1.5"
            />
          </g>
          <ellipse
            className="kiro-face-eye can-blink left"
            cx="9"
            cy="9.33"
            rx="1.63"
            ry="2.62"
            fill="#0a0a0a"
          />
          <ellipse
            className="kiro-face-eye can-blink right"
            cx="15"
            cy="9.33"
            rx="1.63"
            ry="2.62"
            fill="#0a0a0a"
          />
        </svg>
      </span>
      <span className="kiro-message-author">{name}</span>
    </div>
  );
}
