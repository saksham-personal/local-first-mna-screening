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

const GridDemo = React.lazy(() => import("./grid/GridDemo"));
const showGridDemo = new URLSearchParams(location.search).has("grid-demo");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      {showGridDemo ? <GridDemo /> : <App />}
    </React.Suspense>
  </React.StrictMode>,
);
