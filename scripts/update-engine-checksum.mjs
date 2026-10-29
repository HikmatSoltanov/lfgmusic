import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const hash = createHash('sha256');
for await (const bytes of createReadStream('audio-engine/target/music-engine.jar')) hash.update(bytes);
await writeFile('audio-engine/runtime.json', JSON.stringify({ sha256: hash.digest('hex'), sourceVersion: '1.0.0', sourceLibraries: { lavaplayer: '2.2.1', 'youtube-source': '1.5.2' } }, null, 2) + '\n');
console.log('Recorded checksum of the successfully built local audio-engine artifact.');
