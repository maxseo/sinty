# Kanban

One board. Columns: Бэклог → К выполнению → В работе → Проверка → Готово.

A card stores a roster `assigneeId`, a `reviewerId`, a `projectId` taken from the project it was created in, a priority, a label, `dependsOn`, and `notify` (`chat` or `none`). It starts only when it is in the queue or dragged to «В работе», it has an assignee, and every dependency is in «Готово». Up to `maxParallel` (default 3) run at once, each in its own session. Dragging a running card out of «В работе» interrupts that session. A finished turn moves the card to «Проверка». The reviewer (when set and not the author) gets a review session and may move it to «Готово» or back to «К выполнению». The author cannot accept their own card.

`notify: chat` copies comments into the latest team chat of the card's project. `none` stays on the board. Messenger connectors are not part of this plugin.

Tools: `kanban.list`, `kanban.create`, `kanban.update`. The lead procedure is the skill `kanban-lead`.
