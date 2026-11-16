"""Agent sessions: the Claude Code or Codex session a task's agent runs, so it can resume."""

import json
import os
import re
import shutil
import time

from .base import HOME, now, run
from .agents import agent_running, detail


# ---- agent sessions -------------------------------------------------------------------------

# GitHub #1013: a `pgrep -P` per process (each reads every process on the machine) for each agent of each
# task, from every tracker and list, kept a busy machine's CPUs full. One read of the process table now
# serves all of a pass's lookups: /proc on Linux (no process started), one `ps` elsewhere (macOS).

TABLE_FOR = 2.0          # seconds a read of the process table serves (a pass's agents, a list's tasks)
_table = {"at": None, "children": {}}


def _read_table():
    """{parent pid: [child pid, …]} of every process now, all as strings."""
    children = {}
    if os.path.isdir("/proc/self"):
        for n in os.listdir("/proc"):
            if not n.isdigit():
                continue
            try:
                with open(f"/proc/{n}/stat", "rb") as f:
                    stat = f.read()
                # "pid (name) state ppid …": the name may hold spaces and brackets, so read after its last ")"
                ppid = stat[stat.rindex(b")") + 2:].split(None, 2)[1].decode()
            except (OSError, ValueError, IndexError):
                continue   # it ended while being read
            children.setdefault(ppid, []).append(n)
        return children
    for line in run(["ps", "-axo", "pid=,ppid="]).stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            children.setdefault(parts[1], []).append(parts[0])
    return children


def _ordered(children):
    """Each parent's children by pid, as pgrep -P gave them (two agents under one shell: the older first)."""
    for v in children.values():
        v.sort(key=int)
    return children


def process_children():
    """The process table's {parent: [children]}, read at most once per TABLE_FOR."""
    t = time.monotonic()
    if _table["at"] is None or t - _table["at"] > TABLE_FOR:
        _table["children"], _table["at"] = _ordered(_read_table()), t
    return _table["children"]


def kids(pid):
    """Every process under pid, from the shared process table, in the order the pgrep walk gave: each child, then
    everything under it, then its next sibling (session_of takes the first that names a session)."""
    children = process_children()
    out, todo, seen = [], [str(pid)], {str(pid)}
    while todo:
        p = todo.pop()
        if p != str(pid):
            out.append(p)
        fresh = [c for c in children.get(p, []) if c not in seen]
        seen.update(fresh)
        todo.extend(reversed(fresh))
    return out


OMP_UUID = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


def _proc_env(pid):
    """A process's environment as a dict, when this system keeps it (/proc): {} elsewhere."""
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            raw = f.read()
    except OSError:
        return {}
    out = {}
    for part in raw.split(b"\0"):
        if b"=" not in part:
            continue
        k, v = part.split(b"=", 1)
        out[k.decode("utf-8", "replace")] = v.decode("utf-8", "replace")
    return out


def omp_agent_dir(pid=None):
    """OMP's agent directory, from the process that runs it: PI_CODING_AGENT_DIR, else PI_CONFIG_DIR/agent,
    else ~/.omp/agent."""
    env = _proc_env(pid) if pid else os.environ
    a = env.get("PI_CODING_AGENT_DIR")
    if not a and env.get("PI_CONFIG_DIR"):
        a = os.path.join(env["PI_CONFIG_DIR"], "agent")
    return a or os.path.join(HOME, ".omp", "agent")


def _omp_terminal_ids(pid):
    """The names OMP may write its breadcrumb under: its tty (pts-3), or the terminal it runs in."""
    ids = []
    try:
        tty = os.readlink(f"/proc/{pid}/fd/0")
    except OSError:
        tty = ""
    if not tty:
        tty = run(["ps", "-o", "tty=", "-p", str(pid)]).stdout.strip()
    if tty:
        ids.append(tty[len("/dev/"):] if tty.startswith("/dev/") else tty)
    env = _proc_env(pid)
    for pre, key in (("tmux", "TMUX_PANE"), ("kitty", "KITTY_WINDOW_ID"), ("wezterm", "WEZTERM_PANE"),
                     ("zellij", "ZELLIJ_PANE_ID"), ("apple", "TERM_SESSION_ID"), ("wt", "WT_SESSION")):
        if env.get(key):
            ids.append(f"{pre}-{env[key]}")
    return [i.replace("/", "-") for i in ids if i]


