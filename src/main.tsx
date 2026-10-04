import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { RuntimeProvider } from "./app/runtime.tsx";
import { CompanionProvider } from "./app/companion.tsx";

createRoot(document.getElementById("root")!).render(<StrictMode><RuntimeProvider><CompanionProvider><App /></CompanionProvider></RuntimeProvider></StrictMode>);
