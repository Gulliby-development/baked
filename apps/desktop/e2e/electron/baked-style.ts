import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Helpers for the BAKED style rule: every popup, tooltip, menu and select is drawn by the app,
 * never by the system.
 */

/** Fails the test when the page opens a native alert, confirm or prompt. */
export function failOnNativeDialogs(page: Page): string[] {
  const opened: string[] = [];
  page.on("dialog", (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return opened;
}

/**
 * Checks the current screen for native controls that open a system popup: `<select>`, date,
 * time and colour pickers, and `<datalist>` suggestions.
 */
export async function expectBakedStyle(page: Page): Promise<void> {
  const native = await page.evaluate(() => {
    const found: string[] = [];
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
        el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""
      }`;
    for (const el of document.querySelectorAll("select, datalist")) found.push(describe(el));
    for (const el of document.querySelectorAll("input[list]")) found.push(describe(el));
    for (const el of document.querySelectorAll("input")) {
      const type = (el as HTMLInputElement).type;
      if (["date", "time", "datetime-local", "month", "week", "color"].includes(type))
        found.push(`${describe(el)} type=${type}`);
    }
    return found;
  });
  expect(native, "native controls that open a system popup").toEqual([]);
}

/**
 * Picks `option` in the dropdown named `name`: the app's own select (a `combobox` button with a
 * `listbox` popup) or, until a screen moves to it, a native `<select>`.
 */
export async function choose(
  scope: Page | Locator,
  name: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  const field = scope.getByRole("combobox", { name });
  const page = "goto" in scope ? scope : scope.page();
  if (await field.evaluate((el) => el.tagName === "SELECT")) {
    const label =
      typeof option === "string"
        ? option
        : await field.evaluate(
            (el, source) =>
              [...(el as HTMLSelectElement).options].find((o) =>
                new RegExp(source).test(o.textContent ?? ""),
              )?.textContent ?? source,
            option.source,
          );
    await field.selectOption({ label });
    return;
  }
  await field.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