def omp_session_of(pid):
    """(session id, log path) of OMP running as pid (or a child), as mods/chat/log.js finds it: the session
    file it holds open, else <agent dir>/terminal-sessions/<terminal id>'s second line."""
    for p in [str(pid)] + kids(pid):
        files = []
        fd = f"/proc/{p}/fd"
        if os.path.isdir(fd):
            for n in os.listdir(fd):
                try:
                    files.append(os.readlink(os.path.join(fd, n)))
                except OSError:
                    pass
        elif shutil.which("lsof"):
            files = [l[1:] for l in run(["lsof", "-p", p, "-Fn"]).stdout.split("\n") if l.startswith("n")]
        for f in files:
            m = OMP_UUID.search(f)
            if m and "/sessions/" in f:
                return m.group(1), f
        a = omp_agent_dir(p)
        for tid in _omp_terminal_ids(p):
            try:
                with open(os.path.join(a, "terminal-sessions", tid), errors="replace") as f:
                    lines = f.read().splitlines()
            except OSError:
                continue
            path = lines[1].strip() if len(lines) > 1 else ""
            if not path:
                continue
            m = OMP_UUID.search(path)
            if os.path.isfile(path):
                return (m.group(1) if m else None), path
            # The breadcrumb is written before the session's first turn: its file appears then.
            continue
    return None, None


def session_of(pid):
    """(session id, log path) of the agent process pid (or a child), as mods/chat/log.js finds it:
    Claude Code names its session in ~/.claude/sessions/<pid>.json; Codex holds its rollout open; OMP holds
    its session file open and writes a breadcrumb."""
    for p in [str(pid)] + kids(pid):
        j = os.path.join(HOME, ".claude", "sessions", p + ".json")
        if os.path.isfile(j):
            try:
                with open(j) as f:
                    sid = json.load(f).get("sessionId")
            except (OSError, ValueError):
                sid = None
            if sid:
                log = None
                base = os.path.join(HOME, ".claude", "projects")
                for d in os.listdir(base) if os.path.isdir(base) else []:
                    f = os.path.join(base, d, sid + ".jsonl")
                    if os.path.isfile(f):
                        log = f
                        break
                return sid, log
        files = []
        fd = f"/proc/{p}/fd"
        if os.path.isdir(fd):
            for n in os.listdir(fd):
                try:
                    files.append(os.readlink(os.path.join(fd, n)))
                except OSError:
                    pass
        elif shutil.which("lsof"):
            files = [l[1:] for l in run(["lsof", "-p", p, "-Fn"]).stdout.split("\n") if l.startswith("n")]
        for f in files:
            m = OMP_UUID.search(f)
            if m and "/sessions/" in f:
                return m.group(1), f
            m = re.search(r"/rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", f)
            if m:
                return m.group(1), f
    sid, log = omp_session_of(pid)
    if sid:
        return sid, log
    return None, None


def refresh_sessions(s, task, live):
    """Records each live agent's current session (it changes on /clear)."""
    for k in live:
        k = detail(k)
        pid = (k.get("foreground") or {}).get("pid")
        a = next((a for a in task["agents"] if a["address"] == k["address"]), None)
        if not pid or not a or not agent_running(k):
            continue
        sid, log = session_of(pid)
        if sid and (a.get("session"), a.get("log")) != (sid, log):
            a["session"], a["log"] = sid, log
            s.dirty = True


# ---- a lost agent's log (SHEP-26) -----------------------------------------------------------
# An agent that ended before a pass saw its session (a short run, or one that exited on its own)
# has no log on its task, so its chat would look as if it never started. Its log is still on this
# machine: found once by its session id, else as the Claude Code session or Codex rollout that
# started in its folder from its launch on and whose first message names its task.

LOOK_BACK_MS = 60000       # a log that starts this long before its agent's launch (clocks, a slow start) still counts


