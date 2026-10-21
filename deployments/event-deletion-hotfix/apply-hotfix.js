'use strict';

// Never commit a downloaded production bundle here. This recipe changes only
// the deletion branch and embeds its dependency-free implementation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const deleteEventSafely = require('./delete-event');

const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i]] = process.argv[i + 1];
const input = path.resolve(options['--source'] || '');
const output = path.resolve(options['--output'] || '');
const expected = options['--expected-sha256'];
if (!options['--source'] || !options['--output'] || !expected || input === output) {
  throw new Error('Use --source <downloaded-index.js> --output <private/manageApplications/index.js> --expected-sha256 <baseline>');
}
if (path.basename(path.dirname(output)) !== 'manageApplications' || path.basename(output) !== 'index.js') {
  throw new Error('The output must be a single index.js inside a manageApplications folder.');
}
const source = fs.readFileSync(input, 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
if (hash(source) !== expected) throw new Error('Production baseline differs from the reviewed SHA-256.');
const startMarker = '  // DELETE EVENT\n';
const endMarker = '  // UNCHECK GUEST\n';
const entryMarker = 'exports.main = async (event, context) => {';
const helperMarker = '// Compatible event-deletion hotfix: no auth, environment or payment changes.\n';
const count = token => source.split(token).length - 1;
if (count(startMarker) !== 1 || count(endMarker) !== 1 || count(entryMarker) !== 1 || source.includes(helperMarker)) {
  throw new Error('Unexpected production source structure; refusing a blind replacement.');
}
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (end <= start) throw new Error('Deletion block boundaries are invalid.');
const oldBlock = source.slice(start, end);
if (!oldBlock.includes("if (action === 'deleteEvent')")) throw new Error('The selected block is not the delete action.');
const newBlock = startMarker + "  if (action === 'deleteEvent') {\n    return deleteEventSafely(db, eventId || id, context);\n  }\n\n";
const helper = helperMarker + deleteEventSafely.toString() + '\n\n';
const outputSource = (source.slice(0, start) + newBlock + source.slice(end)).replace(entryMarker, helper + entryMarker);
// Scope assertion, not a business/runtime test: undoing the two authorized
// replacements must recover every original byte, including auth/config.
const restored = outputSource.replace(helper + entryMarker, entryMarker).replace(newBlock, oldBlock);
if (restored !== source) throw new Error('Code outside the allowed deletion patch would change.');
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, outputSource, { mode: 0o600 });
console.log(JSON.stringify({ sourceSha256: expected, outputSha256: hash(outputSource), output,
  scope: 'deleteEvent branch and its private helper only',
  unrelatedCodePreservedByteForByte: true }, null, 2));
