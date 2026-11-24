import { test } from "node:test";
import assert from "node:assert/strict";
import { pilotAgentChoices, pilotAgentMessage } from "./browser-pilot-state.js";
// Mirrors the real GET response: three roster agents, Research.agentIds=[], leadId="" in stored roster.
const agents = [{ id: "agt_331f7075", name: "Синтия" }, { id: "agt_78f9b9df", name: "Марина" }, { id: "agt_5e2538b0", name: "Деплой" }];
const payload = { agents, projects: [{ id: "prj_5020560b", name: "Ресеч", agentIds: [], pilotAgentIds: agents.map(a => a.id) }, { id: "assigned", name: "Assigned", agentIds: [agents[0]!.id], pilotAgentIds: [agents[0]!.id] }] };
test("actual API shape: empty Research project displays all three valid UUID choices, not an empty dropdown", () => {
  assert.deepEqual(pilotAgentChoices(JSON.parse(JSON.stringify(payload)), "prj_5020560b"), agents);
  assert.match(pilotAgentMessage(payload, "prj_5020560b"), /состав проекта не изменится/);
});
test("explicit project membership, missing project and stale UUIDs never expand selection", () => {
  assert.deepEqual(pilotAgentChoices(payload, "assigned"), [agents[0]]);
  assert.deepEqual(pilotAgentChoices(payload, "unknown"), []);
  const stale = { agents, projects: [{ id: "stale", name: "Stale", agentIds: ["deleted"], pilotAgentIds: ["deleted"] }] };
  assert.deepEqual(pilotAgentChoices(stale, "stale"), []);
  assert.match(pilotAgentMessage(stale, "stale"), /отсутствуют/);
});
test("true empty roster and unselected project show explicit guidance; old API stays restrictive", () => {
  assert.match(pilotAgentMessage({ agents: [], projects: payload.projects }, "prj_5020560b"), /нет доступных агентов/);
  assert.match(pilotAgentMessage(payload, ""), /выберите проект/);
  assert.deepEqual(pilotAgentChoices({ agents, projects: [{ id: "old", name: "Old", agentIds: [] }] }, "old"), []);
});
