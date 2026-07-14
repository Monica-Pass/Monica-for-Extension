import { computed, onMounted, onUnmounted, ref, watch } from "vue";

export type SchemePreference = "auto" | "light" | "dark";
export type ThemePaletteId = "monica" | "ocean" | "forest" | "sakura" | "amber";

export type ThemePalette = {
  id: ThemePaletteId;
  color: string;
  accent: string;
  light: Record<string, string>;
  dark: Record<string, string>;
};

export const palettes: ThemePalette[] = [
  palette("monica", "#0b6f69", "#f5c84c", ["#f4f8f6", "#e5efec", "#d7e4e1", "#bfded9"], ["#0f1514", "#17201f", "#1e2b29", "#24403c"]),
  palette("ocean", "#1769aa", "#24c6dc", ["#f4f7fb", "#e3edf5", "#d5e3ee", "#c6d9e8"], ["#0d141b", "#14202a", "#1b2d3b", "#213f55"]),
  palette("forest", "#2f6b3f", "#b6d86f", ["#f5f8f1", "#e6eee0", "#d8e3d0", "#c9dabc"], ["#10160f", "#182218", "#202e21", "#2c3d2c"]),
  palette("sakura", "#9d405f", "#f2b6c8", ["#faf5f6", "#f1e5e9", "#ead7df", "#e2c7d1"], ["#1a1014", "#291820", "#3a202b", "#542d3b"]),
  palette("amber", "#7c5a00", "#ffd35a", ["#f8f4e8", "#eee5cf", "#e4d7b9", "#d8c89f"], ["#171309", "#241d0e", "#362b12", "#4c3b16"])
];

const schemeKey = "monica.scheme";
const paletteKey = "monica.palette";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export const schemePreference = ref<SchemePreference>(readScheme());
export const paletteId = ref<ThemePaletteId>(readPalette());
export const prefersDark = ref(media.matches);

export const activePalette = computed(() => palettes.find((item) => item.id === paletteId.value) ?? palettes[0]);
export const activeScheme = computed(() => (schemePreference.value === "auto" ? (prefersDark.value ? "dark" : "light") : schemePreference.value));
export const themeColor = computed(() => activePalette.value.color);

export function setScheme(value: SchemePreference) {
  schemePreference.value = value;
}

export function setPalette(value: ThemePaletteId) {
  paletteId.value = value;
}

export function useThemePreferences() {
  onMounted(() => {
    applyTheme();
    media.addEventListener("change", updatePreferredScheme);
  });
  onUnmounted(() => media.removeEventListener("change", updatePreferredScheme));
}

watch([schemePreference, paletteId, activeScheme], applyTheme);
watch(schemePreference, (value) => localStorage.setItem(schemeKey, value));
watch(paletteId, (value) => localStorage.setItem(paletteKey, value));

function applyTheme() {
  const root = document.documentElement;
  const colors = activePalette.value[activeScheme.value];
  root.dataset.theme = activeScheme.value;
  root.style.setProperty("--app-bg", colors["bg"]);
  root.style.setProperty("--app-surface", colors["surface"]);
  root.style.setProperty("--app-surface-high", colors["surfaceHigh"]);
  root.style.setProperty("--app-selected", colors["selected"]);
  root.style.setProperty("--app-primary", activePalette.value.color);
  root.style.setProperty("--app-accent", activePalette.value.accent);
}

function updatePreferredScheme(event: MediaQueryListEvent) {
  prefersDark.value = event.matches;
}

function readScheme(): SchemePreference {
  const value = localStorage.getItem(schemeKey);
  return value === "auto" || value === "light" || value === "dark" ? value : "auto";
}

function readPalette(): ThemePaletteId {
  const value = localStorage.getItem(paletteKey);
  return palettes.some((item) => item.id === value) ? (value as ThemePaletteId) : "monica";
}

function palette(id: ThemePaletteId, color: string, accent: string, light: string[], dark: string[]): ThemePalette {
  return {
    id,
    color,
    accent,
    light: colorSet(light),
    dark: colorSet(dark)
  };
}

function colorSet(values: string[]) {
  return {
    bg: values[0],
    surface: values[1],
    surfaceHigh: values[2],
    selected: values[3]
  };
}
