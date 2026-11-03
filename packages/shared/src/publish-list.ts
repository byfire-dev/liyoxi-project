/** The same deterministic projection is used by editors, reads and release push. */
export function renderPublishListEpisode(input: {
  dramaTitle: string;
  episodeNo: number;
  titleTemplate: string | null;
  topics: readonly string[];
  intro: string | null;
  override?: {
    title: string | null;
    highlight: string | null;
    topics: readonly string[] | null;
    intro: string | null;
  };
}) {
  const row = input.override;
  return {
    episodeNo: input.episodeNo,
    title:
      row?.title ||
      input.titleTemplate
        ?.replaceAll("{剧名}", input.dramaTitle)
        .replaceAll("{集数}", String(input.episodeNo))
        .replaceAll("{看点}", row?.highlight ?? "") ||
      "",
    topics: row?.topics?.length ? [...row.topics] : [...input.topics],
    intro: row?.intro || input.intro,
  };
}
