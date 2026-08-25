import { readFileSync } from "node:fs";

function parseColor(raw) {
  const hex = raw?.match(/^#([0-9a-fA-F]{6})$/);
  if (!hex) return null;
  const value = hex[1];
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const styles = readFileSync("src/styles.css", "utf8");
const lightText = parseColor("#1d1b20");
const lightMuted = parseColor("#49454f");
const darkText = parseColor("#e7e4e8");
const darkMuted = parseColor("#c9c4cf");

const palettes = [
  { id: "monica", color: "#0b6f69", darkColor: "#8de8dc", light: ["#f4f8f6", "#e5efec", "#d7e4e1", "#bfded9"], dark: ["#0f1514", "#17201f", "#1e2b29", "#24403c"] },
  { id: "ocean", color: "#1769aa", darkColor: "#a9c7ff", light: ["#f4f7fb", "#e3edf5", "#d5e3ee", "#c6d9e8"], dark: ["#0d141b", "#14202a", "#1b2d3b", "#213f55"] },
  { id: "forest", color: "#2f6b3f", darkColor: "#b5d7b2", light: ["#f5f8f1", "#e6eee0", "#d8e3d0", "#c9dabc"], dark: ["#10160f", "#182218", "#202e21", "#2c3d2c"] },
  { id: "sakura", color: "#9d405f", darkColor: "#ffb1c8", light: ["#faf5f6", "#f1e5e9", "#ead7df", "#e2c7d1"], dark: ["#1a1014", "#291820", "#3a202b", "#542d3b"] },
  { id: "amber", color: "#7c5a00", darkColor: "#ffdc7a", light: ["#f8f4e8", "#eee5cf", "#e4d7b9", "#d8c89f"], dark: ["#171309", "#241d0e", "#362b12", "#4c3b16"] }
];

let failures = 0;
for (const palette of palettes) {
  for (const scheme of ["light", "dark"]) {
    const set = palette[scheme];
    const text = scheme === "light" ? lightText : darkText;
    const muted = scheme === "light" ? lightMuted : darkMuted;
    const primary = parseColor(scheme === "light" ? palette.color : palette.darkColor);
    const surfaces = { bg: set[0], surface: set[1], surfaceHigh: set[2], selected: set[3] };
    const checks = [
      ["text/bg", text, surfaces.bg],
      ["muted/bg", muted, surfaces.bg],
      ["muted/surface", muted, surfaces.surface],
      ["muted/surfaceHigh", muted, surfaces.surfaceHigh],
      ["text/selected", text, surfaces.selected],
      ["muted/selected", muted, surfaces.selected],
      ["primary/bg", primary, surfaces.bg]
    ];
    for (const [label, fg, bg] of checks) {
      const foreground = Array.isArray(fg) ? fg : parseColor(String(fg)) ?? [];
      const background = Array.isArray(bg) ? bg : parseColor(String(bg)) ?? [];
      if (foreground.length !== 3 || background.length !== 3) { console.log(`${palette.id}/${scheme} ${label}: unresolvable`); continue; }
      const ratio = contrast(foreground, background);
      const status = ratio >= 4.5 ? "PASS" : ratio >= 3 ? "LARGE-ONLY" : "FAIL";
      if (status !== "PASS") failures += 1;
      console.log(`${palette.id}/${scheme} ${label}: ${ratio.toFixed(2)}:1 ${status}`);
    }
  }
}
console.log(failures ? `${failures} non-passing pairs` : "all pairs pass 4.5:1");
