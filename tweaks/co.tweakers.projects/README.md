# Projects

Projects adds colors, organization, connection references, and a read-only
repository inventory to the native Projects sidebar.

## Project menu

When current Codex routes a project dropdown through Electron, Projects pauses
only that project-shaped native popup and sends a bounded snapshot to the
owning renderer. The renderer draws Codex's compact rounded menu surface with
the original command order, disabled state, icons, and nested submenus, then
adds **Project color** and **Task sorting**. Selecting a Codex command calls its
original Electron menu-item handler; the tweak does not reimplement Edit,
Reveal, Section, Archive, Remove, or future host behavior.

If the renderer does not confirm the exact project gesture promptly, or the
project identity and menu signature are ambiguous, the bridge fails open to
Electron's untouched native menu. The older renderer-portal path remains as a
compatibility fallback for Codex versions that expose their menu in the DOM.

## Task ordering

Each project folder can independently keep Codex's default task order or sort
its tasks by created or last-updated date in either direction. Tasks can also
be pinned inside one project; these local pins stay above that project's
selected date order and do not change Codex's global pinned list. Sorting and
local pins use stable task identifiers rather than visible task titles.

## First run and recovery

The first settings-page load creates a project entry only from a native project
with one exact local root. That root is saved with the entry before it is used
for repository inventory. A project with no root, multiple roots, or an
ambiguous match stays unbound and shows **Repair folder** in Projects settings.
Choose that action to set one primary local folder.

Project state is stored in the tweak data directory as `projects-v1.json` with
one last-known-good copy in `projects-v1.lkg.json`. If the primary file is
unreadable, the tweak uses that recovery copy and reports the recovery status.

## Data and privacy

Saved state contains project names, ordering, colors, folder-local task sort
choices and pinned task identifiers, safe connection
references, optional GitHub `owner/repository` names, and primary local project
paths. It does not store provider tokens, browser cookies, passwords, or GitHub
credentials. Paths are used locally only to find repositories and fixed,
non-secret project metadata such as `supabase/config.toml`, `.vercel/project.json`,
and Modal app files. It never reads `.env`, `.npmrc`, or credential files.

## Inventory behavior

Repository inventory runs locally and read-only. It limits roots, directories,
repository count, concurrency, per-command time, and total scan time. It can
be cancelled when the selected project changes, shows progress while scanning,
caches a recent result, and labels incomplete work as partial rather than
claiming a complete inventory.

GitHub branch refresh is an explicit action. It uses the same per-project
request token, cancellation, and bounded progress lifecycle as local inventory,
so changing projects, rescanning, closing the page, or stopping the service
cannot paint an older provider response. It uses an already-configured GitHub
CLI identity for a short-lived command environment; it does not save the token.
A failed refresh leaves local inventory available and reports the failed remote
so it can be retried.
