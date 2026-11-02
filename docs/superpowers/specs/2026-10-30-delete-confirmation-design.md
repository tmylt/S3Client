# Delete confirmation design

Replace native delete/remove message boxes with a compact dialog inside the app. Match the existing connection dialog: white rounded panel, blurred overlay, subdued borders, Lucide icons, and the same typography and button sizing. Use a soft red trash icon and red destructive action, with Cancel focused by default.

Show the item name and full wrapping S3 URI in a separate summary card. Folder copy explicitly includes all descendants; connection removal states that remote objects are kept and unfinished operations are cancelled. Escape, close, and clicking outside cancel. Trap focus and restore it on dismissal; block background controls and shortcuts.

Main-process authorization remains in place. After validating a delete/remove request, send a single-use confirmation request to the renderer and await an explicit response for its random ID before any mutation. A second simultaneous request is cancelled. Window reload, close, or shutdown cancels pending confirmation. Keep existing connection mutation/admission checks and permission enforcement.

Verify confirmation identity/lifecycle in unit tests, accessibility and cancellation in renderer tests, and actual cancel/confirm behavior against temporary loopback S3 in both source and packaged desktop tests. Do not access real connection credentials or restart the user's running app.
