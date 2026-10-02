import { removeSamples, sampleItems, seedSamples } from "./demo.js";
import { locale, t } from "./i18n.js";
import { revision, vault } from "./session.js";
import { showToast } from "./state.js";

/** Sample data actions shared by the empty state, Settings and the palette. */

export async function loadSampleData(): Promise<void> {
  const store = vault.value;
  if (!store) return;
  const written = await seedSamples(store, sampleItems(locale.value), () => revision.value++);
  revision.value++;
  showToast(written ? t("samplesLoaded", { n: written }) : t("samplesNone"));
}

export async function removeSampleData(): Promise<void> {
  const store = vault.value;
  if (!store) return;
  const removed = await removeSamples(store, store.items());
  revision.value++;
  showToast(t("samplesRemoved", { n: removed }));
}
