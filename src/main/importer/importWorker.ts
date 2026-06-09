/**
 * worker_threads entry point. The heavy pipeline lives in importFiles.ts so
 * tests can run it directly; this wrapper only relays progress messages to
 * the main process.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runImport } from './importFiles'
import type { CleaningConfig } from './clean'

interface WorkerInput {
  dbPath: string
  paths: string[]
  cleaning: CleaningConfig
}

const input = workerData as WorkerInput
const port = parentPort
if (!port) throw new Error('importWorker must run as a worker thread')

runImport({
  dbPath: input.dbPath,
  paths: input.paths,
  cleaning: input.cleaning,
  onProgress: (p) => port.postMessage(p)
}).catch((err: unknown) => {
  port.postMessage({
    kind: 'error',
    error: err instanceof Error ? err.message : String(err)
  })
})
