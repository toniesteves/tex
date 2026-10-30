// New Project: pick a template, a name and a folder; the project is created there and opened.
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import * as ipc from "../ipc";
import { TEMPLATES } from "../latex/templates";
import { dirname, displayPath, h, joinPath } from "../util";
import { alert, modal } from "./dialogs";
import { icon } from "./icons";

/** Resolves with the new project's folder, or null when cancelled. */
export async function newProject(parent: string, home: string | null): Promise<string | null> {
  let chosen = TEMPLATES[0]!;
  let location = parent;
  const name = h("input", { type: "text", value: t("New project"), spellcheck: "false" });
  const where = h("span", { class: "location-path" }, displayPath(location, home));
  const cards = TEMPLATES.map((template) =>
    h("button", {
      type: "button",
      class: `template${template === chosen ? " selected" : ""}`,
      onclick: () => {
        chosen = template;
        cards.forEach((card, i) => card.classList.toggle("selected", TEMPLATES[i] === template));
      },
      ondblclick: () => form.requestSubmit(),
    }, icon(template.id === "beamer" ? "present" : template.id === "blank" ? "file" : "tex", 22), h("strong", null, t(template.title)), h("span", null, t(template.description))),
  );
  const form = h("form", { class: "dialog wide" },
    h("h2", null, t("New Project")),
    h("div", { class: "templates" }, cards),
    h("label", null, t("Name"), name),
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
    h("div", { class: "dialog-buttons" }, h("button", { type: "button", class: "cancel" }, t("Cancel")), h("button", { class: "primary" }, t("Create"))),
  );
  const { result, close } = modal<string | null>(form, null);
  form.querySelector(".cancel")!.addEventListener("click", () => close(null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const folder = joinPath(location, name.value.trim().replace(/[/\\]/g, "-"));
    if (!name.value.trim()) return name.focus();
    try {
      await ipc.createDir(folder);
      for (const [path, text] of Object.entries(chosen.files())) {
        const target = joinPath(folder, path);
        if (dirname(target) !== folder) await ipc.createDir(dirname(target)).catch(() => {});
        await ipc.writeText(target, text, "utf-8");
      }
      close(folder);
    } catch (error) {
      await alert(t("The project could not be created"), String(error));
    }
  });
  name.focus();
  name.select();
  return result;
}
