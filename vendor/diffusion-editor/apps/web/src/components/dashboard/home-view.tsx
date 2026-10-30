/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { isServer } from "solid-js/web";
import { createElementSize } from "@solid-primitives/resize-observer";
import { toast } from "somoto";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import {
  AttachmentTile,
  DropOverlay,
  ModelPicker,
  attachmentPaths,
  createDropZone,
  createPasteHandler,
  currentModel,
  mergeAttachments,
  pickAttachments,
  setStoredModel,
  startChat,
  type Attachment,
} from "@/agent-chat";
import { projectRoute, useReturnHere } from "@/hooks/use-project-route";
import { track } from "@/lib/analytics";
import {
  createProject,
  isDesktop,
  projectKey,
  type ProjectInfo,
} from "@/projects";

import { DeleteProjectDialog } from "./delete-project-dialog";
import { DashboardProjectCard } from "./project-card";
import { createProjectSelection } from "./selection";
import {
  DashboardCardButton,
  DashboardCardMeta,
  DashboardCardPreview,
  createBackgroundClickHandler,
  createNewProject,
  createProjectList,
  openProjectFromList,
} from "./shared";
import { parseTimestamp } from "./utils";

/**
 * Where the prompt lands: a project chosen from the recents or, until one is
 * chosen, a fresh project under the application folder.
 */
type PromptTarget =
  | { kind: "new" }
  | { kind: "project"; project: ProjectInfo };

/**
 * Recents get one row, and as many cards as fit it at about this width — so a
 * wider window shows more projects rather than bigger cards. The new-project
 * card is one of them.
 */
const RECENT_CARD_WIDTH_PX = 180;
const RECENT_MIN_COLUMNS = 2;
/** The grid's `gap-x-1.5`. */
const RECENT_GAP_PX = 6;

/** Recent projects the target menu offers before it gets unwieldy. */
const MENU_PROJECTS = 8;


/** The edits the placeholder cycles through, one whole line at a time. */
const PROMPT_EXAMPLES = [
  "Turn this footage into a polished YouTube video. Add readable captions and an attention-grabbing graphic in the opening to give viewers a strong visual hook.",
  "Can you pull the best 30-second moment from https://youtu.be/MtQ0qxyf-Ds and make a vertical version for social?",
  "Name three recurring locations and give one visual cue that distinguishes each. https://youtu.be/dQw4w9WgXcQ",
];

/** Milliseconds a line takes to fade in or out, and how long it stays readable. */
const FADE_MS = 500;
const HOLD_MS = 2400;
const PROMPT_MAX_HEIGHT_PX = 200;

