// @ts-check
/**
 * A deliberately fragile plugin used by the repair demo.
 *
 * It refuses to activate while demo-config.json says enabled=false. That is the
 * whole point: DSH cannot boot, the crash is real, and the only fix is editing
 * this json file — exactly the kind of repair the guard asks the AI for.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-demo-broken'

export function apply() {
  /** @type {{ enabled?: boolean }} */
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(path.join(here, 'demo-config.json'), 'utf8'))
  } catch {
    config = {}
  }
  if (config.enabled !== true) {
    throw new Error('dsh-demo-broken: demo-config.json has enabled=false; set enabled to true')
  }
}
