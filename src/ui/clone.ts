// Clone Repository: an address (GitHub, GitLab, any git remote or a folder) and a location; the clone opens as a project.
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import * as ipc from "../ipc";
import { displayPath, h } from "../util";
import { alert, modal } from "./dialogs";

/** Resolves with the cloned folder, or null when cancelled. */
export async function cloneRepository(parent: string, home: string | null): Promise<string | null> {
  let location = parent;
  const url = h("input", { type: "text", placeholder: "https://github.com/user/thesis.git", spellcheck: "false" });
  const where = h("span", { class: "location-path" }, displayPath(location, home));
  const ok = h("button", { class: "primary" }, t("Clone"));
  const form = h("form", { class: "dialog" },
    h("h2", null, t("Clone Repository")),
    h("label", null, t("Repository address (GitHub, GitLab or a folder)"), url),
    h("div", { class: "location" }, h("span", null, t("Location")), where,
      h("button", {
        type: "button",
        onclick: async () => {
          const picked = await open({ directory: true, defaultPath: location, title: t("Choose a Folder") });
          if (typeof picked === "string") {
            location = picked;
            where.textContent = displayPath(location, home);
          }
        },
      }, t("Choose…"))),
    h("div", { class: "dialog-buttons" }, h("button", { type: "button", class: "cancel" }, t("Cancel")), ok),
  );
  const { result, close } = modal<string | null>(form, null);
  let closed = false;
  void result.then(() => (closed = true));
  form.querySelector(".cancel")!.addEventListener("click", () => close(null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!url.value.trim()) return url.focus();
    ok.disabled = true;
    ok.textContent = t("Cloning…");
    try {
      const folder = await ipc.gitClone(url.value.trim(), location);
      if (!closed) close(folder);
    } catch (error) {
      await alert(t("The repository could not be cloned"), String(error));
    }
    ok.disabled = false;
    ok.textContent = t("Clone");
  });
  url.focus();
  return result;
}
