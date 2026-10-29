# Pages are internal records; the constructor picks the design

Страницы was creating the front page. The constructor was a list of every record and a create form.

## What changed

Страницы asks for the title, the address, meta title, meta description and the body. The front page is not in that list. Конструктор has a type (front page, page, category) and a second list of the matching records. A page design is only that page. A category design is used when a record in that category has no layout of its own. The widget canvas is still one column.

## Why

That is how the existing site admin separates content from layout. The Vue builder (drag, devices, miniatures) is not this screen.