export function DashboardHomeView() {
  const navigate = useNavigate();
  const returnHere = useReturnHere();

  const [prompt, setPrompt] = createSignal("");
  const [target, setTarget] = createSignal<PromptTarget>({ kind: "new" });
  const [busy, setBusy] = createSignal(false);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);

  const attach = (added: Attachment[]) => setAttachments((current) => mergeAttachments(current, added));
  const drop = createDropZone(attach);
  const paste = createPasteHandler(attach);


  let textarea: HTMLTextAreaElement | undefined;

  createEffect(() => {
    if (!textarea) return;
    prompt();
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, PROMPT_MAX_HEIGHT_PX)}px`;
  });

  // Only worth animating while the field is empty — the placeholder is not on
  // screen behind text the user has typed.
  const placeholder = createFadingPlaceholder(() => prompt().length === 0);

  // The projects the app knows — created here, or opened from a folder —
  // refetched whenever that list changes.
  const [projects, { refetch: refetchProjects }] = createProjectList();
  // The model is shared with the chat panel and remembered across sessions;
  // the picker is fed by the agent host's probes, so what it offers is what
  // is installed and signed in.
  const model = createMemo(() => currentModel());

  const [recentGrid, setRecentGrid] = createSignal<HTMLElement>();
  const recentGridSize = createElementSize(recentGrid);
  const recentColumns = createMemo(() => {
    const width = recentGridSize.width ?? 0;
    const fit = Math.floor((width + RECENT_GAP_PX) / (RECENT_CARD_WIDTH_PX + RECENT_GAP_PX));
    return Math.max(RECENT_MIN_COLUMNS, fit);
  });

  const recentProjects = createMemo(() =>
    [...(projects() ?? [])].sort(
      (a, b) => parseTimestamp(b.modifiedAt) - parseTimestamp(a.modifiedAt),
    ),
  );
  /** The recents that fit the row, beside the new-project card. */
  const visibleRecents = createMemo(() => recentProjects().slice(0, recentColumns() - 1));

  const targetLabel = () => {
    const current = target();
    if (current.kind === "project") return current.project.displayName;
    return "";
  };

  const canSubmit = () => prompt().trim().length > 0 && !busy() && model() !== null;

  /**
   * The folder the agent will work in: the chosen recent project or, with none
   * chosen, a fresh project under the application folder.
   */
  const resolveTarget = async (): Promise<ProjectInfo | null> => {
    const current = target();
    // A project off the list is its record; the folder is looked at now.
    if (current.kind === "project") return openProjectFromList(current.project);

    return createProject();
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;

    if (!isDesktop()) {
      toast.error("Projects on disk are only available in the desktop app");
      return;
    }

    const paths = attachmentPaths(attachments());
    const ref = model();
    if (!ref) return;
    const text = prompt();
    setBusy(true);

    try {
      const project = await resolveTarget();
      if (!project) return;

      // The chat starts before the page switches: the host has the turn as
      // soon as it answers, and the editor lands with the reply streaming.
      // On failure the text survives as the project's draft (see startChat).
      await startChat({ project, text, attachments: paths, model: ref });
      setPrompt("");
      setAttachments([]);
      setTarget({ kind: "new" });
      refetchProjects();
      navigate(projectRoute(projectKey(project)), { state: returnHere() });
    } catch (e) {
      toast.error("Could not open the project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = (key: string) => {
    setAttachments((current) => current.filter((entry) => entry.key !== key));
  };

  // Enter sends, shift+enter breaks the line — and the dashboard's global
  // shortcuts have no business reading what is typed here.
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();

    // Tab takes the example that is on screen, which is only offered while the
    // field is empty; with something typed, tab is still tab and moves focus.
    if (event.key === "Tab" && !event.shiftKey && prompt().length === 0) {
      event.preventDefault();
      setPrompt(placeholder.line());
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    void handleSubmit();
  };

  const [pendingDelete, setPendingDelete] = createSignal<ProjectInfo[]>([]);

  const selection = createProjectSelection({
    projects: visibleRecents,
    grid: recentGrid,
    onDelete: setPendingDelete,
  });

  // Anything outside a card clears the selection — the grid's gaps, the space
  // around it, and the composer above it. A click on a card is that card's.
  const clearSelection = createBackgroundClickHandler(selection.clear);

  const handleDeleted = () => {
    selection.clear();
    refetchProjects();
  };

  const openProject = async (project: ProjectInfo) => {
    const found = await openProjectFromList(project);
    if (!found) return;
    track("project_opened");
    navigate(projectRoute(projectKey(found)), { state: returnHere() });
  };

  const handleCreateProject = async () => {
    if (busy()) return;
    setBusy(true);

    try {
      const project = await createNewProject();
      if (!project) return;
      selection.clear();
      refetchProjects();
      openProject(project);
    } catch (e) {
      toast.error("Failed to create project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onClick={clearSelection}
      >
        <div class="flex flex-1 flex-col items-center justify-center gap-6.5 px-6 py-8 pt-[15%]">
          <h1 class="w-full text-center text-5xl leading-normal font-450 tracking-[0.0864px] text-muted-foreground">
            What should we edit?
          </h1>

          <div class="flex flex-col items-center">
            <div class="flex w-139 flex-col items-start rounded-t-xl border border-b-0 border-border bg-accent/50 px-1 pt-1 pb-0.5">
              <DropdownMenu placement="bottom-start">
                <DropdownMenuTrigger
                  as="button"
                  type="button"
                  aria-label="Choose the project to work in"
                  class="flex h-7 shrink-0 items-center rounded-md px-0.5 gap-0.5 text-xs font-450 text-muted-foreground hover:bg-accent"
                >
                  <span class="grid size-6 shrink-0 place-items-center overflow-clip">
                    <Icon name="navigation.folder" />
                  </span>
                  <span class="max-w-60 truncate translate-y-px">{targetLabel()}</span>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="w-60">
                    <Show when={recentProjects().length > 0}>
                      <DropdownMenuGroup>
                        <DropdownMenuGroupLabel>
                          Recent projects
                        </DropdownMenuGroupLabel>
                        <For each={recentProjects().slice(0, MENU_PROJECTS)}>
                          {(project) => (
                            <DropdownMenuItem
                              onSelect={() =>
                                setTarget({ kind: "project", project })
                              }
                            >
                              <Icon name="navigation.folder" />
                              <span class="min-w-0 flex-1 truncate">
                                {project.displayName}
                              </span>
                            </DropdownMenuItem>
                          )}
                        </For>
                      </DropdownMenuGroup>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
            </div>

            <div
              class="relative z-10 flex w-149 flex-col gap-2 rounded-[20px] border border-border bg-accent p-2 focus-within:border-border-input"
              onDragOver={drop.onDragOver}
              onDragEnter={drop.onDragEnter}
              onDragLeave={drop.onDragLeave}
              onDrop={drop.onDrop}
              onPaste={paste}
            >
              <Show when={attachments().length > 0}>
                {/* The remove buttons overhang the tiles' corners, and a
                    scrolling row clips at its edge — so the row pads for them
                    and pulls itself back up by the same amount. */}
                <div class="-mt-2.5 flex w-full items-start gap-2 overflow-x-auto pt-2.5 pr-2.5">
                  <For each={attachments()}>
                    {(entry) => (
                      <AttachmentTile
                        attachment={entry}
                        onRemove={() => removeAttachment(entry.key)}
                      />
                    )}
                  </For>
                </div>
              </Show>

              <div class="grid">
                <Show when={prompt().length === 0}>
                  <span
                    aria-hidden="true"
                    class="pointer-events-none [grid-area:1/1] whitespace-pre-wrap break-words p-1 text-[12px] leading-5 text-muted-foreground transition-opacity ease-in-out"
                    style={{ "transition-duration": `${FADE_MS}ms` }}
                    classList={{ "opacity-0": !placeholder.visible() }}
                  >
                    {placeholder.line()}
                    <Kbd class="ml-1 h-4 min-w-0 rounded-sm px-0.5 -mt-0.5 pt-px align-middle text-foreground opacity-70">
                      Tab
                    </Kbd>
                  </span>
                </Show>

                <textarea
                  ref={textarea}
                  value={prompt()}
                  onInput={(event) => setPrompt(event.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                  onKeyUp={(event) => event.stopPropagation()}
                  aria-label="Describe the edit you want"
                  aria-placeholder={placeholder.line()}
                  aria-keyshortcuts={prompt().length === 0 ? "Tab" : undefined}
                  rows={2}
                  class="[grid-area:1/1] max-h-60 min-h-12 w-full resize-none overflow-y-auto bg-transparent p-1 text-[12px] leading-5 text-foreground outline-none selection:bg-selection selection:text-selection-foreground"
                />
              </div>

              <div class="flex min-h-4 items-center justify-between">
                <Button
                  variant="ghost"
                  size="icon-square"
                  onClick={async () => attach(await pickAttachments())}
                  aria-label="Add files"
                  title="Add files"
                  class="text-muted-foreground hover:bg-muted"
                >
                  <Icon name="plus-add" />
                </Button>

                <div class="flex min-w-0 items-center gap-1.5">
                  <ModelPicker value={model()} onSelect={setStoredModel} class="min-w-0" />

                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit()}
                    aria-label="Send to the coding agent"
                    class="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Show when={busy()} fallback={<Icon name="arrow-top" />}>
                      <Icon name="spinner-loader" class="animate-spin" />
                    </Show>
                  </button>
                </div>
              </div>

              <Show when={drop.dragging()}>
                <DropOverlay />
              </Show>
            </div>
          </div>
        </div>

        <div class="flex shrink-0 flex-col">
          <div class="flex items-end gap-6 px-6 pt-4 pb-3">
            <h2 class="min-w-0 flex-1 text-2xl leading-6 font-450 text-foreground">
              Recents
            </h2>
          </div>
          {/* Measured without its padding, so the width is what the cards share. */}
          <div class="px-4 pb-4">
            <div
              ref={setRecentGrid}
              data-slot="card-grid"
              class="grid items-start gap-x-1.5 gap-y-3"
              style={{ "grid-template-columns": `repeat(${recentColumns()}, minmax(0, 1fr))` }}
            >
              <DashboardCardButton onClick={handleCreateProject}>
                <DashboardCardPreview class="bg-overlay-soft group-hover:bg-overlay">
                  <Icon
                    name="plus-add"
                    class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                </DashboardCardPreview>
                <DashboardCardMeta title="New project" />
              </DashboardCardButton>
              <For each={visibleRecents()}>
                {(project) => (
                  <DashboardProjectCard
                    project={project}
                    active={selection.isSelected(project)}
                    targets={selection.targets(project)}
                    onSelect={(event) => selection.click(project, event)}
                    onContextMenu={() => selection.contextMenu(project)}
                    onOpen={() => openProject(project)}
                    onDelete={() => setPendingDelete(selection.targets(project))}
                    onChanged={refetchProjects}
                  />
                )}
              </For>
            </div>
          </div>
        </div>
      </div>

      <DeleteProjectDialog
        projects={pendingDelete()}
        onClose={() => setPendingDelete([])}
        onDeleted={handleDeleted}
      />
    </>
  );
}

/**
 * The composer's placeholder, cycling through {@link PROMPT_EXAMPLES}: each
 * prompt fades in whole, however many lines it wraps to, holds long enough
 * to be read, fades out, and the next one follows. It pauses whenever `active` goes false, and for anyone who asked
 * the system for less motion it settles on the first line and stays there.
 */
function createFadingPlaceholder(active: () => boolean) {
  const [index, setIndex] = createSignal(0);
  const line = () => PROMPT_EXAMPLES[index()];

  if (
    isServer ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return { line, visible: () => true };
  }

  const [visible, setVisible] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = () => {
    if (visible()) {
      setVisible(false);
      timer = setTimeout(step, FADE_MS);
    } else {
      setIndex((current) => (current + 1) % PROMPT_EXAMPLES.length);
      setVisible(true);
      timer = setTimeout(step, FADE_MS + HOLD_MS);
    }
  };

  createEffect(() => {
    clearTimeout(timer);
    setVisible(false);
    if (!active()) return;

    // The span mounts at opacity 0 first, so its first line fades in like
    // the rest instead of appearing in one go.
    timer = setTimeout(() => {
      setVisible(true);
      timer = setTimeout(step, FADE_MS + HOLD_MS);
    }, 50);
  });
  onCleanup(() => clearTimeout(timer));

  return { line, visible };
}
