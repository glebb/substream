import type { TmdbMetadata } from "../platform/tmdb/client.ts";
import { Localized, type UiLanguage } from "./language.tsx";

export function TitleMetadataExtras({ metadata, language }: { metadata: TmdbMetadata; language: UiLanguage }) {
  const series = metadata.mediaType === "tv";
  const joined = (values: string[] | undefined) => values?.slice(0, 3).join(" · ");
  const facts = [
    [series ? "Created by" : "Director", joined(series ? metadata.creators : metadata.directors)],
    ["Writers", joined(metadata.writers)],
    ["Seasons / episodes", series && metadata.seasonCount ? `${metadata.seasonCount} / ${metadata.episodeCount ?? "—"}` : undefined],
    ["Status", series ? metadata.status : undefined],
    ["Languages", joined(metadata.spokenLanguages)],
    [series && metadata.networks?.length ? "Network" : "Studio", joined(series && metadata.networks?.length ? metadata.networks : metadata.studios)],
    ["Country", joined(metadata.countries)],
    ["Original title", metadata.originalTitle && metadata.originalTitle !== metadata.title ? metadata.originalTitle : undefined],
  ].filter((fact): fact is [string, string] => typeof fact[1] === "string" && fact[1].length > 0).slice(0, 6);

  return <Localized language={language}>
    <div className="details-extra-sections">
      {!!metadata.cast?.length && <section className="details-cast" aria-label="Cast">
        <h3 className="details-section-heading">Cast</h3>
        <ul className="details-cast-list">
          {metadata.cast.slice(0, 6).map((actor) => <li key={actor.name} translate="no">
            <strong title={actor.name}>{actor.name}</strong>
            {actor.character && <span title={actor.character}>{actor.character}</span>}
          </li>)}
        </ul>
      </section>}
      {facts.length > 0 && <section className="details-production" aria-label="More details">
        <h3 className="details-section-heading">More details</h3>
        <dl className="details-production-list">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value} translate={label === "Status" ? undefined : "no"}>{value}</dd></div>)}
        </dl>
      </section>}
    </div>
  </Localized>;
}
