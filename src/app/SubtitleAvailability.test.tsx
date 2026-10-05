import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubtitleAvailability } from "./SubtitleAvailability.tsx";
import { embeddedSubtitleLabel } from "./subtitle-labels.ts";

describe("subtitle availability", () => {
  it("labels sources separately and collapses duplicated language variants", () => {
    const tracks = ["fin", "eng", "eng", "swe"].map((language, index) => ({ trackNumber: index + 1, language, label: "", codecId: "S_TEXT/UTF8", forced: false, hearingImpaired: false, default: false }));
    const html = renderToStaticMarkup(<SubtitleAvailability embedded={{ status: "ready", tracks }} externalLanguages={["fi", "en"]} />);
    expect(html).toContain("Included in video:");
    expect(html).toContain("Finnish, English, Swedish");
    expect(html).toContain("OpenSubtitles:");
    expect(html).toContain("Finnish, English</span>");
    expect(html).toContain("when supported by this device");
  });
  it("never presents a pending or failed probe as an absent track", () => {
    expect(renderToStaticMarkup(<SubtitleAvailability embedded={null} externalLanguages={[]} />)).toContain("Checking included subtitles");
    const failed = renderToStaticMarkup(<SubtitleAvailability embedded={{ status: "unavailable", tracks: [] }} externalLanguages={[]} />);
    expect(failed).toContain("Availability could not be checked");
    expect(failed).not.toContain("No embedded subtitles found");
  });
  it("asks for the episode rather than probing a series container", () => {
    const html = renderToStaticMarkup(<SubtitleAvailability embedded={null} externalLanguages={[]} episodeRequired />);
    expect(html).toContain("Choose an episode");
    expect(html).not.toContain("Checking included subtitles");
  });
  it("shows the actual localized language in the source menu", () => {
    expect(embeddedSubtitleLabel({ language: "fin", label: "fin · S_TEXT/UTF8" }, "fi")).toBe("Suomi · S_TEXT/UTF8");
  });
  it("distinguishes forced and accessibility variants", () => {
    expect(embeddedSubtitleLabel({ language: "eng", label: "", forced: true })).toBe("English · Forced only");
    expect(embeddedSubtitleLabel({ language: "swe", label: "SDH", hearingImpaired: true })).toContain("Hearing impaired");
  });
});
