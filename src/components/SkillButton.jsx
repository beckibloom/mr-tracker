// The first slash command a next step names ("run /mr-review, then approve…" → "mr-review").
const SKILL_RE = /(?:^|[\s(])\/([a-z][a-z0-9-]*(?::[a-z0-9-]+)?)\b/;
export const skillIn = (...texts) => texts.map((t) => t && SKILL_RE.exec(t)?.[1]).find(Boolean) ?? null;

// Starts a Claude session for the card with the skill and the MR filled in, like a quick action.
const SkillButton = ({ card, skill, onLaunchSkill }) => {
  if (!skill || !onLaunchSkill) return null;
  const prompt = `/${skill} ${card.webUrl}`;
  return (
    <button
      type="button"
      className="btn btn--small yourmove-skill"
      onClick={() => onLaunchSkill(card.key, prompt)}
      title={`Start a Claude session: ${prompt}`}
    >
      /{skill}
    </button>
  );
};

export default SkillButton;
