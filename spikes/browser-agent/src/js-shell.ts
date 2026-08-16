/**
 * A pragmatic JS command-subset shell for the browser-agent spike: the
 * interpreter `bash-local`'s `bash -c <script>` spawns, executing against the
 * OPFS-backed helpers in `opfs-shell.ts`. This is the "JS POSIX command
 * subset" fidelity tier from the Agent Note — the smallest honest slice that
 * makes the shipped `tool-bash` path work in a browser.
 *
 * Supported: quotes and escapes, `;` `&&` `||` sequencing, `|` pipelines
 * (whole-output stages, no streaming), `>` `>>` `2>` `2>>` `<` redirection,
 * `$VAR`/`${VAR}`/`$?` expansion, leading `NAME=value` assignments, and the
 * built-ins `cd pwd echo printf cat ls mkdir rm touch cp mv head tail grep
 * sed wc find true false exit export`. Unsupported (documented gaps): globbing,
 * `$(...)`, `&` background, process substitution, control flow keywords
 * (`if`/`for`), and any streaming behavior.
 */

import {
  normalizePath,
  opfsAppendFile,
  opfsCopy,
  opfsExists,
  opfsListDir,
  opfsMakeDirs,
  opfsMove,
  opfsReadFile,
  opfsRemove,
  opfsStat,
  opfsWriteFile,
  resolvePath,
} from './opfs-shell.ts'

/** Mutable per-shell execution state. */
export interface ShellState {
  cwd: string
  vars: Record<string, string>
  lastExit: number
  aborted: boolean
}

/** Minimal synchronous text sink (collector or console). */
export interface ShellWriter {
  write(text: string): void
}

/** Per-statement input/output for the interpreter. */
export interface ShellIo {
  stdin: string
  stdout: ShellWriter
  stderr: ShellWriter
}

export type Operator = ';' | '&&' | '||' | '|' | '>' | '>>' | '2>' | '2>>' | '<'

interface Token {
  kind: 'word' | 'op'
  text?: string
  op?: Operator
}

function word(text: string): Token {
  return { kind: 'word', text }
}

function op(op: Operator): Token {
  return { kind: 'op', op }
}

const WORD_SEPARATORS = new Set([' ', '\t', '\n', '\r', ';', '|', '&', '<', '>'])

/** Tokenize a shell script, resolving quotes and escapes. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === ';') {
      tokens.push(op(';'))
      i += 1
      continue
    }
    if (ch === '|') {
      if (input[i + 1] === '|') {
        tokens.push(op('||'))
        i += 2
      } else {
        tokens.push(op('|'))
        i += 1
      }
      continue
    }
    if (ch === '&') {
      if (input[i + 1] === '&') {
        tokens.push(op('&&'))
        i += 2
        continue
      }
      throw new Error('browser shell: background `&` is not supported')
    }
    if (ch === '<') {
      tokens.push(op('<'))
      i += 1
      continue
    }
    if (ch === '>') {
      if (input[i + 1] === '>') {
        tokens.push(op('>>'))
        i += 2
      } else {
        tokens.push(op('>'))
        i += 1
      }
      continue
    }
    if (ch === '2' && input[i + 1] === '>') {
      if (input[i + 2] === '>') {
        tokens.push(op('2>>'))
        i += 3
      } else {
        tokens.push(op('2>'))
        i += 2
      }
      continue
    }
    let text = ''
    while (i < input.length && !WORD_SEPARATORS.has(input[i])) {
      const c = input[i]
      if (c === "'") {
        i += 1
        while (i < input.length && input[i] !== "'") {
          text += input[i]
          i += 1
        }
        i += 1
      } else if (c === '"') {
        i += 1
        while (i < input.length && input[i] !== '"') {
          const inner = input[i]
          if (inner === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\' || input[i + 1] === '$')) {
            text += input[i + 1]
            i += 2
          } else {
            text += inner
            i += 1
          }
        }
        i += 1
      } else if (c === '\\') {
        i += 1
        if (i < input.length) {
          text += input[i]
          i += 1
        }
      } else {
        text += c
        i += 1
      }
    }
    tokens.push(word(text))
  }
  return tokens
}

/** Expand `$VAR`, `${VAR}`, and `$?` in one word. */
function expand(text: string, state: ShellState): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|'\$\?'|\$\?/g, (_match, braced, bare) => {
    const name = braced ?? bare
    if (name === undefined) return String(state.lastExit)
    return state.vars[name] ?? ''
  })
}

