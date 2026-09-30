# lpm2

**PM2, minus the Windows named-pipe collision.**

On Windows, PM2 hardcodes its daemon transport for every user, every
`PM2_HOME` and every project:

```js
// pm2/paths.js
if (process.platform === 'win32') {
  //@todo instead of static unique rpc/pub file custom with PM2_HOME or UID
  pm2_file_stucture.DAEMON_RPC_PORT = '\\\\.\\pipe\\rpc.sock';
  pm2_file_stucture.DAEMON_PUB_PORT = '\\\\.\\pipe\\pub.sock';
}
```

One global name means one daemon per machine. If a daemon is already holding
`\\.\pipe\rpc.sock` — left behind by another account, another session, or a
crashed run — every later `pm2` command breaks:

```
connect EPERM \\.\pipe\rpc.sock
[PM2] Spawning PM2 daemon with pm2_home=C:\Users\lyln\.pm2
Error: connect EPERM \\.\pipe\rpc.sock
    at PipeConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)
Emitted 'error' event on ReqSocket instance
```

That last line is why PM2 dies rather than reporting the problem. The error
code `EPERM` isn't in PM2's internal list of ignorable socket errors
(`ECONNREFUSED`, `ENOENT`, …), so the failure is re-emitted as an unhandled
`'error'` event and takes the CLI down with it.

There is a second failure mode, and it is quieter. When the held pipe is
reachable — a daemon owned by the same user, perhaps from a different project —
`pm2` connects to it instead of failing, and then reports *that* project's
processes:

```
$ pm2 list            # in project B
│ id │ name        │ status  │ ... │
│ 0  │ TRSS-Yunzai │ stopped │ ... │     <- a process from project A
```

Run from project B with project B's `PM2_HOME`, this lists project A's app.
`pm2 restart all` or `pm2 delete all` in that state operates on the wrong
project's processes, with no warning. Observed directly on a machine running
two Yunzai checkouts.

lpm2 gives each `PM2_HOME` its own transport namespace, restoring the
per-instance isolation PM2 already has on Linux and macOS, where sockets live
inside `PM2_HOME`. Under lpm2 the same `list` above correctly shows nothing
for a fresh `PM2_HOME`, because it cannot see another home's daemon.

## Install

```sh
npm install -g @lyln/lpm2
```

The package is scoped, but the command is not — you still run `lpm2`.
(npm rejects the bare name `lpm2` as too similar to `pm2`.)

`pm2` is declared as a peer dependency, so npm 7+ installs it automatically.
Naming it explicitly is safer for global installs, where peer auto-install is
less reliable:

```sh
npm install -g @lyln/lpm2 pm2
```

`pm2` stays the engine; lpm2 is the launcher and the fix.

## Use

Identical to pm2 — every argument is forwarded:

```sh
lpm2 start app.js
lpm2 start ./config/pm2/pm2.json
lpm2 list
lpm2 logs
lpm2 restart all
lpm2 kill
```

Check what it resolved:

```sh
lpm2 doctor
```

```
lpm2 diagnostics
  pm2             : 7.0.4 (/path/to/pm2/package.json)
  PM2_HOME        : /home/me/.pm2
  namespace       : 77698a9ecb54
  transport (lpm2):
    rpc        : \\.\pipe\lpm2-77698a9ecb54-rpc.sock
    pub        : \\.\pipe\lpm2-77698a9ecb54-pub.sock
  transport (stock pm2, global/shared):
    rpc        : \\.\pipe\rpc.sock
```

## How it works

The CLI re-invokes your project's pm2 with a preload installed through
`NODE_OPTIONS`:

```
NODE_OPTIONS="--require <lpm2>/src/preload.cjs"
```

The preload intercepts `Module._load` and rewrites `pm2/constants.js` before
pm2 reads it. pm2 builds its paths once and merges them into a plain mutable
object, and both the CLI (`new Client()`) and the daemon (`Daemon`) read the
ports off that object — so reassigning the properties moves the whole daemon.

Because pm2 spawns the God Daemon with the CLI's environment, the daemon
inherits the same preload and lands on the same pipes. This fixes the
collision rather than working around it.

Two details worth knowing:

- **No hardcoded pm2 path.** The patch matches pm2's constants module by
  resolved path shape, so it works with a global install, a local install, a
  pnpm content-addressed store, or a monorepo.
- **PID-derived names are not used.** The namespace comes from `PM2_HOME`, so
  a CLI invocation and the daemon it spawns agree on it. A per-process name
  would have them each bind a different pipe.

On Linux and macOS the patch does nothing: those platforms already place
sockets inside `PM2_HOME`, so `lpm2` is safe to use everywhere.

## Configuration

| Variable | Effect |
| --- | --- |
| `PM2_HOME` | Daemon home (default `~/.pm2`). Determines the namespace. |
| `LPM2_HOME` | Overrides `PM2_HOME` for lpm2 only. |
| `LPM2_NS` | Forces an explicit namespace instead of hashing the home. |
| `LPM2_DEBUG` | Prints patch decisions to stderr. |

Two separate projects with separate `PM2_HOME` values are fully isolated. To
run two daemons off one home:

```sh
LPM2_NS=project-a lpm2 start app.js
LPM2_NS=project-b lpm2 start app.js
```

## When to reach for this

Use it if you have hit `connect EPERM \\.\pipe\rpc.sock`, or if you run
several PM2 setups on one Windows machine, or if PM2 daemons are started by
more than one user account. It is a targeted fix for a specific defect, not a
general-purpose replacement for PM2.

## Stability

This patches PM2's internals, so it depends on pm2 continuing to build its
transport paths in `paths.js` and export them from `constants.js`. That
structure has held across PM2 5 and 6 and 7. The integration test asserts
against real pm2, so a future PM2 release that changes the shape will fail
loudly rather than silently reverting to the broken behavior.

If a PM2 upgrade ever makes lpm2 unnecessary, remove it — nothing else
depends on it.

## License

MIT
