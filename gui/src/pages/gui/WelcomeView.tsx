import { OnboardingCard } from "../../components/OnboardingCard";
import { useMainEditor } from "../../components/mainInput/TipTapEditor";

/**
 * Kiro-style centered empty-state ("Let's build"). Shown in the middle of the
 * chat scroll area when there is no history, with a few quick-start prompts that
 * prefill the main input. When the first-run onboarding card is enabled it is
 * centered here instead.
 */

const QUICK_ACTIONS = [
  "Explain this code",
  "Write a new feature",
  "Fix a bug in my code",
  "Add unit tests",
  "Refactor this function",
  "Generate documentation",
];

export function WelcomeView({
  showOnboardingCard,
}: {
  showOnboardingCard?: boolean;
}) {
  const { mainEditor } = useMainEditor();

  function onPick(prompt: string) {
    mainEditor?.commands.insertPrompt({
      title: "",
      description: "",
      content: prompt,
    });
    mainEditor?.commands.focus("end");
  }

  if (showOnboardingCard) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center px-6">
        <div className="mx-2 w-full max-w-2xl">
          <OnboardingCard />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
      <div className="kiro-welcome-logo mb-5">
        <svg width="72" height="72" viewBox="0 0 24 24" className="kiro-face">
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
          <ellipse
            className="kiro-face-eye left"
            cx="9"
            cy="9.33"
            rx="1.63"
            ry="2.62"
            fill="#0a0a0a"
          />
          <ellipse
            className="kiro-face-eye right"
            cx="15"
            cy="9.33"
            rx="1.63"
            ry="2.62"
            fill="#0a0a0a"
          />
        </svg>
      </div>

      <h1 className="kiro-welcome-title text-2xl font-semibold">Let's build</h1>
      <p className="kiro-welcome-subtitle mt-2 text-sm">
        Describe what you want to build, or start from a suggestion.
      </p>

      <div className="mt-6 flex max-w-xl flex-wrap items-center justify-center gap-2">
        {QUICK_ACTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="kiro-welcome-chip"
            onClick={() => onPick(q)}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
