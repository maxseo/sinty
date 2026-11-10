import { render } from "preact";
import { useState } from "preact/hooks";
import { ModelSettings, type ModelProfiles } from "../src/model-settings.js";
import "../src/style.css";
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
function Fixture() {
  const [route, setRoute] = useState("p/a"), [agent, setAgent] = useState("one");
  const [all, setAll] = useState<Record<string, ModelProfiles>>({ one: { "p/b": { maxOutputTokens: 8000, advanced: true, temperature: 0.5 } }, two: {} });
  return <main class="page"><label>Модель<select aria-label="Модель" value={route} onChange={e => setRoute(e.currentTarget.value)}><option>p/a</option><option>p/b</option></select></label><label>Агент<select aria-label="Агент" value={agent} onChange={e => setAgent(e.currentTarget.value)}><option>one</option><option>two</option></select></label><ModelSettings key={agent} route={route} profiles={all[agent]!} onChange={profiles => setAll(value => ({ ...value, [agent]: profiles }))} /><pre id="saved">{JSON.stringify(all)}</pre></main>;
}
render(<Fixture />, document.getElementById("app")!);
