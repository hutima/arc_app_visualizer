/**
 * worker_threads entry point. The heavy pipeline lives in importFiles.ts so
 * tests can run it directly; this wrapper only relays progress messages to
 * the main process.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runImport } from './importFiles'
import type { CleaningConfig } from './clean'
import type { OverwriteWindow } from '../../shared/types'

interface WorkerInput {
  dbPath: string
  paths: string[]
  cleaning: CleaningConfig
  overwrite?: OverwriteWindow[]
}

const input = workerData as WorkerInput
const port = parentPort
if (!port) throw new Error('importWorker must run as a worker thread')

runImport({
  dbPath: input.dbPath,
  paths: input.paths,
  cleaning: input.cleaning,
  overwrite: input.overwrite,
  onProgress: (p) => port.postMessage(p)
}).catch((err: unknown) => {
  port.postMessage({
    kind: 'error',
    error: err instanceof Error ? err.message : String(err)
  })
})
