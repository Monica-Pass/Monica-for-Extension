import { computed, onMounted, onUnmounted, ref, watch } from "vue";

export type SchemePreference = "auto" | "light" | "dark";
export type ThemePaletteId = "nothing" | "monica" | "ocean" | "forest" | "sakura" | "amber";

export type ThemePalette = {
  id: ThemePaletteId;
  color: string;
  darkColor: string;
  accent: string;
  light: Record<string, string>;
  dark: Record<string, string>;
};

export const palettes: ThemePalette[] = [
  palette("nothing", "#1a1a1a", "#ffffff", "#d71921", ["#f5f5f3", "#ffffff", "#eeeee9", "#e8e8e4"], ["#000000", "#111111", "#1a1a1a", "#252525"]),
  palette("monica", "#0b6f69", "#8de8dc", "#f5c84c", ["#f2f7f4", "#ffffff", "#e4eeea", "#c4e8dd"], ["#0f1514", "#17201f", "#1e2b29", "#24403c"]),
  palette("ocean", "#1769aa", "#a9c7ff", "#24c6dc", ["#f3f7fc", "#ffffff", "#e3edf5", "#cee2fa"], ["#0d141b", "#14202a", "#1b2d3b", "#213f55"]),
  palette("forest", "#2f6b3f", "#b5d7b2", "#b6d86f", ["#f3f7ee", "#ffffff", "#e6eee0", "#d2e9c9"], ["#10160f", "#182218", "#202e21", "#2c3d2c"]),
  palette("sakura", "#9d405f", "#ffb1c8", "#f2b6c8", ["#fcf5f7", "#fffbfc", "#f1e5e9", "#ffdae5"], ["#1a1014", "#291820", "#3a202b", "#542d3b"]),
  palette("amber", "#7c5a00", "#ffdc7a", "#ffd35a", ["#fbf7ec", "#fffdfa", "#eee5cf", "#f3e1aa"], ["#171309", "#241d0e", "#362b12", "#4c3b16"])
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
  root.dataset.palette = paletteId.value;
  root.style.setProperty("--app-bg", colors["bg"]);
  root.style.setProperty("--app-surface", colors["surface"]);
  root.style.setProperty("--app-surface-high", colors["surfaceHigh"]);
  root.style.setProperty("--app-selected", colors["selected"]);
  root.style.setProperty("--app-primary", activeScheme.value === "dark" ? activePalette.value.darkColor : activePalette.value.color);
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

function palette(id: ThemePaletteId, color: string, darkColor: string, accent: string, light: string[], dark: string[]): ThemePalette {
  return {
    id,
    color,
    darkColor,
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
