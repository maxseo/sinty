import { render } from "preact";
import { useState } from "preact/hooks";
import { CSelect } from "../src/cselect";
import { ModelSelect } from "../src/pages";
import { SkillsPane } from "../src/skills-pane";
import { KitPage } from "../src/kit";
import "../src/style.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
function SelectFixture() {
 const [value, setValue] = useState("provider/model-0");
 const options = Array.from({ length: 35 }, (_, i) => ({ value: "provider/model-" + i, label: "provider/model-" + i }));
 return <div style={{ height: "1200px", padding: "20px" }}>
  <input id="outside" aria-label="Внешнее поле" placeholder="Внешнее поле" />
  <div id="scrollbox" class="agent-page" style={{ marginTop: "50px", height: "280px", width: "440px", overflow: "auto", transform: "translateZ(0)", border: "1px solid var(--line)" }}>
    <div style={{ minHeight: "950px", flexShrink: 0, paddingTop: "40px" }}><div id="model-card" class="card" style={{ height: "170px", overflow: "hidden", padding: "16px" }}><div class="agent-section"><details class="acc" open><summary>Модели</summary><div class="body">
      <ModelSelect label="По умолчанию" variant="cselect" value={value} onChange={setValue} allowEmpty />
    </div></details></div></div></div>
  </div><output id="picked">{value}</output>
  <div id="edge" style={{ position: "fixed", bottom: "8px", right: "8px", width: "260px" }}><CSelect label="Нижний список" value={value} options={options} onChange={setValue} /></div>
 </div>;
}
const view = params.get("view");
render(view === "kit" ? <div style={{ height: "100vh", display: "flex" }}><KitPage /></div> : view === "skills" ? <div style={{ height: "100vh", display: "flex" }}><SkillsPane /></div> : <SelectFixture />, document.getElementById("fixture")!);
