# Site constructor

The first site slice stored a plain body. This slice stores the same block, row, column and widget tree the Syntet builder uses, limited to the widgets the first site needs.

## What changed

`site.layout` replaces the tree on a page, post or template. A widget is a type plus text props. Types: title, text, image, icon, button, menu, logo, breadcrumbs, slider, post_list, category_list, cover, description, author, date, post_nav, dynamic_block.

`site.template` appends one block whose only widget is `dynamic_block` pointing at a template id. The template is not copied. Rendering follows that link once. A template that points at another template is not followed, so two templates cannot loop.

`/p/site/view/<slug>` draws the tree. A record with an empty tree still shows the old body. A login-required page still hides both. The Конструктор tab lists records and the widget types on each one. It does not edit: the tab iframe can only GET, so the agent writes the tree.

## Why

The agreed plan puts the constructor before visitor login and forms. Keeping the template as a link means one edit updates every page that uses it, which is how `dynamic_block` works on Syntet.

## Test

`plugins/site/src/store.test.ts` also checks that `site.layout` and `site.template` attach a dynamic block.
