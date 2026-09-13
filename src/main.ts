import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import "./manager.css";
import "./nothing.css";
import "./responsive.css";
import "./detail-layout.css";
import "./home.css";
import "./lib/action-button-layout";
import { initializeI18n } from "./i18n";

void initializeI18n().then(() => createApp(App).mount("#root"));
