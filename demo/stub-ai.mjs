// @ts-check
/**
 * Offline stand-in for an AI channel: reads the repair prompt on stdin and
 * answers with the edit that fixes the demo plugin. Used by demo/run.sh so the
 * scenario is deterministic and needs no API key.
 *
 * The guard still performs the edit itself — this script only *decides*.
 */
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
const directory = /^- directory:\s*(.+)$/m.exec(prompt)?.[1]?.trim() ?? ''
const verdict = directory
  ? {
      action: 'fix-plugin',
      edits: [{ file: 'demo-config.json', content: '{\n  "enabled": true\n}\n' }],
      reason: 'demo-config.json has enabled=false, which makes dsh-demo-broken throw during activation',
      hint: 'the file is now enabled=true; keep it that way unless you want to replay the demo',
      confidence: 0.99,
    }
  : {
      action: 'manual',
      reason: 'the prompt did not carry a plugin directory',
      hint: 'run demo/run.sh so the failing plugin resolves',
      confidence: 0.2,
    }
process.stdout.write(`VERDICT ${JSON.stringify(verdict)}\n`)
