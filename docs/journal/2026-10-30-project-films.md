# Films live inside the harness project

Diffusion Studio's own home screen was a second project list: All, Drafts, Untitled, and a prompt to connect their agent. The harness already has projects.

## What changed

The Diffusion sidebar tab is gone. Each harness project has a Видео tab. It lists films stored under that project and opens the editor for the one you pick. Their dashboard route now leaves back to that list. A film is found by its id on disk, so the editor does not need their old project database. Agent commands still go to the open film.

## Why

The person wants the editor as a tool inside a project, not a second harness. A film belongs to the project it was made in.

The «Новый фильм» button did not run. The tab frame is sandboxed without form submission, so the browser dropped the submit. The button now calls the create request itself, and the frame is allowed to submit the form.