def _ms(stamp):
    """An ISO timestamp ("2026-11-05T08:30:43.116Z") in ms, or None."""
    import datetime
    try:
        return int(datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _words(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(x.get("text") or "") for x in content if isinstance(x, dict))
    return ""


def _start(path):
    """(when, first message) a log starts with: Claude Code's first user entry, Codex's session_meta
    and first user message. (None, "") if it has none in its first lines."""
    at, said = None, ""
    try:
        with open(path, errors="replace") as f:
            for i, line in enumerate(f):
                if i > 80:
                    break
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                p = o.get("payload") or {}
                if o.get("type") == "session_meta":
                    at = at or _ms(p.get("timestamp") or o.get("timestamp"))
                elif o.get("type") == "user" and not o.get("isMeta"):
                    at = at or _ms(o.get("timestamp"))
                    said = _words((o.get("message") or {}).get("content"))
                elif o.get("type") == "response_item" and p.get("role") == "user":
                    w = _words(p.get("content"))
                    if not w.lstrip().startswith("<"):  # not Codex's own <environment_context> or instructions
                        at, said = at or _ms(o.get("timestamp")), w
                elif o.get("type") == "session":
                    at = at or _ms(o.get("timestamp"))
                elif o.get("type") == "message" and (o.get("message") or {}).get("role") == "user":
                    w = _words((o.get("message") or {}).get("content"))
                    if w and not w.lstrip().startswith("<"):
                        at, said = at or _ms(o.get("timestamp")), w
                if said:
                    break
    except OSError:
        pass
    return at, said


def project_dir(folder):
    """Claude Code's projects folder for a cwd: every character but a letter or digit becomes "-"."""
    return os.path.join(HOME, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", folder))


def log_by_session(kind, sid):
    import glob
    if kind == "codex":
        found = glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", f"rollout-*{sid}.jsonl"))
    elif kind == "omp":
        found = glob.glob(os.path.join(omp_agent_dir(), "sessions", "*", f"*_{sid}.jsonl"))
    else:
        found = glob.glob(os.path.join(HOME, ".claude", "projects", "*", sid + ".jsonl"))
    return found[0] if found else None


def find_log(a, ref, folders, taken=()):
    """The log of agent `a` (a task's agents[] row) of task `ref` (SHEP-26), run in one of `folders`,
    or None: by its session when it has one, else the earliest log of its kind that started from
    its launch on (until it ended) and whose first message names its task."""
    import glob
    kind = a.get("agent") if a.get("agent") in ("codex", "omp") else "claude"
    if a.get("session"):
        return log_by_session(kind, a["session"])
    at = a.get("at")
    if not at:
        return None
    end = a.get("ended") or at + 86400000
    if kind == "codex":
        import datetime
        days = {datetime.date.fromtimestamp((at + d) / 1000) for d in (-86400000, 0, 86400000)}
        files = [f for day in days for f in glob.glob(os.path.join(HOME, ".codex", "sessions", f"{day:%Y}", f"{day:%m}", f"{day:%d}", "rollout-*.jsonl"))]
    elif kind == "omp":
        files = glob.glob(os.path.join(omp_agent_dir(), "sessions", "*", "*.jsonl"))
    else:
        files = [f for d in dict.fromkeys(x for x in folders if x) for f in glob.glob(os.path.join(project_dir(d), "*.jsonl"))]
    named = re.compile(rf"(?<![\w-]){re.escape(ref)}(?![\w-])")
    best = None
    for f in files:
        if f in taken:
            continue
        try:
            if os.path.getmtime(f) * 1000 < at - LOOK_BACK_MS:
                continue  # last written before it started
        except OSError:
            continue
        start, said = _start(f)
        if start is None or not (at - LOOK_BACK_MS <= start <= end) or not named.search(said):
            continue
        if not best or start < best[0]:
            best = (start, f)
    return best[1] if best else None


def find_lost_logs(s, task):
    """Records the log of each of the task's ended agents that has none (looked for once each)."""
    folders = [task.get("worktree"), s.loc.get("folder")]
    taken = {a.get("log") for a in task.get("agents") or [] if a.get("log")}
    for a in task.get("agents") or []:
        if a.get("log") or a.get("log_looked"):
            continue
        log = find_log(a, s.ref(task), folders + [a.get("cwd")], taken)
        a["log_looked"] = now()
        if log:
            a["log"] = log
            taken.add(log)
        s.dirty = True
