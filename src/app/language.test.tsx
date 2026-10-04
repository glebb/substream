import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageContext, Localized, translate } from "./language.tsx";
import { ScreenNavigation } from "./ScreenNavigation.tsx";
import { fi } from "./locales/fi.ts";
import { en } from "./locales/en.ts";

describe("UI localization", () => {
  it("preserves unknown text instead of replacing words inside titles or descriptions", () => {
    expect(translate("The Last Movie: Live", "fi")).toBe("The Last Movie: Live");
    expect(translate("A Finnish series about a movie star.", "fi")).toBe("A Finnish series about a movie star.");
  });

  it("keeps content verbatim even when its title is also a UI message", () => {
    const html = renderToStaticMarkup(<Localized language="fi"><section>
      <strong translate="no" title="Next">Next</strong>
      <p translate="no">Continue watching</p>
      <button aria-label="Next page (Right)">Next page · →</button>
      <p>Synopsis unavailable for this title.</p>
    </section></Localized>);
    expect(html).toContain('title="Next">Next</strong>');
    expect(html).toContain('>Continue watching</p>');
    expect(html).toContain('aria-label="Seuraava sivu (oikealle)"');
    expect(html).toContain('>Seuraava sivu · →</button>');
    expect(html).toContain('Tämän nimikkeen kuvausta ei ole saatavilla.');
  });

  it("translates pagination and preserves titles embedded in UI messages", () => {
    expect(translate("Previous", "fi")).toBe("Edellinen");
    expect(translate("Next", "fi")).toBe("Seuraava");
    expect(translate("Previous page · ←", "fi")).toBe("Edellinen sivu · ←");
    expect(translate("Remove Next from Continue watching", "fi")).toBe("Poista Next Jatka katselua -listalta");
    expect(translate("Sent “Live” to TV.", "fi")).toBe("Lähetettiin ”Live” TV:hen.");
    expect(translate("Next page", "en")).toBe("Next page");
    expect(translate("Resume available at ", "fi")).toBe("Jatkamiskohta ");
    expect(translate("Season 2, ", "fi")).toBe("Kausi 2, ");
    expect(translate("Loading Next from the provider…", "fi")).toBe("Ladataan Next palveluntarjoajalta…");
  });

  it("localizes shared navigation inside a parent localization boundary", () => {
    for (const previousLabel of ["Back to groups", "Back to titles", "Back to details", "Back to search", "Categories", "Seasons"]) {
      const html = renderToStaticMarkup(<LanguageContext.Provider value={{ language: "fi", setLanguage: () => {} }}>
        <Localized language="fi"><ScreenNavigation onPrevious={() => {}} previousLabel={previousLabel} onMainMenu={() => {}} /></Localized>
      </LanguageContext.Provider>);
      expect(html).toContain(`>${translate(previousLabel, "fi")}</button>`);
      expect(html).toContain(">Päävalikko</button>");
      expect(html.match(/<button/g)).toHaveLength(2);
    }
    const english = renderToStaticMarkup(<LanguageContext.Provider value={{ language: "en", setLanguage: () => {} }}>
      <ScreenNavigation onMainMenu={() => {}} />
    </LanguageContext.Provider>);
    expect(english).toContain(">Main menu</button>");
    expect(translate("Latest", "fi")).toBe("Uusimmat");
    expect(translate("Refresh Latest", "fi")).toBe("Päivitä uusimmat");
  });

  it("keeps English and Finnish dictionaries aligned", () => {
    expect(Object.keys(fi).sort()).toEqual(Object.keys(en).sort());
  });
});
