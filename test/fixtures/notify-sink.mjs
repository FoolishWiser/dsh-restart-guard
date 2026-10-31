/**
 * Notification sink for the command-channel test: appends whatever arrives on
 * stdin to the file named by argv[2].
 */
import fs from 'node:fs'

const target = process.argv[2]
const chunks = []
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  fs.appendFileSync(target, chunks.join('') + '\n---\n')
})
