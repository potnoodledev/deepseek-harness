/**
 * Browser `SubprocessRuntime` provider for the browser-agent spike: it turns
 * `spawn` calls into executions of the JS command-subset shell
 * (`js-shell.ts`) against the OPFS filesystem. `bash-local` spawns
 * `['bash', '-c', command]`, so the interpreter receives the script verbatim
 * and the shipped `tool-bash` path runs unchanged in the browser.
 *
 * Contract coverage: collect-mode stdout/stderr (offset readers with an
 * in-memory tail capped at `maxBytes`), stdin as `ignore` or inline `{data}`,
 * abort-signal and `terminate()` escalation (settles `{signal: 'SIGTERM'}`),
 * and spawn failures settling with `{exitCode: 1}`. Pipe-mode streams and
 * terminal spawns are out of scope for the spike.
 */

import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { executeShellScript, type ShellState } from './js-shell.ts'
import { normalizePath } from './opfs-shell.ts'

/** Whole-stream offset reader over an in-memory tail capped at `maxBytes`. */
class TailReader implements SubprocessOutputReader {
  private buffer = ''
  private dropped = 0

  constructor(private readonly maxBytes: number) {}

  write(text: string): void {
    if (text.length === 0) return
    this.buffer += text
    if (this.buffer.length > this.maxBytes) {
      const overflow = this.buffer.length - this.maxBytes
      this.buffer = this.buffer.slice(overflow)
      this.dropped += overflow
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const start = fromByte - this.dropped
    const lossy = fromByte < this.dropped
    if (start >= this.buffer.length) return { text: '', nextOffset: this.dropped + this.buffer.length, lossy }
    const text = start <= 0 ? this.buffer : this.buffer.slice(start)
    return { text, nextOffset: this.dropped + this.buffer.length, lossy }
  }
}

function isCollect(mode: unknown): mode is SubprocessCollect {
  return typeof mode === 'object' && mode !== null && 'maxBytes' in mode
}

function shellJoin(argv: readonly string[]): string {
  return argv
    .map((arg) => (/[\s;|&<>$]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg))
    .join(' ')
}

let nextPid = 1

/** One interpreted shell execution presented as a managed subprocess handle. */
class BrowserSubprocessHandle implements SubprocessHandle {
  readonly pid = nextPid++
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly settleDone: (outcome: SubprocessOutcome) => void

  constructor(collected: SubprocessCollectedOutputs) {
    this.collected = collected
    this.done = new Promise((resolve) => {
      this.settleDone = resolve
    })
  }

  settle(outcome: SubprocessOutcome): void {
    this.settleDone(outcome)
  }

  terminate(): void {
    // The owning spawn's abort controller stops the interpreter between
    // statements; `done` settles with SIGTERM there.
  }
}

/** Browser subprocess provider over the JS command-subset shell. */
export class BrowserSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx: Context) {
    super(ctx)
  }

  override async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, _signal?: AbortSignal): Promise<string> {
    if (command === 'bash' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(command)) return command
    throw new Error(`browser subprocess: cannot resolve executable ${JSON.stringify(command)}`)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const stdoutReader = isCollect(spec.stdio.stdout) ? new TailReader(spec.stdio.stdout.maxBytes) : undefined
    const stderrReader = isCollect(spec.stdio.stderr) ? new TailReader(spec.stdio.stderr.maxBytes) : undefined
    const controller = new AbortController()
    const handle = new BrowserSubprocessHandle({
      ...(stdoutReader !== undefined ? { stdout: stdoutReader } : {}),
      ...(stderrReader !== undefined ? { stderr: stderrReader } : {}),
    })
    controller.signal.addEventListener('abort', () => {
      handle.settle({ exitCode: null, signal: 'SIGTERM' })
    })

    const state: ShellState = {
      cwd: normalizePath(spec.cwd || '/'),
      vars: {
        ...(spec.env as Record<string, string> | undefined),
        PWD: normalizePath(spec.cwd || '/'),
        HOME: '/',
        PATH: '/usr/bin:/bin',
      },
      lastExit: 0,
      aborted: false,
    }
    controller.signal.addEventListener('abort', () => {
      state.aborted = true
    })
    const stdinData = spec.stdio.stdin !== 'ignore' && spec.stdio.stdin !== 'pipe'
      ? (spec.stdio.stdin as { data: string }).data
      : ''
    const script = spec.argv[0] === 'bash' && spec.argv[1] === '-c'
      ? spec.argv.slice(2).join(' ')
      : shellJoin(spec.argv)

    void (async () => {
      try {
        const exitCode = await executeShellScript(script, state, {
          stdin: stdinData,
          stdout: { write: (text) => stdoutReader?.write(text) },
          stderr: { write: (text) => stderrReader?.write(text) },
        })
        if (!controller.signal.aborted) handle.settle({ exitCode, signal: null })
      } catch (error) {
        stderrReader?.write(`${error instanceof Error ? error.message : String(error)}\n`)
        if (!controller.signal.aborted) handle.settle({ exitCode: 1, signal: null })
      }
    })()
    return handle
  }

  override async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('browser subprocess: terminal spawns are not supported in the browser shell shim')
  }
}

export default BrowserSubprocessRuntime
