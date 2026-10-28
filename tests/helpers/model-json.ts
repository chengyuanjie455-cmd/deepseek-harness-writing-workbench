/** Request chunks may split a Chinese character or emoji. Decode only after
 * joining the bytes, so a fixture cannot invent conversation corruption. */
export async function readModelJSON(stream:AsyncIterable<Uint8Array>){
 const chunks:Buffer[]=[];
 for await(const part of stream)chunks.push(Buffer.from(part));
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
