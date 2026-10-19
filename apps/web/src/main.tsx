import { render } from "preact";
import { takeTokenFromUrl } from "./api.js";
import { App } from "./app.js";
import "./style.css";

takeTokenFromUrl();
const storedTheme = localStorage.getItem("sinty.theme");
document.documentElement.dataset.theme =
  storedTheme === "dark" || storedTheme === "light" ? storedTheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
render(<App />, document.getElementById("app")!);
