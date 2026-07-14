import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith("m3e-")
        }
      }
    })
  ],
  base: "./",
  build: {
    rollupOptions: {
      input: {
        manager: resolve(__dirname, "index.html"),
        popup: resolve(__dirname, "popup.html")
      }
    }
  },
  server: {
    port: 5173
  }
});
