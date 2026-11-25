# Connection search options

Each connection stores `searchOptions` with independent allowlists of ranges (`page`, `folder`, `recursive`, `key`) and match types (`prefix`, `contains`, `exact`, `regex`). Existing and new connections default to all eight values. Empty lists are valid and disable search. Saving canonical order avoids changing settings when checkboxes are clicked in a different order. A copied connection inherits both lists.

The connection editor shows two checkbox groups. The file search strip shows only permitted ranges and matches. Full S3 key requires Exact; if Exact is disabled, Full S3 key is unavailable even if its range is checked. When the current selection becomes invalid, choose a permitted combination, preferring This folder + Exact. If no combination remains, keep Upload available and show that search is disabled.

The listings service rejects disallowed remote searches and direct URI lookups, including calls made through IPC outside the visible search form. The global URI search excludes connections that disallow Full S3 key + Exact when choosing a connection for a nonempty key. A bucket-root URI can still navigate without doing a key search. Existing connection files load with all search options allowed.

Tests cover normalization, persistence, copying, blocked backend calls, editor checkboxes, search mode reconciliation, global URI selection, and a hidden Electron smoke test. Electron tests remain hidden so they do not take desktop focus.