interface Redirect {
  fd: 'stdout' | 'stderr'
  op: '>' | '>>'
  file: string
}

interface Stage {
  assignments: Array<[string, string]>
  redirects: Redirect[]
  stdinFile?: string
  argv: string[]
}

/** Parse one pipeline stage into assignments, redirects, and argv. */
function parseStage(tokens: Token[], state: ShellState): Stage {
  const stage: Stage = { assignments: [], redirects: [], argv: [] }
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.kind === 'op') {
      const fd = token.op === '2>' || token.op === '2>>' ? 'stderr' : 'stdout'
      const redirOp = token.op === '>>' || token.op === '2>>' ? '>>' : '>'
      const fileToken = tokens[i + 1]
      if (token.op === '<') {
        const file = fileToken?.kind === 'word' ? expand(fileToken.text, state) : undefined
        if (file !== undefined) stage.stdinFile = file
        i += 2
        continue
      }
      const file = fileToken?.kind === 'word' ? expand(fileToken.text, state) : ''
      stage.redirects.push({ fd, op: redirOp, file })
      i += 2
      continue
    }
    const text = expand(token.text ?? '', state)
    if (stage.argv.length === 0) {
      const assignment = text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (assignment !== null) {
        stage.assignments.push([assignment[1], assignment[2]])
        i += 1
        continue
      }
    }
    stage.argv.push(text)
    i += 1
  }
  return stage
}

function isStatementTerminator(token: Token): boolean {
  return token.kind === 'op' && (token.op === ';' || token.op === '&&' || token.op === '||')
}

/** Execute the full script. Returns the last command's exit code. */
export async function executeShellScript(script: string, state: ShellState, io: ShellIo): Promise<number> {
  const tokens = tokenize(script)
  let i = 0
  let pending: '&&' | '||' | undefined
  while (i < tokens.length) {
    let j = i
    while (j < tokens.length && !isStatementTerminator(tokens[j])) j += 1
    const terminator = j < tokens.length ? tokens[j].op : undefined
    const statementTokens = tokens.slice(i, j)
    i = j + (terminator === undefined ? 0 : 1)

    const shouldRun =
      pending === undefined
      || (pending === '&&' && state.lastExit === 0)
      || (pending === '||' && state.lastExit !== 0)

    if (shouldRun) {
      const code = await runStatement(statementTokens, state, io)
      if (code === undefined) return state.lastExit
      state.lastExit = code
    }
    pending = terminator === ';' || terminator === undefined ? undefined : terminator
  }
  return state.lastExit
}

