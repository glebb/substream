import { gridNavigationTarget } from "./remote-navigation.ts";

export type SearchFocusNode = "tab" | "trigger" | "editor" | "refresh" | "results" | "main-menu" | "native";

/** Directional transitions for the search controls on TV remotes. */
export function searchFocusTarget(from: "trigger" | "editor" | "refresh", key: string, hasResults: boolean): SearchFocusNode | null {
  if (from === "trigger") {
    if (key === "ArrowUp" || key === "ArrowLeft") return "tab";
    if (key === "ArrowDown" || key === "ArrowRight") return "refresh";
    return null;
  }
  if (from === "editor") {
    if (key === "ArrowUp") return "tab";
    if (key === "ArrowDown") return "refresh";
    if (key === "ArrowLeft" || key === "ArrowRight") return "native";
    return null;
  }
  if (from === "refresh") {
    if (key === "ArrowUp" || key === "ArrowLeft") return "trigger";
    if (key === "ArrowDown") return hasResults ? "results" : null;
    if (key === "ArrowRight") return "main-menu";
  }
  return null;
}

/** Search cards use the ordinary four/two/one-column grid, including on TV. */
export function searchResultFocusTarget(key: string, currentIndex: number, itemCount: number, columns: number): number | "refresh" | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) return null;
  if (key === "ArrowUp" && currentIndex < columns) return "refresh";
  return gridNavigationTarget(key, currentIndex, itemCount, columns);
}
