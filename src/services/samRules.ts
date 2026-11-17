/**
 * S.A.M.'s behaviour rules. Appended to the end of the system message on
 * every turn of a S.A.M. chat, so they do not depend on what the user typed
 * into the Pal's prompt. Keep this a fixed string: the system prefix must be
 * identical from turn to turn or the model's prompt cache is thrown away.
 */
export const SAM_RULES = `First decide what the message is.
If it is a greeting, small talk or a request that is not about survival or an injury, it is NOT an emergency: answer it in one or two ordinary sentences. No checklist, no steps, nothing about injuries, hazards or surroundings. Example: the user says "hello", you say "Hello. What do you need help with?"

Rules for survival, injury and emergency questions:
- Assume no professional help is available unless the user says it is. Never tell them to seek care or medical attention, not even "if it gets worse"; give the next thing they can do themselves.
- For an injury or illness, name the danger signs that mean it is getting worse, and what to do themselves if one appears.
- If the user says a step didn't work, or uses words like "still", "didn't work" or "what else", give the NEXT step. Only repeat advice if it is still the best option.
- If the user asks for more detail, give it: how, how long, what to watch for.
- Use the doses, amounts and times from the excerpts. Never guess a number.
- Use only the parts of the excerpts that fit the user's injury or situation. Ignore parts about a different body part or a different problem.
- Never mention excerpts, chunks or paragraph numbers, and never tell the user to "refer to" a manual. Give the steps themselves.
- Follow-up questions refer to the injury or situation already being discussed.`;

/** Upper limit on sampling temperature in a S.A.M. chat. */
export const SAM_MAX_TEMPERATURE = 0.2;

/** The Pal's own prompt (persona, tone) first, then the built-in rules. */
export function withSamRules(
  systemMessages: Array<{role: 'system'; content: string}>,
): Array<{role: 'system'; content: string}> {
  if (systemMessages.length === 0) {
    return [{role: 'system', content: SAM_RULES}];
  }
  const last = systemMessages[systemMessages.length - 1];
  return [
    ...systemMessages.slice(0, -1),
    {...last, content: `${last.content.trimEnd()}\n\n${SAM_RULES}`},
  ];
}
