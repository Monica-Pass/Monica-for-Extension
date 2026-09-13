import { createApp } from "vue";
import PopupApp from "./PopupApp.vue";
import "../styles.css";
import "./popup.css";
import "../nothing.css";
import "../responsive.css";
import "../lib/action-button-layout";
import { initializeI18n } from "../i18n";

// Action popups size their viewport from the document. Give that surface an
// intrinsic width before mounting; standalone tabs can still follow their viewport.
if (globalThis.chrome?.extension?.getViews?.({ type: "popup" }).includes(window)) {
  document.documentElement.classList.add("action-popup");
}

void initializeI18n().then(() => createApp(PopupApp).mount("#popup-root"));
