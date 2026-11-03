/** Match the existing save schema's UTF-16 budget without splitting a code point. */
function boundedText(value: string, max: number) {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result;
}

function generatedTopic(value: string) {
  // Reach a stable form under the save path's leading-# removal and trim, so a
  // generated value does not change again when the initial editor saves it.
  let normalized = value;
  for (;;) {
    const next = normalized.replace(/^#/, "").trim();
    if (next === normalized) return boundedText(next, 20).trimEnd();
    normalized = next;
  }
}

/** Only for a new list. Never normalize existing or user-submitted list content. */
export function publishListDefaults(input: {
  title: string;
  episodeCount: number;
  genreNames: readonly string[];
  synopsis: string | null;
}) {
  const topics = new Set<string>();
  for (const name of input.genreNames) {
    const topic = generatedTopic(name);
    if (topic) topics.add(topic);
    if (topics.size === 10) break;
  }
  if (!topics.size) {
    const fallback = generatedTopic(input.title);
    if (fallback) topics.add(fallback);
  }
  const suffix = `（全 ${input.episodeCount} 集）`;
  return {
    collectionName: `${boundedText(input.title, 60 - suffix.length)}${suffix}`,
    topics: [...topics],
    intro: input.synopsis === null ? null : boundedText(input.synopsis, 200),
  };
}
