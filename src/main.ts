// Entry point. Every window runs this page: project windows show the app, the two presentation windows (opened with
// `?view=audience` or `?view=presenter`) only their own view.
import "./styles/app.css";
import { App } from "./app";
import { setLanguage } from "./i18n";
import { applyTheme, settings } from "./settings";

async function boot(): Promise<void> {
  setLanguage(settings.get("language"));
  applyTheme();
  settings.onChange(applyTheme);
  const root = document.getElementById("app")!;
  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  if (view === "audience" || view === "presenter") {
    const { bootPresentation } = await import("./present/view");
    await bootPresentation(root, view, params.get("pdf") ?? "", Number(params.get("screens") ?? 1));
  } else {
    await new App(root).start();
  }
}

void boot();
