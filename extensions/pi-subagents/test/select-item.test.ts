import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { manualDialogOptions } from "../src/ui/manual-dialog.ts";
import { type SelectUI, selectItem } from "../src/ui/select-item.ts";

it("forwards native options unchanged while disambiguating identical item labels", async () => {
  const items = [{ id: "first" }, { id: "second" }];
  const signal = new AbortController().signal;
  const options = manualDialogOptions({ signal, timeout: 4321 });
  const ui: SelectUI = {
    async select(title, labels, forwarded) {
      expect(this).toBe(ui);
      expect(title).toBe("Items");
      expect(labels).toEqual(["1. same", "2. same"]);
      expect(forwarded).toBe(options);
      expect(forwarded?.signal).toBe(signal);
      expect(forwarded?.timeout).toBe(4321);
      expect(Reflect.get({ ...forwarded }, Symbol.for("pi-extensions:input-dialog"))).toBe(false);
      return labels[1];
    },
  };
  expect(await selectItem(ui, "Items", items, () => "same", options)).toBe(items[1]);
});

it("keeps cancellation, unknown labels, and default legacy tracking unchanged", async () => {
  for (const answer of [undefined, "not offered"]) {
    expect(await selectItem({
      async select(_title: string, _labels: string[], options?: ExtensionUIDialogOptions) {
        expect(options).toBeUndefined();
        return answer;
      },
    }, "Items", [1, 2], () => "same")).toBeUndefined();
  }
});
