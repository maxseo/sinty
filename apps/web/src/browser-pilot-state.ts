export interface PilotAgent { id: string; name: string }
export interface PilotProject { id: string; name: string; agentIds: string[]; pilotAgentIds?: string[] }
export interface PilotChoices { agents: PilotAgent[]; projects: PilotProject[] }
/** Uses authoritative API eligibility, not display names or client-invented identities. */
export function pilotAgentChoices(pilot: PilotChoices | undefined, projectId: string): PilotAgent[] {
  const project = pilot?.projects.find(p => p.id === projectId);
  if (!pilot || !project) return [];
  const ids = new Set(project.pilotAgentIds ?? project.agentIds);
  return pilot.agents.filter(agent => ids.has(agent.id));
}
export function pilotAgentMessage(pilot: PilotChoices | undefined, projectId: string): string {
  if (!pilot || !projectId) return "Сначала выберите проект.";
  if (!pilot.agents.length) return "В реестре пока нет доступных агентов.";
  const project = pilot.projects.find(p => p.id === projectId);
  if (!project) return "Выбранный проект больше не доступен.";
  if (!pilotAgentChoices(pilot, projectId).length) return "Назначенные проекту агенты отсутствуют в текущем реестре.";
  return project.agentIds.length ? "" : "В проекте не закреплены агенты. Выберите существующего агента для этой пилотной сессии; состав проекта не изменится.";
}
