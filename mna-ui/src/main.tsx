import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/geist";
import "@fontsource-variable/manrope";
import { initializeTheme } from "./lib/theme-store";
import "./styles.css";
import "./chat/chat.css";
import "./theme/theme.css";
import "./ui/controls.css";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
