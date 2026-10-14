"""Private owners composed by :mod:`kiro_crew.dashboard.chat_runner`.

The dashboard chat runner is split by responsibility across the modules of this
package, and ``kiro_crew.dashboard.chat_runner`` stays its only import path and
its only patch surface: nothing but the runner imports an owner.

Each owner holds the runner's top-level helpers for its responsibility, moved
verbatim, and functions extracted from ``_run_chat`` and ``_start_next_queued_turn``
whose bodies keep the original statements and take the original locals as
same-named parameters. :func:`kiro_crew._facade_compose.compose` makes every function
an owner defines -- its module functions and the methods of the classes it defines --
run on the runner's module globals rather than its own. Tests patch the runner's names
(``chat_runner.sel``, ``.save_slot_off_loop``, ``._flush_file_changes`` and about a
hundred more). A function that read its owner's globals would keep calling the unpatched
object and the test would pass while exercising nothing, so the runner stays ONE
namespace, as the one-module file was. Three consequences follow:

* An owner's imports are inert for its functions. An owner imports the runner and
  its siblings only under ``TYPE_CHECKING``; stdlib names, and the project constants
  the module evaluates when it loads (``steer_queue`` from ``chat_utils``,
  ``tool_approval`` from ``deny_guidance``), are imported plainly. Both serve the
  type checker and the linter, and what the module itself evaluates when it loads
  (a default argument, a class base, a constant). Every name a function
  reads must exist in ``kiro_crew.dashboard.chat_runner`` -- which is why the
  runner keeps imports only its owners read, marked ``# noqa: F401`` -- and
  ``test_chat_runner_composition_contract.py`` sweeps each function's bytecode to
  prove it does.
* A function's ``__module__`` reads ``kiro_crew.dashboard.chat_runner`` as it did
  before the split, so reprs and pickling by reference are unchanged, and it logs
  through the runner's ``logger``. Its source file differs, so a log record's
  ``module``, ``filename`` and ``lineno`` name the owner file. An owner's classes
  keep their own module, which is where ``inspect`` looks for a class's source.
* State the runner owns stays on the runner. A module-level mutable (a registry,
  a cache, a semaphore) is a runner global that owner functions reach by name
  through the runner's namespace, so a test that rebinds it on the runner is the
  one every function sees.

The runner has no orchestrator class, so it composes without a ``host``: this is the
module-function half of what the Slack gateway does.

Which responsibility each owner holds, and which constructs stay in the runner
because repository guards read them there, is recorded in
``docs/system-specs/modules/learn-cron-dashboard.md`` (Chat runner composition).
"""
