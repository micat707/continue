interface NewSessionButtonProps {
  onClick: () => void;
}

// Kiro-style "New Session" button rendered in the tab bar's trailing space.
export function NewSessionButton({ onClick }: NewSessionButtonProps) {
  return (
    <button
      className="kiro-new-session-tab"
      onClick={onClick}
      title="New Session"
      type="button"
    >
      <span style={{ fontSize: "15px", lineHeight: 1 }}>+</span>
      <span>New Session</span>
    </button>
  );
}