async function runStatement(tokens: Token[], state: ShellState, io: ShellIo): Promise<number | undefined> {
  const stages: Token[][] = []
  let current: Token[] = []
  for (const token of tokens) {
    if (token.kind === 'op' && token.op === '|') {
      stages.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  stages.push(current)

  let pipedStdin = io.stdin
  let lastCode = 0
  for (let s = 0; s < stages.length; s += 1) {
    if (state.aborted) return 1
    const stage = parseStage(stages[s], state)
    for (const [name, value] of stage.assignments) state.vars[name] = value

    let stageStdin = pipedStdin
    if (stage.stdinFile !== undefined) {
      const content = await opfsReadFile(resolvePath(state.cwd, stage.stdinFile))
      stageStdin = content ?? ''
    }

    const out = { text: '' }
    const err = { text: '' }
    lastCode = await dispatch(stage.argv, state, {
      stdin: stageStdin,
      stdout: { write: (text) => { out.text += text } },
      stderr: { write: (text) => { err.text += text } },
    })

    const stdoutRedirect = stage.redirects.find((redirect) => redirect.fd === 'stdout')
    if (stdoutRedirect !== undefined) {
      await writeRedirect(stdoutRedirect, out.text, state)
    } else if (s < stages.length - 1) {
      pipedStdin = out.text
    } else {
      if (out.text.length > 0) io.stdout.write(out.text)
    }
    const stderrRedirect = stage.redirects.find((redirect) => redirect.fd === 'stderr')
    if (stderrRedirect !== undefined) {
      await writeRedirect(stderrRedirect, err.text, state)
    } else if (err.text.length > 0) {
      io.stderr.write(err.text)
    }
  }
  return lastCode
}

async function writeRedirect(redirect: Redirect, text: string, state: ShellState): Promise<void> {
  const abs = resolvePath(state.cwd, redirect.file)
  if (redirect.op === '>') await opfsWriteFile(abs, text)
  else await opfsAppendFile(abs, text)
}

type Builtin = (args: string[], state: ShellState, io: ShellIo) => Promise<number>

const BUILTINS: Record<string, Builtin> = {
  async cd(args, state) {
    const target = args[0] ?? state.vars.HOME ?? '/'
    const abs = resolvePath(state.cwd, target)
    const stat = await opfsStat(abs)
    if (stat === undefined || stat.kind !== 'directory') {
      state.vars.lastExit = 1
      return 1
    }
    state.cwd = normalizePath(abs)
    state.vars.PWD = state.cwd
    return 0
  },
  async pwd(_args, state, io) {
    io.stdout.write(`${state.cwd}\n`)
    return 0
  },
  async echo(args, state, io) {
    const newline = args[0] === '-n'
    const text = newline ? args.slice(1) : args
    io.stdout.write(`${text.join(' ')}${newline ? '' : '\n'}`)
    return 0
  },
  async printf(args, state, io) {
    if (args.length === 0) return 0
    const format = args[0]
    const values = args.slice(1)
    let out = ''
    let argIndex = 0
    for (let i = 0; i < format.length; i += 1) {
      if (format[i] === '%') {
        const spec = format[i + 1]
        if (spec === 's') {
          out += values[argIndex] ?? ''
          argIndex += 1
          i += 1
        } else if (spec === 'd') {
          out += String(Number(values[argIndex] ?? 0))
          argIndex += 1
          i += 1
        } else if (spec === '%') {
          out += '%'
          i += 1
        } else if (spec === '\\') {
          out += '\n'
          i += 1
        } else if (spec === 'n') {
          out += '\n'
          i += 1
        } else {
          out += format[i]
        }
      } else {
        out += format[i]
      }
    }
    io.stdout.write(out)
    return 0
  },
  async cat(args, state, io) {
    const files = args.length === 0 ? ['-'] : args
    for (const file of files) {
      if (file === '-') {
        io.stdout.write(io.stdin)
        continue
      }
      const content = await opfsReadFile(resolvePath(state.cwd, file))
      if (content === undefined) {
        io.stderr.write(`cat: ${file}: No such file or directory\n`)
        return 1
      }
      io.stdout.write(content)
    }
    return 0
  },
  async ls(args, state, io) {
    let showAll = false
    let long = false
    const targets: string[] = []
    for (const arg of args) {
      if (arg === '-a' || arg === '-la' || arg === '-al') {
        showAll = true
        if (arg.length > 2) long = true
      } else if (arg === '-l') {
        long = true
      } else if (arg.startsWith('-')) {
        io.stderr.write(`ls: invalid option -- '${arg}'\n`)
        return 2
      } else {
        targets.push(arg)
      }
    }
    const dirs = targets.length === 0 ? ['.'] : targets
    let failed = 0
    for (const dir of dirs) {
      const abs = resolvePath(state.cwd, dir)
      const stat = await opfsStat(abs)
      if (stat === undefined) {
        io.stderr.write(`ls: ${dir}: No such file or directory\n`)
        failed = 1
        continue
      }
      if (stat.kind === 'file') {
        io.stdout.write(`${long ? '-rw-r--r-- 1 0 0 0 ' : ''}${dir.split('/').pop()}\n`)
        continue
      }
      const entries = (await opfsListDir(abs)) ?? []
      for (const entry of entries) {
        if (!showAll && entry.name.startsWith('.')) continue
        if (long) {
          const size = entry.kind === 'file' ? (await opfsStat(`${abs}/${entry.name}`))?.size ?? 0 : 0
          const perms = entry.kind === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--'
          io.stdout.write(`${perms} 1 0 0 ${String(size).padStart(8)} ${entry.name}\n`)
        } else {
          io.stdout.write(`${entry.name}\n`)
        }
      }
    }
    return failed
  },
  async mkdir(args, state, io) {
    let parents = false
    const targets: string[] = []
    for (const arg of args) {
      if (arg === '-p') parents = true
      else if (arg.startsWith('-')) {
        io.stderr.write(`mkdir: invalid option -- '${arg}'\n`)
        return 2
      } else targets.push(arg)
    }
    for (const target of targets) {
      const abs = resolvePath(state.cwd, target)
      const stat = await opfsStat(abs)
      if (stat !== undefined && stat.kind === 'directory') continue
      if (!parents) {
        const parent = abs.slice(0, abs.lastIndexOf('/')) || '/'
        if (!(await opfsExists(parent))) {
          io.stderr.write(`mkdir: cannot create directory '${target}': No such file or directory\n`)
          return 1
        }
      }
      await opfsMakeDirs(abs)
    }
    return 0
  },
  async rm(args, state, io) {
    let recursive = false
    let force = false
    const targets: string[] = []
    for (const arg of args) {
      if (arg === '-r' || arg === '-rf' || arg === '-fr') {
        recursive = true
        if (arg.includes('f')) force = true
      } else if (arg === '-f') force = true
      else targets.push(arg)
    }
    for (const target of targets) {
      const abs = resolvePath(state.cwd, target)
      const stat = await opfsStat(abs)
      if (stat === undefined) {
        if (!force) io.stderr.write(`rm: cannot remove '${target}': No such file or directory\n`)
        continue
      }
      if (stat.kind === 'directory' && !recursive) {
        io.stderr.write(`rm: cannot remove '${target}': Is a directory\n`)
        return 1
      }
      await opfsRemove(abs, recursive)
    }
    return 0
  },
  async touch(args, state, io) {
    for (const target of args) {
      const abs = resolvePath(state.cwd, target)
      if (!(await opfsExists(abs))) {
        const written = await opfsWriteFile(abs, '')
        if (!written) io.stderr.write(`touch: cannot touch '${target}': Not a directory\n`)
      }
    }
    return 0
  },
  async cp(args, state, io) {
    let recursive = false
    const paths: string[] = []
    for (const arg of args) {
      if (arg === '-r' || arg === '-R') recursive = true
      else paths.push(arg)
    }
    if (paths.length < 2) {
      io.stderr.write('cp: missing destination file operand\n')
      return 1
    }
    const src = resolvePath(state.cwd, paths[0])
    const dst = resolvePath(state.cwd, paths[paths.length - 1])
    const ok = await opfsCopy(src, dst, recursive)
    if (!ok) {
      io.stderr.write(`cp: cannot stat '${paths[0]}': No such file or directory\n`)
      return 1
    }
    return 0
  },
  async mv(args, state, io) {
    if (args.length < 2) {
      io.stderr.write('mv: missing destination file operand\n')
      return 1
    }
    const src = resolvePath(state.cwd, args[0])
    const dst = resolvePath(state.cwd, args[args.length - 1])
    const ok = await opfsMove(src, dst)
    if (!ok) {
      io.stderr.write(`mv: cannot stat '${args[0]}': No such file or directory\n`)
      return 1
    }
    return 0
  },
  async head(args, state, io) {
    let lines = 10
    const files: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '-n' && i + 1 < args.length) {
        lines = Number(args[i + 1])
        i += 1
      } else if (/^-\d+$/.test(arg)) {
        lines = Number(arg.slice(1))
      } else {
        files.push(arg)
      }
    }
    const input = files.length === 0
      ? [{ text: io.stdin }]
      : await Promise.all(files.map(async (file) => ({ text: file === '-' ? io.stdin : (await opfsReadFile(resolvePath(state.cwd, file))) ?? '' })))
    const text = input.map((entry) => entry.text).join('')
    const kept = text.split('\n').slice(0, Math.max(0, lines)).join('\n')
    io.stdout.write(`${kept}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}`)
    return 0
  },
  async tail(args, state, io) {
    let lines = 10
    const files: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-n' && i + 1 < args.length) {
        lines = Number(args[i + 1])
        i += 1
      } else {
        files.push(args[i])
      }
    }
    const texts: string[] = []
    for (const file of files.length === 0 ? ['-'] : files) {
      if (file === '-') texts.push(io.stdin)
      else texts.push((await opfsReadFile(resolvePath(state.cwd, file))) ?? '')
    }
    const text = texts.join('')
    const parts = text.split('\n')
    io.stdout.write(parts.slice(Math.max(0, parts.length - lines)).join('\n'))
    if (parts.length > 1 || text.endsWith('\n')) io.stdout.write('\n')
    return 0
  },
  async grep(args, state, io) {
    let insensitive = false
    let pattern = ''
    const files: string[] = []
    for (const arg of args) {
      if (arg === '-i') insensitive = true
      else if (pattern === '') pattern = arg
      else files.push(arg)
    }
    if (pattern === '') {
      io.stderr.write('grep: missing pattern\n')
      return 2
    }
    const input = files.length === 0
      ? [{ name: '(standard input)', text: io.stdin }]
      : await Promise.all(files.map(async (file) => ({ name: file, text: (await opfsReadFile(resolvePath(state.cwd, file))) ?? '' })))
    const regex = new RegExp(pattern, insensitive ? 'i' : '')
    let matched = 0
    for (const { name, text } of input) {
      const lines = text.split('\n')
      for (const line of lines) {
        if (regex.test(line)) {
          io.stdout.write(files.length > 1 ? `${name}:${line}\n` : `${line}\n`)
          matched += 1
        }
      }
    }
    return matched > 0 ? 0 : 1
  },
  async sed(args, state, io) {
    if (args.length === 0) {
      io.stderr.write('sed: missing expression\n')
      return 2
    }
    const expression = args[0]
    const files = args.slice(1)
    const match = expression.match(/^s\/(.*)\/(.*)\/([gIn]*)$/s)
    if (match === null) {
      io.stderr.write(`sed: unsupported expression '${expression}' (only s/// supported)\n`)
      return 1
    }
    const [, from, to, flags] = match
    const global = flags?.includes('g') ?? false
    const insensitive = flags?.includes('I') ?? false
    const inputs = files.length === 0
      ? [{ text: io.stdin }]
      : await Promise.all(files.map(async (file) => ({ text: (await opfsReadFile(resolvePath(state.cwd, file))) ?? '' })))
    const regex = new RegExp(from, `${global ? 'g' : ''}${insensitive ? 'i' : ''}`)
    for (const { text } of inputs) {
      io.stdout.write(text.replace(regex, to))
    }
    return 0
  },
  async wc(args, state, io) {
    let countLines = false
    let countWords = false
    let countChars = false
    const files: string[] = []
    for (const arg of args) {
      if (arg === '-l') countLines = true
      else if (arg === '-w') countWords = true
      else if (arg === '-c') countChars = true
      else files.push(arg)
    }
    const defaults = !countLines && !countWords && !countChars
    const inputs = files.length === 0
      ? [{ name: '', text: io.stdin }]
      : await Promise.all(files.map(async (file) => ({ name: file, text: (await opfsReadFile(resolvePath(state.cwd, file))) ?? '' })))
    const parts: string[] = []
    for (const { name, text } of inputs) {
      const values: number[] = []
      const lineCount = text === '' ? 0 : text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
      if (defaults || countLines) values.push(lineCount)
      if (defaults || countWords) values.push(text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length)
      if (defaults || countChars) values.push(new TextEncoder().encode(text).length)
      parts.push(`${values.map((value) => String(value).padStart(7)).join(' ')}${name.length > 0 ? ` ${name}` : ''}`)
    }
    io.stdout.write(`${parts.join('\n')}${parts.length > 0 ? '\n' : ''}`)
    return 0
  },
  async find(args, state, io) {
    const rootDir = args.find((arg) => !arg.startsWith('-')) ?? '.'
    let namePattern: string | undefined
    let type: string | undefined
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-name' && i + 1 < args.length) namePattern = args[i + 1]
      if (args[i] === '-type' && i + 1 < args.length) type = args[i + 1]
    }
    const absRoot = resolvePath(state.cwd, rootDir)
    const results: string[] = []
    const visit = async (abs: string, rel: string): Promise<void> => {
      const stat = await opfsStat(abs)
      if (stat === undefined) return
      const matched = namePattern === undefined || wildcardMatch(namePattern, rel.split('/').pop() ?? rel)
      const typeMatched = type === undefined || (type === 'd' ? stat.kind === 'directory' : stat.kind === 'file')
      if (matched && typeMatched) results.push(rel === '' ? '.' : rel)
      if (stat.kind === 'directory') {
        for (const entry of (await opfsListDir(abs)) ?? []) {
          await visit(`${abs}/${entry.name}`, rel === '' ? entry.name : `${rel}/${entry.name}`)
        }
      }
    }
    await visit(absRoot, '')
    for (const result of results) io.stdout.write(`${result}\n`)
    return 0
  },
  async true() {
    return 0
  },
  async false() {
    return 1
  },
  async exit(args) {
    return Number(args[0] ?? 0)
  },
  async export(args, state) {
    for (const arg of args) {
      const assignment = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (assignment !== null) state.vars[assignment[1]] = assignment[2]
    }
    return 0
  },
}

function wildcardMatch(pattern: string, name: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return regex.test(name)
}

async function dispatch(argv: string[], state: ShellState, io: ShellIo): Promise<number> {
  if (argv.length === 0) return 0
  const name = argv[0]
  const builtin = BUILTINS[name]
  if (builtin !== undefined) return builtin(argv.slice(1), state, io)
  io.stderr.write(`bash: ${name}: command not found\n`)
  return 127
}
